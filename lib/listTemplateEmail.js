import { isEmailConfigured, getTransporter } from "./mail.js";
import {
  buildSupplementaryLinkIconHtml,
  SUP_LINK_ICON_DEFAULT_LABEL,
} from "./supplementaryLinkIcon.js";
import { shortenEmailHref } from "./listTemplateEmailHref.js";

function trimEmailHref(hrefRaw) {
  return shortenEmailHref(hrefRaw);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function decodeBasicEntities(s) {
  return String(s ?? "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** 메일 셀 — HTML·깨진 태그 조각 제거 (본문에 <td style=… 노출 방지) */
function cleanCellText(raw) {
  let s = decodeBasicEntities(raw);
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  for (let pass = 0; pass < 6; pass++) {
    const next = s
      .replace(/<[^>]+>/g, " ")
      .replace(/<\/?[a-zA-Z][\w:-]*(?:\s+[^<>\n]*)?>/g, " ");
    if (next === s) break;
    s = next;
  }
  s = s
    .replace(/<\/?[a-zA-Z][^>\n]*/g, " ")
    .replace(/\b(?:style|class|id|width|height|align|valign|bgcolor|cellpadding|cellspacing|border|colspan|rowspan)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/<[a-z!/]/i.test(s)) {
    s = s.replace(/<[^>]*>?/gi, " ").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
  }
  return s;
}

/** 셀 text에 <a href=…> 전체가 문자열로 들어온 경우 */
function extractAnchorFromText(raw) {
  const s = decodeBasicEntities(String(raw ?? "").trim());
  if (!/<a\b/i.test(s)) return null;
  const closed = s.match(/<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  if (closed) return { href: closed[1], text: closed[2] };
  const open = s.match(/<a\s+[^>]*href\s*=\s*["']([^"']+)/i);
  if (open) return { href: open[1], text: s.replace(/<a\b[\s\S]*/i, "").trim() };
  return null;
}

function normalizeCell(raw) {
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const anchorInText = extractAnchorFromText(raw.text);
    let text = cleanCellText(raw.text);
    let hrefFromText = anchorInText ? shortenEmailHref(anchorInText.href) : null;
    if (anchorInText) {
      const parsedText = cleanCellText(anchorInText.text);
      if (parsedText) text = parsedText;
    }
    const links = Array.isArray(raw.links)
      ? raw.links
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const linkText = cleanCellText(item.text);
            const hrefRaw = String(item.href ?? "").trim();
            const href = trimEmailHref(hrefRaw);
            if (!linkText || !href) return null;
            return { text: linkText, href };
          })
          .filter(Boolean)
          .slice(0, 20)
      : [];
    if (links.length > 0) {
      return { text: links.map((l) => l.text).join("\n"), links };
    }
    const hrefRaw = String(raw.href ?? hrefFromText ?? "").trim();
    const href = trimEmailHref(hrefRaw) || hrefFromText;
    const linkIcon = raw.linkIcon === true;
    const linkIconLabel = cleanCellText(raw.linkIconLabel ?? text ?? SUP_LINK_ICON_DEFAULT_LABEL);
    if (href && linkIcon) return { text, href, linkIcon: true, linkIconLabel };
    return href ? { text, href } : { text };
  }
  const anchor = extractAnchorFromText(raw);
  if (anchor) {
    const href = shortenEmailHref(anchor.href);
    const text = cleanCellText(anchor.text) || cleanCellText(raw);
    return href ? { text: text || href, href } : { text };
  }
  return { text: cleanCellText(raw), href: null };
}

function isTitleColumnHeader(label) {
  return /공고명|지원사업명|품명|물품명|행사명|교육명|제목|pblanc/i.test(String(label ?? ""));
}

/** Gmail — 행당 `<a>` 1개(공고명만)·나머지는 텍스트로 HTML 절감·클립 시 행 중간 깨짐 완화 */
function renderEmailCell(cell, headerLabel) {
  const norm = normalizeCell(cell);
  if (norm.linkIcon && norm.href) {
    return buildSupplementaryLinkIconHtml(norm.href, norm.linkIconLabel || SUP_LINK_ICON_DEFAULT_LABEL);
  }
  if (norm.links?.length) {
    return norm.links.map((l) => escapeHtml(l.text)).join("<br />");
  }
  if (isTitleColumnHeader(headerLabel) && norm.href) {
    const label = escapeHtml(norm.text);
    const safeHref = escapeAttr(norm.href);
    return `<a href="${safeHref}">${label.length > 0 ? label : "—"}</a>`;
  }
  const text = escapeHtml(norm.text).replace(/\n/g, "<br />");
  return text.length > 0 ? text : "—";
}

function cellPlainText(cell) {
  const norm = normalizeCell(cell);
  if (norm.links?.length) {
    return norm.links.map((l) => `${l.text} (${l.href})`).join("\n");
  }
  if (norm.linkIcon && norm.href) {
    const label = norm.linkIconLabel || SUP_LINK_ICON_DEFAULT_LABEL;
    return `${label} (${norm.href})`;
  }
  return norm.href ? `${norm.text} (${norm.href})` : norm.text;
}

/** 필터 결과 0건 — 메일 본문 안내 (즉시·예약·매일 반복 공통) */
export const NO_FILTER_MATCH_MESSAGE =
  "현재 요청하신 필터조건으로는 검색되는 것이 없습니다.";

/** 메일 공통 CSS — font-family는 head <style>에만 (인라인 style="" 안 따옴표 깨짐 방지) */
const EMAIL_HEAD_STYLES = `
body{margin:0;padding:20px 18px;font-family:'Segoe UI','Malgun Gothic','Hanken Grotesk',system-ui,sans-serif;color:#1a2332;font-size:13px;line-height:1.5;background:#f8f9fc;}
.nx-email-wrap{max-width:100%;margin:0 auto;background:#fff;border:1px solid #c5c6ce;border-radius:12px;padding:18px 20px;box-sizing:border-box;}
.nx-email-h1{margin:0 0 6px;font-size:18px;font-weight:700;color:#1b2b48;}
.nx-email-lead{margin:0 0 8px;font-size:13px;color:#5c6778;}
.nx-email-note{margin:0 0 14px;font-size:13px;color:#44474d;white-space:pre-wrap;line-height:1.5;}
.nx-email-foot{margin:20px 0 0;font-size:11px;color:#9ca3af;}
.nx-email-section{margin:0 0 20px;padding:14px 16px;border:1px solid #e4e9ef;border-radius:10px;background:#fff;}
.nx-email-section-title{margin:0 0 6px;font-size:15px;font-weight:700;color:#1b2b48;}
.nx-email-section-meta{margin:0 0 12px;font-size:12px;line-height:1.45;color:#5c6778;}
.nx-email-scroll{max-width:100%;overflow-x:auto;}
.nx-email-table{border-collapse:collapse;font-size:13px;}
.nx-email-wrap a{color:#4a5f85;font-weight:600;text-decoration:underline;word-wrap:break-word;}
`.trim();

const EMAIL_WRAP_BORDER = "#c5d4e8";
const EMAIL_CELL_BORDER = "#cdd8ea";
const EMAIL_TH_BG = "#d8e4f8";
const EMAIL_TH_COLOR = "#2a4068";
const EMAIL_TH_BORDER = "#b5c9e4";
const EMAIL_TH_ACCENT = "#6b87c4";
const EMAIL_ROW_EVEN = "#f2f6fc";
const EMAIL_LINK_COLOR = "#4a5f85";
const EMAIL_TEXT = "#1a2332";
const EMAIL_MUTED = "#5c6778";

function colSpecForHeader(label) {
  const h = String(label ?? "");
  if (/^No$/i.test(h)) return { min: 52, align: "center", nowrap: true };
  if (/공고명|지원사업명|품명|물품명|행사명|교육명|제목|pblanc/i.test(h)) {
    return { min: 300, align: "left", title: true };
  }
  if (/공고번호|사전규격|등록번호|번호/.test(h)) return { min: 118, align: "center" };
  if (/마감|개찰|접수|게시|날짜|일시|기간|Dt|dt/.test(h)) return { min: 132, align: "center" };
  if (/금액|예산|가격|Amt|amt/.test(h)) return { min: 108, align: "right" };
  if (/업종|분류|지역|Div/.test(h)) return { min: 148, align: "left" };
  if (/기관|주관|출처|Instt|instt/.test(h)) return { min: 168, align: "left" };
  if (/원문\s*보기|첨부파일/.test(h)) return { min: 64, align: "center", nowrap: true };
  return { min: 112, align: "left" };
}

function htmlAlign(spec) {
  return spec.align === "right" ? "right" : spec.align === "center" ? "center" : "left";
}

function sectionHasNoFilterMatch(section) {
  return Number(section?.totalMatched ?? section?.rows?.length ?? 0) === 0;
}

/** Gmail — 본문 HTML이 너무 크면 ~102KB 부근에서 끊겨 행 중간부터 열이 비어 보임 */
export const MAX_EMAIL_HTML_BODY_ROWS = Math.max(
  10,
  Math.min(120, Number(process.env.EMAIL_HTML_MAX_ROWS) || 50)
);

/** Gmail HTML 클립 안전 상한(문자 수) — 초과 시 표 중간에서 잘림 */
export const GMAIL_SAFE_HTML_CHARS = Math.max(
  50_000,
  Math.min(100_000, Number(process.env.EMAIL_HTML_SAFE_CHARS) || 96_000)
);

/** 복수 템플릿(섹션) 발송 시 섹션당 본문 표 행 상한 — 4×50행이면 ~100KB에서 23행째부터 깨짐 */
export const MULTI_SECTION_HTML_ROWS_EACH = Math.max(
  8,
  Math.min(40, Number(process.env.EMAIL_HTML_MULTI_SECTION_ROWS) || 18)
);

function htmlBodyRowCap(sectionCount) {
  if (sectionCount <= 1) return MAX_EMAIL_HTML_BODY_ROWS;
  return Math.min(MAX_EMAIL_HTML_BODY_ROWS, MULTI_SECTION_HTML_ROWS_EACH);
}

const EMAIL_HTML_ROW_LIMIT_NOTICE =
  "메일 본문 표는 일부만 표시합니다. 전체 목록은 첨부 엑셀을 확인해 주세요.";

function rowsForEmailBody(section, sectionCount = 1) {
  const headers = section.headers ?? [];
  let all = displayRows(headers, section.rows);
  const matched = Number(section?.totalMatched ?? 0);
  if (all.length === 0 && matched > 0 && Array.isArray(section.rows) && section.rows.length > 0) {
    all = section.rows.filter((row) => Array.isArray(row) && row.length > 0);
  }
  const cap = htmlBodyRowCap(sectionCount);
  if (all.length <= cap) {
    return { rows: all, bodyTruncated: false, totalVisible: all.length, rowCap: cap };
  }
  return {
    rows: all.slice(0, cap),
    bodyTruncated: true,
    totalVisible: all.length,
    rowCap: cap,
  };
}

function buildHtmlRowLimitNoticeHtml(shown, total) {
  return `<p style="margin:12px 0 0;padding:12px 14px;border-radius:8px;background:#f3f4f8;border:1px solid #e4e9ef;font-size:13px;line-height:1.5;color:#5c6778;">${escapeHtml(EMAIL_HTML_ROW_LIMIT_NOTICE)} (${shown.toLocaleString("ko-KR")}/${total.toLocaleString("ko-KR")}행)</p>`;
}

function buildNoFilterMatchNoticeHtml() {
  return `<p style="margin:12px 0 0;padding:14px 16px;border-radius:10px;background:#f3f4f8;border:1px solid #e4e9ef;font-size:14px;line-height:1.5;color:#5c6778;">${escapeHtml(NO_FILTER_MATCH_MESSAGE)}</p>`;
}

function buildNoFilterMatchPlainText() {
  return `\n${NO_FILTER_MATCH_MESSAGE}\n`;
}

function padRowCells(cells, colCount) {
  const out = Array.isArray(cells) ? [...cells] : [];
  while (out.length < colCount) out.push({ text: "" });
  return out.slice(0, colCount);
}

function isEmptyDisplayValue(text) {
  const t = cleanCellText(text);
  return !t || t === "-" || t === "—";
}

function cellHasDisplayValue(cell) {
  const norm = normalizeCell(cell);
  if (norm.links?.length) return true;
  if (norm.href && !isEmptyDisplayValue(norm.text)) return true;
  return !isEmptyDisplayValue(norm.text);
}

function displayRows(headers, rows) {
  const noIndex = headers.findIndex((h) => /^No$/i.test(String(h ?? "").trim()));
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const cells = padRowCells(row, headers.length);
    return cells.some((cell, idx) => idx !== noIndex && cellHasDisplayValue(cell));
  });
}

function buildTableRowHtml(cells, rowIdx, headers, specs, colCount) {
  return `<tr>${padRowCells(cells, colCount)
    .map((c, i) => {
      const spec = specs[i];
      const inner = renderEmailCell(c, headers[i]);
      const bg = rowIdx % 2 === 1 ? EMAIL_ROW_EVEN : "#ffffff";
      return `<td bgcolor="${bg}" align="${htmlAlign(spec)}">${inner}</td>`;
    })
    .join("")}</tr>`;
}

function buildDataTableHtml(headers, rows, { maxChars } = {}) {
  const colCount = headers.length;
  const specs = headers.map((h) => colSpecForHeader(h));
  const tableMinWidth = specs.reduce((sum, s) => sum + s.min, 48);

  const head = headers
    .map(
      (h, i) =>
        `<th bgcolor="${EMAIL_TH_BG}" align="${htmlAlign(specs[i])}" valign="middle" width="${specs[i].min}">${escapeHtml(h)}</th>`
    )
    .join("");

  const bodyParts = [];
  let charsUsed = 0;
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const rowHtml = buildTableRowHtml(rows[rowIdx], rowIdx, headers, specs, colCount);
    if (maxChars != null && charsUsed > 0 && charsUsed + rowHtml.length > maxChars) {
      break;
    }
    bodyParts.push(rowHtml);
    charsUsed += rowHtml.length;
  }

  return {
    html: `<div class="nx-email-scroll">
    <table class="nx-email-table" cellpadding="6" cellspacing="0" border="1" width="100%" style="min-width:${tableMinWidth}px;">
      <thead><tr>${head}</tr></thead>
      <tbody>${bodyParts.join("")}</tbody>
    </table>
</div>`,
    rowsShown: bodyParts.length,
    budgetTruncated: bodyParts.length < rows.length,
  };
}

