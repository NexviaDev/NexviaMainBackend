/** cacheWarmRun — upstream 응답에서 페이지 수 추정 */

function digResponseBody(payload) {
  if (!payload || typeof payload !== "object") return null;
  const root = payload;
  if (root.response?.body) return root.response.body;
  if (root.body) return root.body;
  return null;
}

function pickNum(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    if (obj[k] == null) continue;
    const n = Number(obj[k]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractItemCount(body) {
  if (!body?.items) return 0;
  const items = body.items;
  if (Array.isArray(items)) return items.length;
  if (items.item == null) return 0;
  return Array.isArray(items.item) ? items.item.length : 1;
}

/** 나라장터 입찰 목록 */
export function extractBidListMeta(data, pageSize) {
  const body = digResponseBody(data);
  const per = Math.max(1, Number(pageSize) || 50);
  let totalCount = pickNum(body, ["totalCount"]);
  const rowCount = extractItemCount(body);
  if (totalCount == null && rowCount > 0) totalCount = rowCount;
  const totalPages =
    totalCount != null ? Math.max(1, Math.ceil(totalCount / per)) : rowCount >= per ? 2 : 1;
  return { totalCount, totalPages, rowCount };
}

/** 사전규격·행사 등 data.go.kr / bizinfo 목록 */
export function extractSupplementaryListMeta(data, fallbackPageSize) {
  const body = digResponseBody(data);
  const per = pickNum(body, ["numOfRows", "pageUnit"]) ?? fallbackPageSize;
  let totalCount = pickNum(body, ["totalCount", "totalCnt", "totCnt"]);
  const rowCount = extractItemCount(body);
  if (totalCount == null && rowCount > 0) {
    const items = body?.items;
    const first = Array.isArray(items) ? items[0] : items?.item?.[0] ?? items?.item;
    const tot = first?.totCnt != null ? Number(first.totCnt) : null;
    if (Number.isFinite(tot)) totalCount = tot;
  }
  const totalPages =
    totalCount != null && per > 0
      ? Math.max(1, Math.ceil(totalCount / per))
      : rowCount >= per
        ? 2
        : 1;
  return { totalCount, totalPages, rowCount, pageSize: per };
}

/** 기업마당 jsonArray */
export function extractBizinfoListMeta(data, pageUnit) {
  if (!data || typeof data !== "object") {
    return { totalHint: null, rowCount: 0, totalPages: 1 };
  }
  const root = data;
  if (root.reqErr) {
    return { totalHint: null, rowCount: 0, totalPages: 1, reqErr: String(root.reqErr) };
  }
  const jsonArray = root.jsonArray;
  let items = [];
  if (Array.isArray(jsonArray)) items = jsonArray;
  else if (jsonArray?.item) {
    items = Array.isArray(jsonArray.item) ? jsonArray.item : [jsonArray.item];
  }
  let totalHint = null;
  if (items[0]?.totCnt != null) {
    const n = Number(items[0].totCnt);
    if (Number.isFinite(n)) totalHint = n;
  }
  const per = Math.max(1, Number(pageUnit) || 15);
  const totalPages =
    totalHint != null
      ? Math.max(1, Math.ceil(totalHint / per))
      : items.length >= per
        ? 2
        : 1;
  return { totalHint, rowCount: items.length, totalPages };
}
