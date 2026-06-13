/** upstream 응답 → MongoDB 저장용 행 배열 */

import { parseUpstreamPayload } from "./upstreamPayloadParse.js";

function digResponseBody(payload) {
  const { payload: parsed } = parseUpstreamPayload(payload);
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.response?.body) return parsed.response.body;
  if (parsed.body) return parsed.body;
  return null;
}

function extractRawItems(payload) {
  const body = digResponseBody(payload);
  if (!body?.items) return [];
  const items = body.items;
  if (Array.isArray(items)) return items;
  if (items.item == null) return [];
  return Array.isArray(items.item) ? items.item : [items.item];
}

function toPlainRow(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

export function extractBidRows(payload) {
  const body = digResponseBody(payload);
  let totalCount = null;
  if (body?.totalCount != null) {
    const n = Number(body.totalCount);
    if (Number.isFinite(n)) totalCount = n;
  }
  const rows = extractRawItems(payload).map(toPlainRow).filter(Boolean);
  return { rows, totalCount };
}

export function extractSupplementaryRows(payload) {
  const body = digResponseBody(payload);
  let totalCount = null;
  for (const key of ["totalCount", "totalCnt", "totCnt"]) {
    if (body?.[key] != null) {
      const n = Number(body[key]);
      if (Number.isFinite(n)) {
        totalCount = n;
        break;
      }
    }
  }
  const rows = extractRawItems(payload).map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out = { ...raw };
    if (totalCount == null && raw.totCnt != null) {
      const n = Number(raw.totCnt);
      if (Number.isFinite(n)) totalCount = n;
    }
    return out;
  }).filter(Boolean);
  return { rows, totalCount };
}

export function extractBizinfoRows(payload) {
  const { payload: parsed, error } = parseUpstreamPayload(payload);
  if (!parsed || typeof parsed !== "object") {
    return { rows: [], totalHint: null, reqErr: error || "invalid_payload" };
  }
  if (parsed.reqErr) {
    return { rows: [], totalHint: null, reqErr: String(parsed.reqErr) };
  }
  if (error) {
    return { rows: [], totalHint: null, reqErr: error };
  }
  const jsonArray = parsed.jsonArray;
  let items = [];
  if (Array.isArray(jsonArray)) items = jsonArray;
  else if (jsonArray?.item) {
    items = Array.isArray(jsonArray.item) ? jsonArray.item : [jsonArray.item];
  }
  let totalHint = null;
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (i === 0 && raw.totCnt != null) {
      const n = Number(raw.totCnt);
      if (Number.isFinite(n)) totalHint = n;
    }
    rows.push({
      pblancNm: String(raw.title ?? raw.pblancNm ?? "").trim(),
      jrsdInsttNm: String(raw.author ?? raw.jrsdInsttNm ?? "").trim(),
      reqstDt: String(raw.reqstDt ?? raw.reqstBeginEndDe ?? "").trim(),
      pubDate: String(raw.pubDate ?? raw.creatPnttm ?? "").trim().slice(0, 10),
      link: String(raw.link ?? raw.pblancUrl ?? "").trim(),
      lclasNm: String(raw.lcategory ?? raw.pldirSportRealmLclasCodeNm ?? "").trim(),
    });
  }
  return { rows, totalHint, reqErr: null };
}

export function bidRowKey(row) {
  return `${row.bidNtceNo || ""}\t${row.bidNtceOrd || ""}`;
}
