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
} from "./cacheWarmParams.js";

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
      return { label, ok: true, skipped: true, cache: "hit" };
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
      };
    } catch (e) {
      return {
        label,
        ok: false,
        error: e?.message || "fetch_failed",
      };
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
    results.push(
      await warmOne(item.namespace, item.operation, item.query, deps.fetchBid, item.label)
    );
    await sleep(400);
  }

  const prespec = buildPrespecWarmQuery();
  results.push(
    await warmOne(
      "prespec",
      prespec.operation,
      prespec.query,
      deps.fetchPrespec,
      "prespec:default"
    )
  );
  await sleep(400);

  if (deps.fetchBizinfoSupport) {
    const biz = buildBizinfoWarmQuery();
    results.push(
      await warmOne(
        biz.namespace,
        biz.operation,
        biz.query,
        (_op, q) => deps.fetchBizinfoSupport(q),
        biz.label
      )
    );
    await sleep(400);
  } else {
    results.push({ label: "bizinfo:support", ok: true, skipped: true, reason: "no_bizinfo_key" });
  }

  if (deps.fetchBizinfoEvents) {
    const ev = buildEventsWarmQuery();
    results.push(
      await warmOne(
        ev.namespace,
        ev.operation,
        ev.query,
        (_op, q) => deps.fetchBizinfoEvents(q),
        ev.label
      )
    );
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
