import {
  readUpstreamQueryCache,
  writeUpstreamQueryCache,
} from "./upstreamQueryCache.js";
import {
  buildBidWarmQueries,
  buildPrespecWarmQuery,
  buildBizinfoWarmQuery,
  buildEventsWarmQuery,
  buildMssWarmBoards,
  MAX_BID_WARM_PAGES,
  MAX_PRESPEC_WARM_PAGES,
  MAX_BIZINFO_WARM_PAGES,
  MAX_EVENTS_WARM_PAGES,
} from "./cacheWarmParams.js";
import {
  extractBidListMeta,
  extractSupplementaryListMeta,
  extractBizinfoListMeta,
} from "./cacheWarmParse.js";
import {
  extractBidRows,
  extractSupplementaryRows,
  extractBizinfoRows,
  bidRowKey,
  slimBidRowForSnapshot,
  slimSupplementaryRowForSnapshot,
} from "./tabSyncExtract.js";
import { TAB_SNAPSHOT_TARGETS } from "./tabSyncKeys.js";
import { upsertTabSnapshot, markTabSnapshotSyncError, getTabSnapshot } from "./tabSyncStore.js";
import { isMongoConfigured } from "./mongo.js";
import { parseUpstreamPayload } from "./upstreamPayloadParse.js";
import { startTabSyncKeepAlive } from "./tabSyncKeepAlive.js";
import { isNaraParallelTab } from "./tabSyncParallel.js";
import { emptySyncFailureReason } from "./tabSyncGuard.js";
import { withTabSyncLock, isTabSyncRunning } from "./tabSyncLock.js";
import {
  createTabSyncProgressLog,
  logTabSyncRunHeader,
  logTabSyncRunFooter,
} from "./tabSyncProgressLog.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 장문 탭 — 매 N 페이지마다 추가 마일스톤 로그 */
const PAGE_LOG_EVERY = 10;

function tabSnapshotExtras(target, meta = {}) {
  return {
    uiTab: target.uiTab,
    label: target.label,
    source: target.source,
    meta,
  };
}

async function recordTabSyncFailure(target, error, meta = {}) {
  await markTabSnapshotSyncError(target.tabKey, error, tabSnapshotExtras(target, meta));
}

/** 빈 결과로 기존 MongoDB rows 를 덮어쓰지 않음 */
async function saveTabSnapshotSafe(target, payload, log, opts = {}) {
  const rowCount = Array.isArray(payload.rows) ? payload.rows.length : 0;
  let failReason = emptySyncFailureReason(rowCount, payload.totalCount, opts);

  if (!failReason && rowCount === 0) {
    const prev = await getTabSnapshot(target.tabKey);
    if ((prev?.rowCount ?? 0) > 0) {
      failReason = `empty_sync_would_wipe_${prev.rowCount}_rows`;
    }
  }

  if (failReason) {
    log.fail(failReason);
    await recordTabSyncFailure(target, failReason, payload.meta ?? {});
    return { tabKey: target.tabKey, ok: false, error: failReason, rowCount: 0 };
  }
  try {
    await upsertTabSnapshot(target.tabKey, {
      uiTab: target.uiTab,
      label: target.label,
      source: target.source,
      ...payload,
      syncError: null,
    });
  } catch (e) {
    const err = e?.message || "mongodb_save_failed";
    log.fail(err);
    await recordTabSyncFailure(target, err, payload.meta ?? {});
    return { tabKey: target.tabKey, ok: false, error: err, rowCount: 0 };
  }
  log.saved(rowCount, {
    truncated: payload.truncated,
    totalCount: payload.totalCount,
    pages: payload.meta?.pages,
  });
  return {
    tabKey: target.tabKey,
    ok: true,
    rowCount,
    truncated: payload.truncated,
  };
}

/**
 * @param {{ serviceKey: string, fetchBid: Function, fetchPrespec: Function, fetchBizinfoSupport?: Function, fetchBizinfoEvents?: Function, warmMssBoard?: Function }} deps
 * @param {{ force?: boolean, syncSlot?: string }} opts
 */