function buildSectionHtml(section, sectionCount = 1, { htmlBudgetRemaining } = {}) {
  const empty = sectionHasNoFilterMatch(section);
  const { rows, bodyTruncated, totalVisible, rowCap } = rowsForEmailBody(section, sectionCount);
  const countLabel = empty
    ? "0건"
    : section.truncated
      ? `${section.totalMatched.toLocaleString("ko-KR")}건 중 ${totalVisible.toLocaleString("ko-KR")}건`
      : `${section.totalMatched.toLocaleString("ko-KR")}건`;
  const bodyLimitNote = bodyTruncated
    ? ` · 메일 본문 ${rows.length.toLocaleString("ko-KR")}행만 표시(템플릿당 최대 ${rowCap}행)`
    : sectionCount > 1
      ? ` · 메일 본문 최대 ${rowCap}행`
      : "";

  const title = `${section.categoryLabel} · ${section.templateName}`;

  let tableBlock = "";
  let tableChars = 0;
  let shownRows = 0;
  let budgetTruncated = false;
  if (!empty && rows.length > 0) {
    const built = buildDataTableHtml(section.headers, rows, {
      maxChars: htmlBudgetRemaining,
    });
    tableBlock = built.html;
    tableChars = built.html.length;
    shownRows = built.rowsShown;
    budgetTruncated = built.budgetTruncated;
  }

  const limitNotice =
    bodyTruncated || budgetTruncated
      ? buildHtmlRowLimitNoticeHtml(shownRows || rows.length, totalVisible)
      : "";

  return {
    html: `<div class="nx-email-section">
    <p class="nx-email-section-title">${escapeHtml(title)}</p>
    <p class="nx-email-section-meta">${countLabel}${bodyLimitNote}${section.fetchNote ? ` · ${escapeHtml(section.fetchNote)}` : ""}</p>
    ${empty ? buildNoFilterMatchNoticeHtml() : rows.length === 0 ? `<p class="nx-email-section-meta" style="margin-top:8px;">${escapeHtml("조회된 건수는 있으나 본문 표를 구성하지 못했습니다. 첨부 엑셀을 확인해 주세요.")}</p>` : `${tableBlock}${limitNotice}`}
  </div>`,
    tableChars,
  };
}

