import { getTabSnapshot } from "./tabSyncStore.js";
import {
  applyTemplateColumnFilters,
  bidRowCellText,
  supplementaryCellText as suppCellText,
} from "./emailTemplateFilters.js";

const MAX_ROWS = 300;
const FETCH_NOTE = "MongoDB 탭 동기화 스냅샷 · 매일 반복 발송";
const G2B_ORIGIN = "https://www.g2b.go.kr";

/** 나라장터 사전규격 상세 — API bfSpecRgstNo (메일·외부 공유용) */
function buildG2bPrespecUrl(bfSpecRgstNo) {
  const no = String(bfSpecRgstNo ?? "").trim();
  if (!no) return null;
  return `${G2B_ORIGIN}/link/PNPE028_01/single/?bfSpecRgstNo=${encodeURIComponent(no)}`;
}

const CATEGORY_LABELS = {
  "bid:Thng": "나라장터 · 구매입찰",
  "bid:Cnstwk": "나라장터 · 공사입찰",
  "bid:Servc": "나라장터 · 용역입찰",
  "bizinfo:support": "기업마당 · 지원사업",
  "link:사전규격": "나라장터 · 사전규격",
  "link:기업마당_행사교육": "기업마당 · 행사·교육",
  "link:중소벤처기업부_RSS": "중소벤처기업부 · RSS",
};

function tableKeyToTabKey(tableKey) {
  if (tableKey.startsWith("bid:")) return tableKey;
  if (tableKey === "bizinfo:support") return "bizinfo";
  if (tableKey === "link:사전규격") return "prespec";
  if (tableKey === "link:기업마당_행사교육") return "events";
  if (tableKey === "link:중소벤처기업부_RSS") return "mss:310";
  return null;
}

function cell(text, href = null) {
  const t = String(text ?? "").trim();
  if (href && /^https?:\/\//i.test(href)) return { text: t || "열기", href: href.slice(0, 8192) };
  return { text: t };
}

function rowVal(row, key) {
  const v = row?.[key];
  if (v == null) return "";
  return String(v).trim();
}

function supplementaryCellText(row, key) {
  return suppCellText(row, key) || rowVal(row, key);
}

function applyColumnFilters(rows, columnFilters, tableKey) {
  return applyTemplateColumnFilters(rows, { tableKey, columnFilters });
}

function parseSortableDate(raw) {
  const s = String(raw ?? "").replace(/\D/g, "");
  if (s.length >= 14) return Number(s.slice(0, 14));
  if (s.length >= 8) return Number(s.slice(0, 8)) * 1_000_000;
  return 0;
}

function defaultDateKey(tableKey) {
  if (tableKey.startsWith("bid:")) return "bidClseDt";
  if (tableKey === "bizinfo:support") return "pubDate";
  if (tableKey === "link:사전규격") return "rcptDt";
  if (tableKey === "link:기업마당_행사교육") return "eventBeginDt";
  if (tableKey === "link:중소벤처기업부_RSS") return "pubDate";
  return null;
}

function sortRows(rows, template) {
  const tableKey = template.tableKey;
  const sortCol = template.sort?.col;
  const dir = template.sort?.dir === "asc" ? 1 : -1;
  const dateKey = sortCol || defaultDateKey(tableKey);
  if (!dateKey) return rows;
  return [...rows].sort((a, b) => {
    const av = sortCol ? rowVal(a, sortCol) : parseSortableDate(rowVal(a, dateKey));
    const bv = sortCol ? rowVal(b, sortCol) : parseSortableDate(rowVal(b, dateKey));
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv), "ko") * dir;
  });
}

function bidColumns() {
  return [
    { id: "bidNtceNm", label: "공고명", href: (r) => rowVal(r, "bidNtceDtlUrl") || rowVal(r, "bidNtceUrl") },
    { id: "ntceInsttNm", label: "공고기관" },
    { id: "bidClseDt", label: "입찰마감" },
    { id: "asignBdgtAmt", label: "배정예산" },
  ];
}

function bizinfoColumns() {
  return [
    { id: "pblancNm", label: "지원사업명", href: (r) => rowVal(r, "link") },
    { id: "lclasNm", label: "분류" },
    { id: "jrsdInsttNm", label: "소관기관" },
    { id: "reqstDt", label: "신청기간" },
  ];
}

