/** 메일 HTML 디버그 — Railway 로그에서 [email-html] [email-content] 검색 */

const SUSPICIOUS_TEXT_RE = /<(?:a|td|tr|table|div|span|th)\b|style\s*=/i;
const MAX_ISSUE_LOG = 20;
const LOG_CHUNK_SIZE = 3500;
const PREVIEW_HTML_LEN = 4000;
const PREVIEW_TEXT_LEN = 2500;
const CELL_TEXT_LOG_LEN = 100;
const HREF_PREVIEW_LEN = 100;

export function isEmailHtmlDebugVerbose() {
  const v = String(process.env.EMAIL_HTML_DEBUG ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** EMAIL_CONTENT_LOG=1 — 본문 전체(HTML 청크) 강제 출력 */
export function isEmailContentLogFull() {
  if (isEmailHtmlDebugVerbose()) return true;
  const v = String(process.env.EMAIL_CONTENT_LOG ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function truncate(s, max = 180) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…(+${t.length - max}자)`;
}

function cellForLog(cell) {
  if (cell != null && typeof cell === "object" && !Array.isArray(cell)) {
    const text = truncate(cell.text ?? "", CELL_TEXT_LOG_LEN);
    const href = cell.href ? String(cell.href) : "";
    const links = Array.isArray(cell.links) ? cell.links.length : 0;
    const parts = [text];
    if (href) {
      parts.push(`href(${href.length})=${truncate(href, HREF_PREVIEW_LEN)}`);
    }
    if (links) parts.push(`links=${links}`);
    if (cell.linkIcon) parts.push("linkIcon");
    return parts.join(" ");
  }
  return truncate(cell, CELL_TEXT_LOG_LEN);
}

/** 발송 데이터 — 행·셀 내용 (Railway [email-content] 검색) */
export function logEmailSectionsContent(tag, sections) {
  console.log(`[email-content][${tag}] ═══ 발송 sections 셀 데이터 ═══`);
  for (const sec of sections ?? []) {
    const headers = Array.isArray(sec.headers) ? sec.headers : [];
    const rows = Array.isArray(sec.rows) ? sec.rows : [];
    console.log(
      `[email-content][${tag}] templateId=${sec.templateId ?? "—"} name=${sec.templateName ?? "—"} category=${sec.categoryLabel ?? "—"} rows=${rows.length} totalMatched=${sec.totalMatched ?? "—"}`
    );
    if (headers.length) {
      console.log(`[email-content][${tag}]   headers: ${headers.join(" | ")}`);
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const cells = headers.map((h, ci) => `${h}«${cellForLog(row[ci])}»`);
      console.log(`[email-content][${tag}]   row ${String(i + 1).padStart(3, "0")}: ${cells.join(" | ")}`);
    }
  }
  console.log(`[email-content][${tag}] ═══ sections 끝 ═══`);
}

function logBodyChunks(label, body, { forceFull = false, previewLen = PREVIEW_HTML_LEN } = {}) {
  const s = String(body ?? "");
  if (!s) {
    console.log(`[email-content][${label}] (비어 있음)`);
    return;
  }
  const full = forceFull || isEmailContentLogFull();
  if (!full && s.length > previewLen) {
    console.log(`[email-content][${label}] preview ${previewLen}/${s.length}자\n${s.slice(0, previewLen)}`);
    console.log(
      `[email-content][${label}] …중략 (${s.length - previewLen}자) — 전체 보려면 Railway env EMAIL_CONTENT_LOG=1 또는 EMAIL_HTML_DEBUG=1`
    );
    return;
  }
  const total = Math.max(1, Math.ceil(s.length / LOG_CHUNK_SIZE));
  for (let i = 0; i < total; i++) {
    const part = s.slice(i * LOG_CHUNK_SIZE, (i + 1) * LOG_CHUNK_SIZE);
    console.log(`[email-content][${label}] part ${i + 1}/${total} (${s.length}자)\n${part}`);
  }
}

/**
 * 실제 메일 본문 — 제목·plain·html (발송 직전)
 * @param {string} tag
 * @param {{ subject?: string, text?: string, html?: string }} content
 * @param {object[]} [sections]
 * @param {{ to?: string }} [meta]
 */
export function logEmailMailContent(tag, content, sections, meta = {}) {
  const subject = String(content?.subject ?? "").trim();
  console.log(`[email-content][${tag}] ─── 메일 발송 본문 ───${meta.to ? ` to=${meta.to}` : ""}`);
  console.log(`[email-content][${tag}] subject: ${subject || "(없음)"}`);

  if (sections?.length) {
    logEmailSectionsContent(tag, sections);
  }

  console.log(`[email-content][${tag}] ─── plain text 본문 ───`);
  logBodyChunks(`${tag}:text`, content?.text, {
    forceFull: isEmailContentLogFull(),
    previewLen: PREVIEW_TEXT_LEN,
  });

  console.log(`[email-content][${tag}] ─── HTML 본문 ───`);
  logBodyChunks(`${tag}:html`, content?.html, {
    forceFull: isEmailContentLogFull(),
    previewLen: PREVIEW_HTML_LEN,
  });

  console.log(`[email-content][${tag}] ─── 메일 본문 로그 끝 ───`);
}

function rowCount(sections) {
  return (sections ?? []).reduce((n, s) => n + (Array.isArray(s?.rows) ? s.rows.length : 0), 0);
}

/** sections payload — 수신·정제 후 공통 스캔 */
export function scanSectionsForEmailIssues(sections, { phase = "unknown" } = {}) {
  const issues = [];
  for (const section of sections ?? []) {
    const headers = Array.isArray(section.headers) ? section.headers : [];
    const rows = Array.isArray(section.rows) ? section.rows : [];
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      if (!Array.isArray(row)) continue;
      for (let ci = 0; ci < row.length; ci++) {
        const cell = row[ci];
        const col = String(headers[ci] ?? `col${ci}`);
        const isObj = cell != null && typeof cell === "object" && !Array.isArray(cell);
        const textStr = String(isObj ? cell.text ?? "" : cell ?? "");
        const hrefStr = isObj && cell.href ? String(cell.href) : "";
        const linkCount = isObj && Array.isArray(cell.links) ? cell.links.length : 0;

        if (textStr && SUSPICIOUS_TEXT_RE.test(textStr)) {
          issues.push({
            type: "html_in_cell_text",
            phase,
            templateId: section.templateId,
            templateName: section.templateName,
            row: ri + 1,
            col,
            textLen: textStr.length,
            sample: truncate(textStr),
          });
        }

        if (hrefStr.length > 2000) {
          issues.push({
            type: "long_href",
            phase,
            templateId: section.templateId,
            templateName: section.templateName,
            row: ri + 1,
            col,
            hrefLen: hrefStr.length,
            hasOsnap: /[?&]osnap=/i.test(hrefStr),
            sample: truncate(hrefStr, 120),
          });
        }

        if (linkCount > 0 && isEmailHtmlDebugVerbose()) {
          for (const link of cell.links.slice(0, 3)) {
            const lh = String(link?.href ?? "").length;
            if (lh > 2000) {
              issues.push({
                type: "long_link_in_links",
                phase,
                templateId: section.templateId,
                row: ri + 1,
                col,
                hrefLen: lh,
                sample: truncate(link?.href, 120),
              });
            }
          }
        }
      }
    }
  }
  return issues;
}

/** 생성된 HTML 구조 점검 */
export function analyzeEmailHtml(html) {
  const h = String(html ?? "");
  const openTd = (h.match(/<td[\s>/]/gi) || []).length;
  const closeTd = (h.match(/<\/td>/gi) || []).length;
  const openA = (h.match(/<a[\s>/]/gi) || []).length;
  const closeA = (h.match(/<\/a>/gi) || []).length;
  const escapedLeak = h.includes("&lt;a ") || h.includes("&lt;td ") || h.includes("&lt;tr ");
  const rawTdStyleText = />\s*<td\s+style=/i.test(h);
  const longestHrefMatch = h.match(/href="([^"]{500,})"/);
  return {
    htmlLen: h.length,
    openTd,
    closeTd,
    tdBalanced: openTd === closeTd,
    openA,
    closeA,
    aBalanced: openA === closeA,
    escapedLeak,
    rawTdStyleText,
    longestHrefLen: longestHrefMatch ? longestHrefMatch[1].length : 0,
  };
}

function logIssues(tag, issues) {
  if (!issues.length) return;
  const head = issues.slice(0, MAX_ISSUE_LOG);
  console.warn(`[email-html][${tag}] 의심 셀 ${issues.length}건`, JSON.stringify(head, null, 0));
  if (issues.length > MAX_ISSUE_LOG) {
    console.warn(`[email-html][${tag}] …외 ${issues.length - MAX_ISSUE_LOG}건 (EMAIL_HTML_DEBUG=1 시 상세)`);
  }
}

/**
 * @param {string} tag — send-email | scheduled | recurring
 * @param {object[]} sections
 * @param {string} [html]
 * @param {{ phase?: string, to?: string }} [meta]
 */
export function logEmailHtmlDebug(tag, sections, html, meta = {}) {
  const phase = meta.phase ?? "send";
  const templates = sections?.length ?? 0;
  const rows = rowCount(sections);
  const analysis = html ? analyzeEmailHtml(html) : null;

  console.log(
    `[email-html][${tag}] phase=${phase} templates=${templates} rows=${rows}` +
      (analysis ? ` htmlLen=${analysis.htmlLen} td=${analysis.openTd}/${analysis.closeTd} a=${analysis.openA}/${analysis.closeA}` : "") +
      (meta.to ? ` to=${meta.to}` : "")
  );

  const issues = scanSectionsForEmailIssues(sections, { phase });
  logIssues(tag, issues);

  if (analysis) {
    if (!analysis.tdBalanced) {
      console.warn(
        `[email-html][${tag}] ⚠ TD 태그 불균형 — open=${analysis.openTd} close=${analysis.closeTd} (표 깨짐·<td style= 노출 원인)`
      );
    }
    if (!analysis.aBalanced) {
      console.warn(`[email-html][${tag}] ⚠ A 태그 불균형 — open=${analysis.openA} close=${analysis.closeA}`);
    }
    if (analysis.escapedLeak) {
      console.warn(
        `[email-html][${tag}] ⚠ 본문에 &lt;a / &lt;td 이스케이프 잔존 — 셀 text에 HTML 조각이 들어온 경우`
      );
    }
    if (analysis.rawTdStyleText) {
      console.warn(`[email-html][${tag}] ⚠ 본문에 raw <td style= 텍스트 패턴 감지`);
    }
    if (analysis.longestHrefLen > 3000) {
      console.warn(
        `[email-html][${tag}] ⚠ 초장문 href ${analysis.longestHrefLen}자 — 메일 클라이언트에서 HTML 깨질 수 있음 (osnap URL)`
      );
    }
  }

  if (isEmailHtmlDebugVerbose()) {
    for (const section of sections ?? []) {
      console.log(
        `[email-html][${tag}] section templateId=${section.templateId} name=${truncate(section.templateName, 60)} category=${truncate(section.categoryLabel, 40)} rows=${section.rows?.length ?? 0}`
      );
    }
    if (html) {
      const idx = html.indexOf("&lt;a ");
      if (idx >= 0) {
        console.log(`[email-html][${tag}] escaped &lt;a 주변:`, truncate(html.slice(Math.max(0, idx - 40), idx + 200), 240));
      }
    }
  }
}