function buildTemplateSectionsHtml(sections) {
  const sectionCount = sections.length;
  const shellReserve = 14_000;
  let budgetLeft = Math.max(20_000, GMAIL_SAFE_HTML_CHARS - shellReserve);
  const parts = [];
  for (const s of sections) {
    const built = buildSectionHtml(s, sectionCount, { htmlBudgetRemaining: budgetLeft });
    parts.push(built.html);
    budgetLeft = Math.max(0, budgetLeft - built.tableChars);
  }
  return parts.join("");
}

function buildPlainTextForSection(section, sectionCount = 1) {
  const lines = [`Nexvia · ${section.templateName}`, ""];
  const { rows, bodyTruncated, totalVisible } = rowsForEmailBody(section, sectionCount);
  lines.push(`[${section.categoryLabel}] — ${sectionHasNoFilterMatch(section) ? 0 : section.totalMatched}건`);
  if (section.fetchNote) lines.push(`(${section.fetchNote})`);
  if (sectionHasNoFilterMatch(section)) {
    lines.push(buildNoFilterMatchPlainText().trim());
  } else if (rows.length === 0) {
    lines.push("조회된 건수는 있으나 본문 표를 구성하지 못했습니다. 첨부 엑셀을 확인해 주세요.");
  } else {
    lines.push(section.headers.join(" | "));
    for (const row of rows) {
      const cells = row.map((c) => cellPlainText(c));
      lines.push(cells.join(" | "));
    }
    if (bodyTruncated) {
      lines.push(`… 메일 본문 ${rows.length}/${totalVisible}행 · 전체는 엑셀 참고`);
    }
  }
  return lines.join("\n");
}