function prespecColumns() {
  return [
    { id: "prdctClsfcNoNm", label: "품명" },
    { id: "prdctNm", label: "물품명" },
    { id: "insttNm", label: "기관" },
    { id: "rcptDt", label: "접수일" },
  ];
}

function eventsColumns() {
  return [
    { id: "eventNm", label: "행사명", href: (r) => rowVal(r, "eventUrl") || rowVal(r, "link") },
    { id: "eduNm", label: "교육명" },
    { id: "eventBeginDt", label: "시작일" },
    { id: "jrsdInsttNm", label: "주관" },
  ];
}

function mssColumns() {
  return [
    { id: "title", label: "제목", href: (r) => rowVal(r, "link") },
    { id: "pubDate", label: "게시일" },
    { id: "author", label: "출처" },
  ];
}

function columnsForTableKey(tableKey) {
  if (tableKey.startsWith("bid:")) return bidColumns();
  if (tableKey === "bizinfo:support") return bizinfoColumns();
  if (tableKey === "link:사전규격") return prespecColumns();
  if (tableKey === "link:기업마당_행사교육") return eventsColumns();
  if (tableKey === "link:중소벤처기업부_RSS") return mssColumns();
  return [{ id: "title", label: "제목" }];
}

function titleColForRow(row, cols) {
  for (const c of cols) {
    if (rowVal(row, c.id)) return c.id;
  }
  return cols[0]?.id;
}

function buildDataRows(slice, cols, tableKey, naraBiz) {
  return slice.map((row, i) => {
    const titleCol = titleColForRow(row, cols);
    return [
      cell(String(i + 1)),
      ...cols.map((c) => {
        let text = "";
        if (tableKey.startsWith("bid:") && naraBiz) {
          text = bidRowCellText(row, c.id, naraBiz) || rowVal(row, c.id);
        } else {
          text = supplementaryCellText(row, c.id) || rowVal(row, c.id);
        }
        let href =
          c.id === titleCol && typeof c.href === "function"
            ? c.href(row)
            : typeof c.href === "function"
              ? c.href(row)
              : null;
        if (tableKey === "link:사전규격" && c.id === titleCol) {
          href = buildG2bPrespecUrl(rowVal(row, "bfSpecRgstNo")) ?? href;
        }
        return cell(text, href);
      }),
    ];
  });
}

/**
 * MongoDB 스냅샷 + 템플릿 필터로 메일 section 1건 생성
 * @param {object} template — recurring doc 의 template 스냅샷
 */
export async function buildRecurringEmailSection(template) {
  const tableKey = String(template.tableKey ?? "");
  const tabKey = tableKeyToTabKey(tableKey);
  if (!tabKey) throw new Error(`unsupported_table:${tableKey}`);

  const snap = await getTabSnapshot(tabKey);
  const sourceRows = Array.isArray(snap?.rows) ? snap.rows : [];
  if (sourceRows.length === 0) {
    throw new Error(`empty_snapshot:${tabKey}`);
  }

  let rows = applyColumnFilters(sourceRows, template.columnFilters, tableKey);
  rows = sortRows(rows, template);

  const filterKeys = Object.entries(template.columnFilters ?? {}).filter(([, v]) => String(v).trim());
  if (filterKeys.length > 0) {
    console.log(
      `[recurring-email] filter ${template.id} · ${tableKey} source=${sourceRows.length} matched=${rows.length} keys=${filterKeys.map(([k]) => k).join(",")}`
    );
  }

  const totalMatched = rows.length;
  const truncated = totalMatched > MAX_ROWS;
  const slice = rows.slice(0, MAX_ROWS);
  const naraBiz = tableKey.startsWith("bid:") ? tableKey.slice(4) : null;
  const cols = columnsForTableKey(tableKey);
  const headers = ["No", ...cols.map((c) => c.label)];
  const dataRows = buildDataRows(slice, cols, tableKey, naraBiz);

  return {
    templateId: template.id,
    templateName: template.name,
    categoryLabel: CATEGORY_LABELS[tableKey] ?? tableKey,
    headers,
    rows: dataRows,
    totalMatched,
    truncated,
    fetchNote: FETCH_NOTE,
  };
}
