import * as XLSX from "xlsx";

function stampFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function safeSheetName(name, used) {
  let base = String(name ?? "Sheet")
    .replace(/[\\/?*[\]:]/g, "_")
    .slice(0, 28) || "Sheet";
  let out = base;
  let n = 2;
  while (used.has(out)) {
    out = `${base.slice(0, 24)}_${n}`;
    n += 1;
  }
  used.add(out);
  return out;
}

function cellPlain(cell) {
  if (cell == null) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "object") {
    if (cell.linkIcon) return String(cell.linkIconLabel ?? "링크");
    return String(cell.text ?? "");
  }
  return String(cell);
}

function cellHref(cell) {
  if (!cell || typeof cell !== "object") return null;
  const fromLinks = cell.links?.[0]?.href;
  if (fromLinks && /^https?:\/\//i.test(fromLinks)) return fromLinks;
  const href = cell.href;
  return href && /^https?:\/\//i.test(href) ? href : null;
}

function applyRowHyperlinks(ws, rows, headerRowCount = 1) {
  rows.forEach((row, rIdx) => {
    if (!Array.isArray(row)) return;
    row.forEach((cell, cIdx) => {
      const href = cellHref(cell);
      if (!href) return;
      const ref = XLSX.utils.encode_cell({ r: rIdx + headerRowCount, c: cIdx });
      const existing = ws[ref];
      if (existing) {
        const tooltip =
          (typeof cell === "object" && (cell.linkIconLabel || cell.links?.[0]?.text)) || "Nexvia 링크";
        existing.l = { Target: href, Tooltip: String(tooltip) };
      }
    });
  });
}

function sectionToSheet(section) {
  const headers = Array.isArray(section.headers) ? section.headers : [];
  const rows = Array.isArray(section.rows) ? section.rows : [];
  const aoa = [headers, ...rows.map((row) => (Array.isArray(row) ? row.map(cellPlain) : []))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  applyRowHyperlinks(ws, rows, 1);
  ws["!cols"] = headers.map((h) => ({
    wch: Math.min(48, Math.max(10, String(h).length + 4)),
  }));
  return ws;
}

function sectionWorkbookBase64(section) {
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const sheetName = safeSheetName(section.templateName ?? "템플릿", used);
  XLSX.utils.book_append_sheet(wb, sectionToSheet(section), sheetName);
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

/** 템플릿 section 1건당 엑셀 첨부 (즉시 발송·예약 메일 공통) */
export function buildSectionExcelAttachments(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return [];
  const stamp = stampFilename();
  return sections.map((section) => {
    const label =
      String(section.templateName ?? "템플릿")
        .replace(/[^\w\uAC00-\uD7A3.-]+/g, "_")
        .slice(0, 40) || "템플릿";
    return {
      templateId: section.templateId,
      filename: `${label}_${stamp}.xlsx`,
      contentBase64: sectionWorkbookBase64(section),
    };
  });
}