function buildPlainText(sections) {
  const lines = ["Nexvia · 템플릿 검색 결과", ""];
  const sectionCount = sections.length;
  for (const s of sections) {
    const { rows, bodyTruncated, totalVisible } = rowsForEmailBody(s, sectionCount);
    lines.push(`[${s.categoryLabel}] ${s.templateName} — ${sectionHasNoFilterMatch(s) ? 0 : s.totalMatched}건`);
    if (s.fetchNote) lines.push(`  (${s.fetchNote})`);
    if (sectionHasNoFilterMatch(s) || rows.length === 0) {
      lines.push(`  ${NO_FILTER_MATCH_MESSAGE}`);
    } else {
      lines.push(`  ${s.headers.join(" | ")}`);
      for (const row of rows) {
        const cells = row.map((c) => cellPlainText(c));
        lines.push(`  ${cells.join(" | ")}`);
      }
      if (bodyTruncated) {
        lines.push(`  … 메일 본문 ${rows.length}/${totalVisible}행 · 전체는 엑셀 참고`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function emailSubjectDateSuffix(date = new Date(), timezone = "Asia/Seoul") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "00";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}${m}${d}`;
}

function buildListTemplateEmailSubject(section, sentAt = new Date()) {
  const name = String(section.templateName ?? "").trim() || "템플릿 검색 결과";
  const suffix = emailSubjectDateSuffix(sentAt);
  return `[Nexvia] ${name} ${suffix}`.slice(0, 200);
}

function emailHtmlShell(bodyInner) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${EMAIL_HEAD_STYLES}</style>
</head>
<body>
<div class="nx-email-wrap">
${bodyInner}
</div>
</body>
</html>`;
}

export function buildSingleSectionEmailContent(section, { note = "" } = {}) {
  const subject = buildListTemplateEmailSubject(section);
  const html = emailHtmlShell(`
    <p class="nx-email-h1">Nexvia · 템플릿 검색 결과</p>
    ${note ? `<p class="nx-email-note">${escapeHtml(note)}</p>` : ""}
    ${buildTemplateSectionsHtml([section])}
    <p class="nx-email-foot">본 메일은 Nexvia에서 발송되었습니다.</p>
  `);
  const text = `${buildPlainTextForSection(section)}${note ? `\n\n메모:\n${note}\n` : ""}`;
  return { subject, html, text };
}

export function buildListTemplateEmailContent(sections, { note = "" } = {}) {
  const sectionCount = sections.length;
  const rowTotal = sections.reduce((n, s) => n + s.rows.length, 0);
  const sentAt = new Date();
  const suffix = emailSubjectDateSuffix(sentAt);
  const subject = `[Nexvia] 템플릿 검색 결과 ${sectionCount}건 (${rowTotal}행) ${suffix}`;
  const perSectionCap = htmlBodyRowCap(sectionCount);
  const multiNote =
    sectionCount > 1
      ? ` · 복수 템플릿은 Gmail 용량 제한으로 본문 표 템플릿당 최대 ${perSectionCap}행`
      : "";

  const html = emailHtmlShell(`
    <p class="nx-email-h1">Nexvia · 템플릿 검색 결과</p>
    <p class="nx-email-lead">선택한 발송 목록 ${sectionCount}건 · 템플릿별로 구분해 표시합니다. (본문 표는 템플릿당 최대 ${perSectionCap}행${multiNote})</p>
    <p class="nx-email-lead" style="margin-bottom:16px;">상세 데이터는 첨부 엑셀 파일을 이용해 주세요.</p>
    ${note ? `<p class="nx-email-note">${escapeHtml(note)}</p>` : ""}
    ${buildTemplateSectionsHtml(sections)}
    <p class="nx-email-foot">본 메일은 Nexvia에서 발송되었습니다.</p>
  `);
  const text = `${buildPlainText(sections)}${note ? `\n메모:\n${note}\n` : ""}`;
  return { subject, html, text };
}

export async function sendListTemplateEmail({ to, sections, note = "", attachments = [] }) {
  if (!isEmailConfigured()) {
    throw new Error("EMAIL_NOT_CONFIGURED");
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("NO_SECTIONS");
  }

  const transporter = await getTransporter();
  const toAddr = Array.isArray(to) ? to.join(", ") : to;
  const allAttachments = Array.isArray(attachments) ? attachments : [];

  const content =
    sections.length === 1
      ? buildSingleSectionEmailContent(sections[0], { note })
      : buildListTemplateEmailContent(sections, { note });

  const hasPerTemplateAttachments = allAttachments.some((a) => a?.templateId);
  let sectionAttachments = allAttachments;
  if (hasPerTemplateAttachments) {
    const ids = new Set(sections.map((s) => String(s.templateId)));
    sectionAttachments = allAttachments.filter(
      (a) => a?.templateId && ids.has(String(a.templateId))
    );
  }

  const mailAttachments = sectionAttachments
    .filter((a) => a?.contentBase64 && a?.filename)
    .slice(0, 10)
    .map((a) => ({
      filename: String(a.filename).slice(0, 120),
      content: Buffer.from(String(a.contentBase64), "base64"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));

  await transporter.sendMail({
    from: `"Nexvia" <${process.env.EMAIL_USER.trim()}>`,
    to: toAddr,
    subject: content.subject,
    text: content.text,
    html: content.html,
    attachments: mailAttachments,
  });
}
