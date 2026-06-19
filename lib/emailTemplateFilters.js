/**
 * 메일·반복 발송 — 프론트(bidTableColumnFilter 등)와 동일한 필터 판정
 * MongoDB 스냅샷 row 는 API 필드명 그대로이므로 가상 열(ntceInstt, deadline 등) 매핑 필요
 */

const DATE_RANGE_SEP = "~";
const BID_DATE_COLS = new Set(["deadline", "openg", "prtcpt", "input", "site"]);

const THNG_INDUSTRY_KEYS = [
  "dtilPrdctClsfcNoNm",
  "prdctClsfcNoNm",
  "dtilPrdctClsfcNo",
  "prdctClsfcNo",
  "prdctSpecNm",
];
const CNSTWK_INDUSTRY_KEYS = [
  "mainCnsttyNm",
  "mtltyAdvcPsblYnCnstwkNm",
  "cnstwkCtgyNm",
  "cnstwkSeNm",
  "cnsttyDivNm",
  "indstrytyNm",
  "bidprcPsblIndstrytyNm",
  "indstrytyLmtCn",
];
const SERVC_INDUSTRY_KEYS = [
  "servcCtgyNm",
  "pubPrcrmntLrgClsfcNm",
  "pubPrcrmntClsfcNm",
  "pubPrcrmntMidClsfcNm",
];
const REGION_KEYS = [
  "prtcptPsblRgnNm",
  "rgionNm",
  "cnstrtsiteRgnNm",
  "cnstwkRgnNm",
  "cnsttyRgnNm",
];

function pickFirst(row, keys) {
  for (const k of keys) {
    const v = String(row?.[k] ?? "").trim();
    if (v) return v;
  }
  return "";
}

function parseOrFilterTerms(raw) {
  return [...new Set(String(raw).split(/[,，]/).map((s) => s.trim()).filter(Boolean))];
}

function formatPriceKRW(s) {
  const raw = String(s).trim();
  if (!raw) return "";
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return raw;
  return `${n.toLocaleString("ko-KR")}원`;
}

