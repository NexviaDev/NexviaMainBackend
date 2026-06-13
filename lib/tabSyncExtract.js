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
    if (k.startsWith("$") || k.includes(".")) continue;
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

/** MongoDB 16MB 한도 — UI·개찰에 필요한 필드만 저장 */
const BID_SNAPSHOT_KEEP_KEYS = new Set([
  "bidNtceNo", "bidNtceOrd", "bidNtceNm", "ntceKindNm", "bidNtceSttusNm",
  "ntceInsttNm", "dminsttNm", "ntceInsttAdrs", "dminsttAdrs",
  "presmptPrce", "bssamt", "bsisPlnprc", "bssAmt", "asignBdgtAmt",
  "bidClseDt", "tbdtBidClseDt", "opengDt", "rgstDt", "bidNtceDt", "ntceDt",
  "prtcptPsblDt", "rqstPsblDt", "dcmtgOprtnDt", "bfSpecRgstDt",
  "dtilPrdctClsfcNoNm", "prdctClsfcNoNm", "dtilPrdctClsfcNo", "prdctClsfcNo", "prdctSpecNm",
  "mainCnsttyNm", "mtltyAdvcPsblYnCnstwkNm", "cnstwkCtgyNm", "cnstwkSeNm", "cnsttyDivNm",
  "indstrytyNm", "bidprcPsblIndstrytyNm", "indstrytyLmtCn",
  "servcCtgyNm", "pubPrcrmntLrgClsfcNm", "pubPrcrmntClsfcNm", "pubPrcrmntMidClsfcNm",
  "pubPrcrmntClsfcNo", "thngNo", "thngNm",
  "prtcptPsblRgnNm", "rgionNm", "cnstrtsiteRgnNm", "cnstwkRgnNm", "cnsttyRgnNm",
  "bidMthdNm", "cntrctCnclsMthdNm", "sucsfbidMthdNm", "sucsfbidLwltRate",
  "ntceSpecDocUrl1", "ntceSpecFileUrl1", "bidNtceDtlUrl", "bidNtceUrl",
]);

export function slimBidRowForSnapshot(row) {
  if (!row || typeof row !== "object") return null;
  const out = {};
  for (const k of BID_SNAPSHOT_KEEP_KEYS) {
    if (row[k] != null && String(row[k]).trim()) out[k] = String(row[k]);
  }
  if (!out.bidNtceNo && !out.bidNtceNm) {
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith("$") || k.includes(".")) continue;
      const s = v == null ? "" : String(v);
      if (s) out[k] = s.length > 400 ? s.slice(0, 400) : s;
    }
  }
  return out.bidNtceNo || out.bidNtceNm ? out : null;
}

export function slimSupplementaryRowForSnapshot(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("$") || k.includes(".")) continue;
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    out[k] = s.length > 400 ? s.slice(0, 400) : s;
  }
  return Object.keys(out).length ? out : null;
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
