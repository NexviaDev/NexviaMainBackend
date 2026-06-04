/** 입찰·사전규격 upstream 응답 — 메모리 캐시 (동시 접속·API 할당량·슬립 완화) */
export const UPSTREAM_QUERY_CACHE_TTL_MS = 30 * 60 * 1000;
const UPSTREAM_QUERY_CACHE_MAX = 256;

const store = new Map();

const STRIP_QUERY_KEYS = new Set(["nxRefresh", "nx_refresh", "refresh"]);

function normalizeQueryValue(v) {
  if (v == null) return "";
  if (Array.isArray(v)) {
    return [...v]
      .map((x) => String(x ?? "").trim())
      .filter(Boolean)
      .sort()
      .join("\u001f");
  }
  return String(v).trim();
}

export function stableUpstreamQueryKey(query) {
  const q = { ...(query || {}) };
  for (const k of STRIP_QUERY_KEYS) delete q[k];
  return Object.keys(q)
    .sort()
    .map((k) => `${k}=${normalizeQueryValue(q[k])}`)
    .join("&");
}

export function shouldBypassUpstreamCache(query) {
  const v = query?.nxRefresh ?? query?.nx_refresh ?? query?.refresh;
  return v === "1" || v === "true" || v === true;
}

function evictIfNeeded() {
  if (store.size < UPSTREAM_QUERY_CACHE_MAX) return;
  const first = store.keys().next().value;
  if (first) store.delete(first);
}

/**
 * @returns {{ hit: true, status: number, data: unknown, contentType: string } | { hit: false, cacheKey: string }}
 */
export function readUpstreamQueryCache(namespace, operation, query) {
  if (shouldBypassUpstreamCache(query)) {
    return { hit: false, cacheKey: null, bypass: true };
  }
  const cacheKey = `${namespace}:${operation}:${stableUpstreamQueryKey(query)}`;
  const row = store.get(cacheKey);
  const now = Date.now();
  if (row && now - row.at < UPSTREAM_QUERY_CACHE_TTL_MS) {
    return { hit: true, status: row.status, data: row.data, contentType: row.contentType };
  }
  return { hit: false, cacheKey };
}

export function writeUpstreamQueryCache(cacheKey, payload) {
  if (!cacheKey) return;
  evictIfNeeded();
  store.set(cacheKey, { at: Date.now(), ...payload });
}