function formatApiDateTimeShort(s) {
  const t = String(s).trim();
  if (!t) return "";
  if (/^\d{14}$/.test(t)) {
    return `${t.slice(2, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`;
  }
  if (/^\d{12}$/.test(t)) {
    return `${t.slice(2, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`;
  }
  if (/^\d{8}$/.test(t)) {
    return `${t.slice(2, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  }
  return t;
}

function regionFromInstitution(row) {
  const instt = pickFirst(row, ["ntceInsttNm", "dminsttNm"]);
  if (!instt) return "";
  const m = instt.match(
    /^((?:서울|부산|대구|인천|광주|대전|울산|세종|제주|경기|강원|충북|충남|전북|전남|경북|경남)(?:특별시|광역시|특별자치시|특별자치도|도)?(?:\s+[가-힣]+(?:시|군|구))?)/
  );
  if (m) return m[1].trim();
  const m2 = instt.match(/^([가-힣]+(?:특별자치도|특별자치시|광역시|특별시|도))(?:\s+([가-힣]+(?:시|군|구)))?/);
  if (m2) return m2[2] ? `${m2[1]} ${m2[2]}` : m2[1];
  return "";
}

function industryLicenseLine(row, biz) {
  const keys =
    biz === "Thng" ? THNG_INDUSTRY_KEYS : biz === "Cnstwk" ? CNSTWK_INDUSTRY_KEYS : SERVC_INDUSTRY_KEYS;
  const raw = pickFirst(row, keys);
  if (!raw) return "";
  return raw.includes("[") ? raw : `[${raw}]`;
}

function regionBracket(row) {
  const r = pickFirst(row, REGION_KEYS) || regionFromInstitution(row);
  return r ? `[${r}]` : "";
}

function noticeNoLine(row) {
  return [row.bidNtceNo, row.bidNtceOrd].filter(Boolean).join("-") || "";
}

function thngNoLine(row, biz) {
  if (biz === "Thng") {
    const no = pickFirst(row, ["dtilPrdctClsfcNo", "thngNo", "prdctClsfcNo"]);
    const nm = pickFirst(row, ["dtilPrdctClsfcNoNm", "prdctClsfcNoNm", "thngNm", "prdctSpecNm"]);
    if (no && nm) return `${no} (${nm})`;
    return no || nm || "";
  }
  if (biz === "Cnstwk") {
    return pickFirst(row, ["mainCnsttyNm", "mtltyAdvcPsblYnCnstwkNm", "cnstwkCtgyNm"]);
  }
  const no = pickFirst(row, ["pubPrcrmntClsfcNo", "thngNo"]);
  const nm = pickFirst(row, ["pubPrcrmntClsfcNm", "pubPrcrmntLrgClsfcNm", "servcCtgyNm"]);
  if (no && nm) return `${no} (${nm})`;
  return no || nm || "";
}

function bidRowCellFilterText(row, col, naraBiz, rowIndex, rowTotal) {
  switch (col) {
    case "num":
      if (rowIndex != null && rowTotal != null && rowTotal > 0) {
        return String(rowTotal - rowIndex);
      }
      return noticeNoLine(row);
    case "bidNtceNm":
      return String(row.bidNtceNm ?? "").trim();
    case "bidNtceNo":
      return noticeNoLine(row);
    case "industry":
      return industryLicenseLine(row, naraBiz);
    case "region":
      return regionBracket(row);
    case "ntceInstt":
      return pickFirst(row, ["ntceInsttNm"]);
    case "dminstt":
      return pickFirst(row, ["dminsttNm"]);
    case "bssAmt":
      return formatPriceKRW(pickFirst(row, ["bssamt", "bsisPlnprc", "bssAmt"]));
    case "presmptPrce":
      return formatPriceKRW(pickFirst(row, ["presmptPrce"]));
    case "deadline":
      return formatApiDateTimeShort(pickFirst(row, ["bidClseDt", "tbdtBidClseDt"]));
    case "openg":
      return formatApiDateTimeShort(pickFirst(row, ["opengDt"]));
    case "prtcpt":
      return formatApiDateTimeShort(pickFirst(row, ["prtcptPsblDt", "rqstPsblDt"]));
    case "input":
      return formatApiDateTimeShort(pickFirst(row, ["bidNtceDt", "ntceDt", "rgstDt"]));
    case "site":
      return formatApiDateTimeShort(pickFirst(row, ["dcmtgOprtnDt", "bfSpecRgstDt"]));
    case "thng":
      return thngNoLine(row, naraBiz);
    case "status":
      return pickFirst(row, ["ntceKindNm"]);
    default: {
      const direct = String(row?.[col] ?? "").trim();
      if (direct) return direct;
      return "";
    }
  }
}

function parseDateRangeFilter(raw) {
  const v = String(raw).trim();
  if (!v || !v.includes(DATE_RANGE_SEP)) return null;
  const idx = v.indexOf(DATE_RANGE_SEP);
  const from = v.slice(0, idx).trim();
  const to = v.slice(idx + 1).trim();
  if (!from && !to) return null;
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return { from, to };
}

function ymdToMs(y, m, d, endOfDay) {
  if (endOfDay) return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function parseIsoDateOnlyMs(iso, endOfDay) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return ymdToMs(Number(m[1]), Number(m[2]), Number(m[3]), endOfDay);
}

function parseCompactDateTimeMs(s) {
  const t = String(s).replace(/<!\[CDATA\[|\]\]>/g, "").trim();
  if (/^\d{14}$/.test(t)) {
    const day = ymdToMs(Number(t.slice(0, 4)), Number(t.slice(4, 6)), Number(t.slice(6, 8)), false);
    const ms = day + (Number(t.slice(8, 10)) * 3600 + Number(t.slice(10, 12)) * 60 + Number(t.slice(12, 14))) * 1000;
    return { startMs: ms, endMs: ms };
  }
  if (/^\d{8}$/.test(t)) {
    const start = ymdToMs(Number(t.slice(0, 4)), Number(t.slice(4, 6)), Number(t.slice(6, 8)), false);
    const end = ymdToMs(Number(t.slice(0, 4)), Number(t.slice(4, 6)), Number(t.slice(6, 8)), true);
    return { startMs: start, endMs: end };
  }
  return null;
}

function parseCellDateRangeMs(key, raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/<!\[CDATA\[|\]\]>/g, "").trim();
  if (!s) return null;
  const compact = parseCompactDateTimeMs(s);
  if (compact) return compact;
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return {
      startMs: ymdToMs(d.getFullYear(), d.getMonth() + 1, d.getDate(), false),
      endMs: ymdToMs(d.getFullYear(), d.getMonth() + 1, d.getDate(), true),
    };
  }
  return null;
}

function cellMatchesDateRangeFilter(cellRange, filter) {
  if (!cellRange) return false;
  const filterStart = filter.from ? parseIsoDateOnlyMs(filter.from, false) : null;
  const filterEnd = filter.to ? parseIsoDateOnlyMs(filter.to, true) : null;
  if (filterStart != null && cellRange.endMs < filterStart) return false;
  if (filterEnd != null && cellRange.startMs > filterEnd) return false;
  return true;
}

function bidRowRawDateValue(row, col) {
  switch (col) {
    case "deadline":
      return pickFirst(row, ["bidClseDt", "tbdtBidClseDt"]);
    case "openg":
      return pickFirst(row, ["opengDt"]);
    case "prtcpt":
      return pickFirst(row, ["prtcptPsblDt", "rqstPsblDt"]);
    case "input":
      return pickFirst(row, ["bidNtceDt", "ntceDt", "rgstDt"]);
    case "site":
      return pickFirst(row, ["dcmtgOprtnDt", "bfSpecRgstDt"]);
    default:
      return "";
  }
}

function isDateFilterColumnKey(key) {
  if (key === "pubDate" || key === "eventBeginEndDe") return true;
  if (/(?:Cnt|Amt|No|Id|Cd|Yn|Nm|Co|Div|Ty|Methd|List|Url)$/i.test(key)) return false;
  return /(?:Dt|Date|date|Ym|De|de|Pnttm)$/i.test(key);
}

function supplementaryRowValue(row, key) {
  const direct = row[key];
  if (direct != null && String(direct).trim() !== "") return direct;
  if (key === "nttNm" || key === "title") {
    return row.nttNm ?? row.title ?? row.eventNm ?? row.eduNm ?? "";
  }
  if (key === "bizNm" || key === "pblancNm") {
    return row.bizNm ?? row.pblancNm ?? row.prdcNm ?? row.prdctNm ?? "";
  }
  return direct ?? "";
}

function supplementaryCellText(row, col) {
  const v = supplementaryRowValue(row, col);
  return v == null ? "" : String(v).trim();
}

export { supplementaryCellText };

export function applyBidColumnFilters(rows, columnFilters, naraBiz) {
  const entries = Object.entries(columnFilters ?? {}).filter(([, v]) => String(v).trim());
  if (!entries.length) return rows;
  const total = rows.length;
  return rows.filter((row, idx) => {
    for (const [col, raw] of entries) {
      if (BID_DATE_COLS.has(col)) {
        const range = parseDateRangeFilter(raw);
        if (range) {
          const cellRange = parseCellDateRangeMs(col, bidRowRawDateValue(row, col));
          if (!cellMatchesDateRangeFilter(cellRange, range)) return false;
          continue;
        }
      }
      const terms = parseOrFilterTerms(raw);
      if (!terms.length) continue;
      const hay = bidRowCellFilterText(row, col, naraBiz, idx, total).toLowerCase();
      if (!terms.some((term) => hay.includes(term.toLowerCase()))) return false;
    }
    return true;
  });
}

export function applySupplementaryColumnFilters(rows, columnFilters) {
  const entries = Object.entries(columnFilters ?? {}).filter(([, v]) => String(v).trim());
  if (!entries.length) return rows;
  return rows.filter((row) => {
    for (const [col, raw] of entries) {
      if (isDateFilterColumnKey(col)) {
        const range = parseDateRangeFilter(raw);
        if (range) {
          const cellRange = parseCellDateRangeMs(col, supplementaryRowValue(row, col));
          if (!cellMatchesDateRangeFilter(cellRange, range)) return false;
          continue;
        }
      }
      const terms = parseOrFilterTerms(raw);
      if (!terms.length) continue;
      const hay = supplementaryCellText(row, col).toLowerCase();
      if (!terms.some((term) => hay.includes(term.toLowerCase()))) return false;
    }
    return true;
  });
}

export function applyTemplateColumnFilters(rows, template) {
  const tableKey = String(template.tableKey ?? "");
  const filters = template.columnFilters ?? {};
  if (tableKey.startsWith("bid:")) {
    const naraBiz = tableKey.slice(4);
    if (naraBiz === "Thng" || naraBiz === "Cnstwk" || naraBiz === "Servc") {
      return applyBidColumnFilters(rows, filters, naraBiz);
    }
  }
  return applySupplementaryColumnFilters(rows, filters);
}

export function bidRowCellText(row, col, naraBiz) {
  return bidRowCellFilterText(row, col, naraBiz, 0, 1);
}