export async function runTabSync(deps, { force = true, syncSlot = "scheduled" } = {}) {
  const results = [];

  if (!isMongoConfigured()) {
    return {
      ok: false,
      at: new Date().toISOString(),
      force,
      syncSlot,
      error: "mongodb_not_configured",
      results,
    };
  }

  if (!deps.serviceKey) {
    return {
      ok: false,
      at: new Date().toISOString(),
      force,
      syncSlot,
      error: "missing_service_key",
      results,
    };
  }

  async function fetchUpstream(namespace, operation, query, fetchFn) {
    const probe = readUpstreamQueryCache(namespace, operation, query);
    if (!force && probe.hit) {
      const parsed = parseUpstreamPayload(probe.data);
      return {
        ok: !parsed.error,
        data: parsed.payload,
        parseError: parsed.error,
        cache: "hit",
      };
    }
    const upstream = await fetchFn(operation, query);
    const parsed = parseUpstreamPayload(upstream.data);
    const httpOk = upstream.status < 400;
    const ok = httpOk && !parsed.error;
    if (probe.cacheKey && httpOk) {
      writeUpstreamQueryCache(probe.cacheKey, upstream);
    }
    return {
      ok,
      data: parsed.payload,
      parseError: parsed.error,
      cache: force ? "refreshed" : "filled",
      status: upstream.status,
    };
  }

  async function syncBidTab(target) {
    const log = createTabSyncProgressLog(target);

    const item = buildBidWarmQueries().find((q) => q.label === `bid:${target.naraBiz}`);
    if (!item) {
      log.fail("warm_query_missing");
      return { tabKey: target.tabKey, ok: false, error: "warm_query_missing" };
    }

    const pageSize = Number(item.query.numOfRows) || 50;
    log.start(`나라장터 입찰 · ${pageSize}건/회`);

    const merged = new Map();
    let totalCount = null;
    let truncated = false;

    const q1 = { ...item.query, pageNo: "1" };
    let first = await fetchUpstream(item.namespace, item.operation, q1, deps.fetchBid);
    let p1 = first.ok ? extractBidRows(first.data) : { rows: [], totalCount: null };

    if (first.ok && p1.rows.length === 0 && p1.totalCount == null) {
      for (let retry = 1; retry <= 2; retry++) {
        log.fail(`1페이지 빈 응답 — ${retry}/2 재시도`);
        await sleep(800 * retry);
        first = await fetchUpstream(item.namespace, item.operation, q1, deps.fetchBid);
        if (!first.ok) break;
        p1 = extractBidRows(first.data);
        if (p1.rows.length > 0 || p1.totalCount != null) break;
      }
    }

    if (!first.ok) {
      const err = first.parseError || `upstream_${first.status ?? "fail"}`;
      log.fail(err);
      await recordTabSyncFailure(target, err, {
        naraBiz: target.naraBiz,
        operation: item.operation,
      });
      return { tabKey: target.tabKey, ok: false, error: err };
    }

    totalCount = p1.totalCount;
    for (const row of p1.rows) merged.set(bidRowKey(row), row);

    const meta = extractBidListMeta(first.data, pageSize);
    const totalPages = Math.min(meta.totalPages ?? 1, MAX_BID_WARM_PAGES);
    truncated = totalCount != null && totalPages < Math.ceil(totalCount / pageSize);
    log.page(1, totalPages, p1.rows.length, merged.size, totalCount);

    for (let p = 2; p <= totalPages; p++) {
      const q = { ...item.query, pageNo: String(p) };
      const page = await fetchUpstream(item.namespace, item.operation, q, deps.fetchBid);
      if (!page.ok) {
        log.fail(`p.${p} upstream 중단`);
        break;
      }
      const batch = extractBidRows(page.data).rows;
      for (const row of batch) merged.set(bidRowKey(row), row);
      log.page(p, totalPages, batch.length, merged.size, totalCount);
      if (p % PAGE_LOG_EVERY === 0) log.milestone(p, totalPages, merged.size);
      await sleep(350);
    }

    const rows = [...merged.values()]
      .map(slimBidRowForSnapshot)
      .filter(Boolean);
    return saveTabSnapshotSafe(
      target,
      {
        rows,
        truncated,
        totalCount,
        meta: { naraBiz: target.naraBiz, operation: item.operation, pages: totalPages },
      },
      log
    );
  }

  async function syncPrespecTab(target) {
    const log = createTabSyncProgressLog(target);
    const prespec = buildPrespecWarmQuery();
    const pageSize = Number(prespec.query.numOfRows) || 20;
    log.start(`사전규격 · ${pageSize}건/회`);
    const merged = [];
    let totalCount = null;
    let truncated = false;

    const q1 = { ...prespec.query, pageNo: "1" };
    const first = await fetchUpstream("prespec", prespec.operation, q1, deps.fetchPrespec);
    if (!first.ok) {
      const err = first.parseError || "upstream_fail";
      log.fail(err);
      await recordTabSyncFailure(target, err, { operation: prespec.operation });
      return { tabKey: target.tabKey, ok: false, error: err };
    }

    const p1 = extractSupplementaryRows(first.data);
    totalCount = p1.totalCount;
    merged.push(...p1.rows);

    const meta = extractSupplementaryListMeta(first.data, pageSize);
    const totalPages = Math.min(meta.totalPages ?? 1, MAX_PRESPEC_WARM_PAGES);
    truncated = meta.totalPages != null && meta.totalPages > MAX_PRESPEC_WARM_PAGES;
    log.page(1, totalPages, p1.rows.length, merged.length, totalCount);

    for (let p = 2; p <= totalPages; p++) {
      const q = { ...prespec.query, pageNo: String(p) };
      const page = await fetchUpstream("prespec", prespec.operation, q, deps.fetchPrespec);
      if (!page.ok) {
        log.fail(`p.${p} upstream 중단`);
        break;
      }
      const batch = extractSupplementaryRows(page.data).rows;
      merged.push(...batch);
      log.page(p, totalPages, batch.length, merged.length, totalCount);
      if (p % PAGE_LOG_EVERY === 0) log.milestone(p, totalPages, merged.length);
      await sleep(350);
    }

    return saveTabSnapshotSafe(
      target,
      {
        rows: merged.map(slimSupplementaryRowForSnapshot).filter(Boolean),
        truncated,
        totalCount,
        meta: { operation: prespec.operation, pages: totalPages },
      },
      log
    );
  }

  async function syncBizinfoTab(target) {
    const log = createTabSyncProgressLog(target);
    if (!deps.fetchBizinfoSupport) {
      log.skip("BIZINFO_CRTFC_KEY 없음");
      return { tabKey: target.tabKey, ok: true, skipped: true, reason: "no_bizinfo_key" };
    }
    const biz = buildBizinfoWarmQuery();
    const pageUnit = Number(biz.query.pageUnit) || 15;
    log.start(`기업마당 · ${pageUnit}건/회`);

    const merged = [];
    let totalHint = null;
    let syncError = null;
    let maxPages = 1;

    for (let page = 1; page <= MAX_BIZINFO_WARM_PAGES; page++) {
      const q = { ...biz.query, pageIndex: String(page) };
      const out = await fetchUpstream(biz.namespace, biz.operation, q, (_op, query) =>
        deps.fetchBizinfoSupport(query)
      );
      if (!out.ok) {
        syncError = out.parseError || "upstream_fail";
        log.fail(syncError);
        break;
      }
      const { rows, totalHint: hint, reqErr } = extractBizinfoRows(out.data);
      if (reqErr) {
        syncError = reqErr;
        log.fail(reqErr);
        break;
      }
      if (hint != null) totalHint = hint;
      merged.push(...rows);
      maxPages = page;
      const estPages =
        totalHint != null ? Math.max(1, Math.ceil(totalHint / pageUnit)) : MAX_BIZINFO_WARM_PAGES;
      log.page(page, Math.min(estPages, MAX_BIZINFO_WARM_PAGES), rows.length, merged.length, totalHint);
      if (rows.length < pageUnit) break;
      if (totalHint != null && merged.length >= totalHint) break;
      await sleep(350);
    }

    if (syncError) {
      await recordTabSyncFailure(target, syncError, { pages: Math.ceil(merged.length / pageUnit) });
      return { tabKey: target.tabKey, ok: false, error: syncError, rowCount: merged.length };
    }

    return saveTabSnapshotSafe(
      target,
      {
        rows: merged,
        truncated: totalHint != null && merged.length < totalHint,
        totalCount: totalHint,
        meta: { pages: Math.ceil(merged.length / pageUnit) || maxPages },
      },
      log
    );
  }

  async function syncEventsTab(target) {
    const log = createTabSyncProgressLog(target);
    if (!deps.fetchBizinfoEvents) {
      log.skip("BIZINFO_CRTFC_KEY 없음");
      return { tabKey: target.tabKey, ok: true, skipped: true, reason: "no_bizinfo_key" };
    }
    const ev = buildEventsWarmQuery();
    const pageSize = Number(ev.query.pageUnit) || 20;
    log.start(`행사·교육 · ${pageSize}건/회`);

    const merged = [];
    let totalCount = null;
    let truncated = false;

    const q1 = { ...ev.query, pageIndex: "1" };
    const first = await fetchUpstream(ev.namespace, ev.operation, q1, (_op, query) =>
      deps.fetchBizinfoEvents(query)
    );
    if (!first.ok) {
      const err = first.parseError || "upstream_fail";
      log.fail(err);
      await recordTabSyncFailure(target, err);
      return { tabKey: target.tabKey, ok: false, error: err };
    }

    const p1 = extractSupplementaryRows(first.data);
    totalCount = p1.totalCount;
    merged.push(...p1.rows);

    const meta = extractSupplementaryListMeta(first.data, pageSize);
    const totalPages = Math.min(meta.totalPages ?? 1, MAX_EVENTS_WARM_PAGES);
    truncated = meta.totalPages != null && meta.totalPages > MAX_EVENTS_WARM_PAGES;
    log.page(1, totalPages, p1.rows.length, merged.length, totalCount);

    for (let p = 2; p <= totalPages; p++) {
      const q = { ...ev.query, pageIndex: String(p) };
      const page = await fetchUpstream(ev.namespace, ev.operation, q, (_op, query) =>
        deps.fetchBizinfoEvents(query)
      );
      if (!page.ok) {
        log.fail(`p.${p} upstream 중단`);
        break;
      }
      const batch = extractSupplementaryRows(page.data).rows;
      merged.push(...batch);
      log.page(p, totalPages, batch.length, merged.length, totalCount);
      if (p % PAGE_LOG_EVERY === 0) log.milestone(p, totalPages, merged.length);
      await sleep(350);
    }

    return saveTabSnapshotSafe(
      target,
      {
        rows: merged,
        truncated,
        totalCount,
        meta: { pages: totalPages },
      },
      log
    );
  }

  async function syncMssTab(target) {
    const log = createTabSyncProgressLog(target);
    if (!deps.warmMssBoard) {
      log.skip("RSS warm 미설정");
      return { tabKey: target.tabKey, ok: true, skipped: true, reason: "no_mss_warm" };
    }
    log.start(`RSS board ${target.board}`);

    const out = await deps.warmMssBoard(target.board, { force });
    if (!out.ok) {
      const err = out.error || "mss_fail";
      log.fail(err);
      await recordTabSyncFailure(target, err, { board: target.board });
      return { tabKey: target.tabKey, ok: false, error: err };
    }

    const rows = (out.items ?? []).map((it) => ({
      ...it,
      board: target.board,
    }));

    return saveTabSnapshotSafe(
      target,
      {
        rows,
        truncated: false,
        totalCount: rows.length,
        meta: { board: target.board, channel: out.channel ?? null },
      },
      log
    );
  }

  async function syncOneTarget(target) {
    const log = createTabSyncProgressLog(target);
    try {
      if (target.source === "nara_bid") return await syncBidTab(target);
      if (target.tabKey === "prespec") return await syncPrespecTab(target);
      if (target.tabKey === "bizinfo") return await syncBizinfoTab(target);
      if (target.tabKey === "events") return await syncEventsTab(target);
      if (target.source === "mss_rss") return await syncMssTab(target);
      return { tabKey: target.tabKey, ok: false, error: "unknown_target" };
    } catch (e) {
      const err = e?.message || "sync_failed";
      log.fail(err);
      await recordTabSyncFailure(target, err, {});
      return { tabKey: target.tabKey, ok: false, error: err };
    }
  }

  const parallelTargets = TAB_SNAPSHOT_TARGETS.filter((t) => isNaraParallelTab(t.tabKey));
  const sequentialTargets = TAB_SNAPSHOT_TARGETS.filter((t) => !isNaraParallelTab(t.tabKey));

  try {
    return await withTabSyncLock(syncSlot, async () => {
      const stopKeepAlive = startTabSyncKeepAlive(syncSlot);
      const syncStarted = Date.now();
      logTabSyncRunHeader(
        syncSlot,
        parallelTargets.map((t) => t.label || t.tabKey),
        sequentialTargets.map((t) => t.label || t.tabKey)
      );
      try {
        const parallelResults = await Promise.all(parallelTargets.map((target) => syncOneTarget(target)));
        results.push(...parallelResults);

        for (const target of sequentialTargets) {
          results.push(await syncOneTarget(target));
          await sleep(400);
        }
      } finally {
        stopKeepAlive();
        const sec = Math.round((Date.now() - syncStarted) / 1000);
        logTabSyncRunFooter(syncSlot, sec, results.every((r) => r.ok), results);
      }

      const ok = results.every((r) => r.ok);
      return {
        ok,
        at: new Date().toISOString(),
        force,
        syncSlot,
        results,
      };
    });
  } catch (e) {
    const err = e?.message || "tab_sync_failed";
    if (String(err).startsWith("tab_sync_busy")) {
      console.log(`[tab-sync] skip slot=${syncSlot} — ${err}`);
      return {
        ok: false,
        at: new Date().toISOString(),
        force,
        syncSlot,
        error: err,
        results,
      };
    }
    throw e;
  }
}

/** cacheWarmScheduler 와 동일 deps — upstream 캐시 + MongoDB 스냅샷 */
export async function runTabSyncAndWarm(deps, opts = {}) {
  const { runCacheWarm } = await import("./cacheWarmRun.js");
  const warm = await runCacheWarm(deps, opts);
  let sync = { ok: true, skipped: true, reason: "mongodb_not_configured" };
  if (isMongoConfigured()) {
    const slot = opts.syncSlot ?? (opts.force ? "scheduled" : "manual");
    sync = await runTabSync(deps, { force: opts.force ?? true, syncSlot: slot });
  }
  return {
    ok: warm.ok && sync.ok,
    at: new Date().toISOString(),
    warm,
    sync,
  };
}