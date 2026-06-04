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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {{ serviceKey: string, fetchBid: Function, fetchPrespec: Function, fetchBizinfoSupport?: Function, fetchBizinfoEvents?: Function, warmMssBoard?: Function }} deps
 * @param {{ force?: boolean }} opts
 */
export async function runCacheWarm(deps, { force = false } = {}) {
  const results = [];

  async function warmOne(namespace, operation, query, fetchFn, label) {
    const probe = readUpstreamQueryCache(namespace, operation, query);
    if (!force && probe.hit) {
      return { label, ok: true, skipped: true, cache: "hit", data: probe.data };
    }
    try {
      const upstream = await fetchFn(operation, query);
      const ok = upstream.status < 400;
      if (probe.cacheKey && ok) {
        writeUpstreamQueryCache(probe.cacheKey, upstream);
      }
      return {
        label,
        ok,
        status: upstream.status,
        cache: force ? "refreshed" : "filled",
        data: upstream.data,
      };
    } catch (e) {
      return {
        label,
        ok: false,
        error: e?.message || "fetch_failed",
      };
    }
  }

  async function warmAllPages({
    labelPrefix,
    namespace,
    operation,
    baseQuery,
    fetchFn,
    pageSize,
    maxPages,
    pageNoKey = "pageNo",
    extractMeta,
  }) {
    const pageSizeNum = Number(pageSize) || 20;
    const q1 = { ...baseQuery, [pageNoKey]: "1" };
    const first = await warmOne(namespace, operation, q1, fetchFn, `${labelPrefix}:p1`);
    results.push(first);
    if (!first.ok) return;

    const meta = extractMeta(first.data, pageSizeNum);
    if (meta.reqErr) {
      results.push({ label: `${labelPrefix}:meta`, ok: false, error: meta.reqErr });
      return;
    }

    const totalPages = Math.min(meta.totalPages ?? 1, maxPages);
    first.pages = totalPages;

    for (let p = 2; p <= totalPages; p++) {
      const q = { ...baseQuery, [pageNoKey]: String(p) };
      results.push(await warmOne(namespace, operation, q, fetchFn, `${labelPrefix}:p${p}`));
      await sleep(350);
    }
  }

  if (!deps.serviceKey) {
    return {
      ok: false,
      at: new Date().toISOString(),
      force,
      error: "missing_service_key",
      results,
    };
  }

  for (const item of buildBidWarmQueries()) {
    await warmAllPages({
      labelPrefix: item.label,
      namespace: item.namespace,
      operation: item.operation,
      baseQuery: { ...item.query },
      fetchFn: deps.fetchBid,
      pageSize: item.query.numOfRows,
      maxPages: MAX_BID_WARM_PAGES,
      pageNoKey: "pageNo",
      extractMeta: (data, ps) => extractBidListMeta(data, ps),
    });
    await sleep(400);
  }

  const prespec = buildPrespecWarmQuery();
  await warmAllPages({
    labelPrefix: "prespec:default",
    namespace: "prespec",
    operation: prespec.operation,
    baseQuery: { ...prespec.query },
    fetchFn: deps.fetchPrespec,
    pageSize: prespec.query.numOfRows,
    maxPages: MAX_PRESPEC_WARM_PAGES,
    pageNoKey: "pageNo",
    extractMeta: (data, ps) => extractSupplementaryListMeta(data, ps),
  });
  await sleep(400);

  if (deps.fetchBizinfoSupport) {
    const biz = buildBizinfoWarmQuery();
    await warmAllPages({
      labelPrefix: biz.label,
      namespace: biz.namespace,
      operation: biz.operation,
      baseQuery: { ...biz.query },
      fetchFn: (_op, q) => deps.fetchBizinfoSupport(q),
      pageSize: biz.query.pageUnit,
      maxPages: MAX_BIZINFO_WARM_PAGES,
      pageNoKey: "pageIndex",
      extractMeta: (data, ps) => extractBizinfoListMeta(data, ps),
    });
    await sleep(400);
  } else {
    results.push({ label: "bizinfo:support", ok: true, skipped: true, reason: "no_bizinfo_key" });
  }

  if (deps.fetchBizinfoEvents) {
    const ev = buildEventsWarmQuery();
    await warmAllPages({
      labelPrefix: ev.label,
      namespace: ev.namespace,
      operation: ev.operation,
      baseQuery: { ...ev.query },
      fetchFn: (_op, q) => deps.fetchBizinfoEvents(q),
      pageSize: ev.query.pageUnit,
      maxPages: MAX_EVENTS_WARM_PAGES,
      pageNoKey: "pageIndex",
      extractMeta: (data, ps) => extractSupplementaryListMeta(data, ps),
    });
    await sleep(400);
  } else {
    results.push({ label: "bizinfo:events", ok: true, skipped: true, reason: "no_bizinfo_key" });
  }

  if (deps.warmMssBoard) {
    for (const item of buildMssWarmBoards()) {
      try {
        const out = await deps.warmMssBoard(item.board, { force });
        results.push({
          label: item.label,
          ok: Boolean(out.ok),
          cache: force ? "refreshed" : out.cached ? "hit" : "filled",
          error: out.error,
        });
      } catch (e) {
        results.push({
          label: item.label,
          ok: false,
          error: e?.message || "mss_warm_failed",
        });
      }
      await sleep(300);
    }
  } else {
    results.push({ label: "mss:310", ok: true, skipped: true, reason: "no_mss_warm" });
    results.push({ label: "mss:81", ok: true, skipped: true, reason: "no_mss_warm" });
  }

  const ok = results.every((r) => r.ok);
  return {
    ok,
    at: new Date().toISOString(),
    force,
    results,
  };
}
