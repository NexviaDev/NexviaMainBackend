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
} from "./tabSyncExtract.js";
import { TAB_SNAPSHOT_TARGETS } from "./tabSyncKeys.js";
import { upsertTabSnapshot } from "./tabSyncStore.js";
import { isMongoConfigured } from "./mongo.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      return { ok: true, data: probe.data, cache: "hit" };
    }
    const upstream = await fetchFn(operation, query);
    const ok = upstream.status < 400;
    if (probe.cacheKey && ok) {
      writeUpstreamQueryCache(probe.cacheKey, upstream);
    }
    return { ok, data: upstream.data, cache: force ? "refreshed" : "filled", status: upstream.status };
  }

  async function syncBidTab(target) {
    const item = buildBidWarmQueries().find((q) => q.label === `bid:${target.naraBiz}`);
    if (!item) {
      results.push({ tabKey: target.tabKey, ok: false, error: "warm_query_missing" });
      return;
    }

    const pageSize = Number(item.query.numOfRows) || 50;
    const merged = new Map();
    let totalCount = null;
    let truncated = false;

    const q1 = { ...item.query, pageNo: "1" };
    const first = await fetchUpstream(item.namespace, item.operation, q1, deps.fetchBid);
    if (!first.ok) {
      results.push({ tabKey: target.tabKey, ok: false, error: `upstream_${first.status ?? "fail"}` });
      return;
    }

    const p1 = extractBidRows(first.data);
    totalCount = p1.totalCount;
    for (const row of p1.rows) merged.set(bidRowKey(row), row);

    const meta = extractBidListMeta(first.data, pageSize);
    const totalPages = Math.min(meta.totalPages ?? 1, MAX_BID_WARM_PAGES);
    truncated = totalCount != null && totalPages < Math.ceil(totalCount / pageSize);

    for (let p = 2; p <= totalPages; p++) {
      const q = { ...item.query, pageNo: String(p) };
      const page = await fetchUpstream(item.namespace, item.operation, q, deps.fetchBid);
      if (!page.ok) break;
      for (const row of extractBidRows(page.data).rows) merged.set(bidRowKey(row), row);
      await sleep(350);
    }

    const rows = [...merged.values()];
    await upsertTabSnapshot(target.tabKey, {
      uiTab: target.uiTab,
      label: target.label,
      source: target.source,
      rows,
      truncated,
      totalCount,
      meta: { naraBiz: target.naraBiz, operation: item.operation, pages: totalPages },
    });
    results.push({ tabKey: target.tabKey, ok: true, rowCount: rows.length, truncated });
  }

  async function syncPrespecTab(target) {
    const prespec = buildPrespecWarmQuery();
    const pageSize = Number(prespec.query.numOfRows) || 20;
    const merged = [];
    let totalCount = null;
    let truncated = false;

    const q1 = { ...prespec.query, pageNo: "1" };
    const first = await fetchUpstream("prespec", prespec.operation, q1, deps.fetchPrespec);
    if (!first.ok) {
      results.push({ tabKey: target.tabKey, ok: false, error: "upstream_fail" });
      return;
    }

    const p1 = extractSupplementaryRows(first.data);
    totalCount = p1.totalCount;
    merged.push(...p1.rows);

    const meta = extractSupplementaryListMeta(first.data, pageSize);
    const totalPages = Math.min(meta.totalPages ?? 1, MAX_PRESPEC_WARM_PAGES);
    truncated = meta.totalPages != null && meta.totalPages > MAX_PRESPEC_WARM_PAGES;

    for (let p = 2; p <= totalPages; p++) {
      const q = { ...prespec.query, pageNo: String(p) };
      const page = await fetchUpstream("prespec", prespec.operation, q, deps.fetchPrespec);
      if (!page.ok) break;
      merged.push(...extractSupplementaryRows(page.data).rows);
      await sleep(350);
    }

    await upsertTabSnapshot(target.tabKey, {
      uiTab: target.uiTab,
      label: target.label,
      source: target.source,
      rows: merged,
      truncated,
      totalCount,
      meta: { operation: prespec.operation, pages: totalPages },
    });
    results.push({ tabKey: target.tabKey, ok: true, rowCount: merged.length, truncated });
  }

  async function syncBizinfoTab(target) {
    if (!deps.fetchBizinfoSupport) {
      results.push({ tabKey: target.tabKey, ok: true, skipped: true, reason: "no_bizinfo_key" });
      return;
    }

    const biz = buildBizinfoWarmQuery();
    const pageUnit = Number(biz.query.pageUnit) || 15;
    const merged = [];
    let totalHint = null;

    for (let page = 1; page <= MAX_BIZINFO_WARM_PAGES; page++) {
      const q = { ...biz.query, pageIndex: String(page) };
      const out = await fetchUpstream(biz.namespace, biz.operation, q, (_op, query) =>
        deps.fetchBizinfoSupport(query)
      );
      if (!out.ok) break;
      const { rows, totalHint: hint, reqErr } = extractBizinfoRows(out.data);
      if (reqErr) break;
      if (hint != null) totalHint = hint;
      merged.push(...rows);
      if (rows.length < pageUnit) break;
      if (totalHint != null && merged.length >= totalHint) break;
      await sleep(350);
    }

    await upsertTabSnapshot(target.tabKey, {
      uiTab: target.uiTab,
      label: target.label,
      source: target.source,
      rows: merged,
      truncated: totalHint != null && merged.length < totalHint,
      totalCount: totalHint,
      meta: { pages: Math.ceil(merged.length / pageUnit) },
    });
    results.push({ tabKey: target.tabKey, ok: true, rowCount: merged.length });
  }

  async function syncEventsTab(target) {
    if (!deps.fetchBizinfoEvents) {
      results.push({ tabKey: target.tabKey, ok: true, skipped: true, reason: "no_bizinfo_key" });
      return;
    }

    const ev = buildEventsWarmQuery();
    const pageSize = Number(ev.query.pageUnit) || 20;
    const merged = [];
    let totalCount = null;
    let truncated = false;

    const q1 = { ...ev.query, pageIndex: "1" };
    const first = await fetchUpstream(ev.namespace, ev.operation, q1, (_op, query) =>
      deps.fetchBizinfoEvents(query)
    );
    if (!first.ok) {
      results.push({ tabKey: target.tabKey, ok: false, error: "upstream_fail" });
      return;
    }

    const p1 = extractSupplementaryRows(first.data);
    totalCount = p1.totalCount;
    merged.push(...p1.rows);

    const meta = extractSupplementaryListMeta(first.data, pageSize);
    const totalPages = Math.min(meta.totalPages ?? 1, MAX_EVENTS_WARM_PAGES);
    truncated = meta.totalPages != null && meta.totalPages > MAX_EVENTS_WARM_PAGES;

    for (let p = 2; p <= totalPages; p++) {
      const q = { ...ev.query, pageIndex: String(p) };
      const page = await fetchUpstream(ev.namespace, ev.operation, q, (_op, query) =>
        deps.fetchBizinfoEvents(query)
      );
      if (!page.ok) break;
      merged.push(...extractSupplementaryRows(page.data).rows);
      await sleep(350);
    }

    await upsertTabSnapshot(target.tabKey, {
      uiTab: target.uiTab,
      label: target.label,
      source: target.source,
      rows: merged,
      truncated,
      totalCount,
      meta: { pages: totalPages },
    });
    results.push({ tabKey: target.tabKey, ok: true, rowCount: merged.length, truncated });
  }

  async function syncMssTab(target) {
    if (!deps.warmMssBoard) {
      results.push({ tabKey: target.tabKey, ok: true, skipped: true, reason: "no_mss_warm" });
      return;
    }

    const out = await deps.warmMssBoard(target.board, { force });
    if (!out.ok) {
      results.push({ tabKey: target.tabKey, ok: false, error: out.error || "mss_fail" });
      return;
    }

    const rows = (out.items ?? []).map((it) => ({
      ...it,
      board: target.board,
    }));

    await upsertTabSnapshot(target.tabKey, {
      uiTab: target.uiTab,
      label: target.label,
      source: target.source,
      rows,
      truncated: false,
      totalCount: rows.length,
      meta: { board: target.board, channel: out.channel ?? null },
    });
    results.push({ tabKey: target.tabKey, ok: true, rowCount: rows.length });
  }

  for (const target of TAB_SNAPSHOT_TARGETS) {
    try {
      if (target.source === "nara_bid") await syncBidTab(target);
      else if (target.tabKey === "prespec") await syncPrespecTab(target);
      else if (target.tabKey === "bizinfo") await syncBizinfoTab(target);
      else if (target.tabKey === "events") await syncEventsTab(target);
      else if (target.source === "mss_rss") await syncMssTab(target);
    } catch (e) {
      results.push({ tabKey: target.tabKey, ok: false, error: e?.message || "sync_failed" });
    }
    await sleep(400);
  }

  const ok = results.every((r) => r.ok);
  return {
    ok,
    at: new Date().toISOString(),
    force,
    syncSlot,
    results,
  };
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