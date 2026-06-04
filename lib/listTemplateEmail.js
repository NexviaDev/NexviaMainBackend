import { isEmailConfigured, getTransporter } from "./mail.js";
import {
  buildSupplementaryLinkIconHtml,
  SUP_LINK_ICON_DEFAULT_LABEL,
} from "./supplementaryLinkIcon.js";

/** listTemplates.js sanitize 와 동일 — osnap/psnap URL 보존 */
const MAX_EMAIL_LINK_LEN = 8192;

function trimEmailHref(hrefRaw) {
  const href = String(hrefRaw ?? "").trim();
  if (!href || !/^https?:\/\//i.test(href)) return null;
  return href.slice(0, MAX_EMAIL_LINK_LEN);
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

function normalizeCell(raw) {
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const text = String(raw.text ?? "").trim();
    const links = Array.isArray(raw.links)
      ? raw.links
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const linkText = String(item.text ?? "").trim();
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
    const hrefRaw = String(raw.href ?? "").trim();
    const href = trimEmailHref(hrefRaw);
    const linkIcon = raw.linkIcon === true;
    const linkIconLabel = String(raw.linkIconLabel ?? text ?? SUP_LINK_ICON_DEFAULT_LABEL).trim();
    if (href && linkIcon) return { text, href, linkIcon: true, linkIconLabel };
    return href ? { text, href } : { text };
  }
  return { text: String(raw ?? ""), href: null };
}

function renderCell(cell) {
  const norm = normalizeCell(cell);
  if (norm.linkIcon && norm.href) {
    return buildSupplementaryLinkIconHtml(norm.href, norm.linkIconLabel || SUP_LINK_ICON_DEFAULT_LABEL);
  }
  if (norm.links?.length) {
    return norm.links
      .map(
        (l) =>
          `<a href="${escapeAttr(l.href)}" target="_blank" rel="noopener noreferrer" style="color:#4a6fa5;text-decoration:underline;">${escapeHtml(l.text)}</a>`
      )
      .join("<br />");
  }
  if (norm.href) {
    const label = escapeHtml(norm.text);
    const isEmojiLink = norm.text === "🌐" || norm.text === "🔗";
    const linkStyle = isEmojiLink
      ? "font-size:20px;line-height:1.2;text-decoration:none;color:#4a6fa5;"
      : "color:#4a6fa5;text-decoration:underline;";
    return `<a href="${escapeAttr(norm.href)}" target="_blank" rel="noopener noreferrer" style="${linkStyle}">${label.length > 0 ? label : "&#160;"}</a>`;
  }
  const text = escapeHtml(norm.text).replace(/\n/g, "<br />");
  return text.length > 0 ? text : "&#160;";
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

const CELL_STYLE =
  "padding:6px 8px;border:1px solid #d0d0d0;vertical-align:top;font-size:12px;line-height:1.45;mso-line-height-rule:exactly;";
const TH_STYLE = `${CELL_STYLE}background:#f0f1f3;font-weight:700;white-space:nowrap;`;

function thStyleForHeader(label) {
  const h = String(label ?? "");
  if (/행사명|교육명|공고명|지원사업명|품명/.test(h)) {
    return `${TH_STYLE}min-width:220px;max-width:360px;white-space:normal;`;
  }
  if (/원문\s*보기|첨부파일/.test(h)) {
    return `${TH_STYLE}width:52px;text-align:center;`;
  }
  return TH_STYLE;
}

function tdStyleForHeader(label) {
  const h = String(label ?? "");
  if (/행사명|교육명|공고명|지원사업명|품명/.test(h)) {
    return `${CELL_STYLE}min-width:220px;max-width:360px;white-space:normal;word-break:break-word;`;
  }
  if (/원문\s*보기|첨부파일/.test(h)) {
    return `${CELL_STYLE}text-align:center;width:52px;`;
  }
  return CELL_STYLE;
}

function padRowCells(cells, colCount) {
  const out = Array.isArray(cells) ? [...cells] : [];
  while (out.length < colCount) out.push({ text: "" });
  return out.slice(0, colCount);
}

function buildDataTableHtml(headers, rows) {
  const colCount = headers.length;
  const head = headers
    .map((h) => `<th style="${thStyleForHeader(h)}" border="1">${escapeHtml(h)}</th>`)
    .join("");

  const body = rows
    .map(
      (cells) =>
        `<tr>${padRowCells(cells, colCount)
          .map((c, i) => `<td style="${tdStyleForHeader(headers[i])}" border="1">${renderCell(c)}</td>`)
          .join("")}</tr>`
    )
    .join("");

  return `<table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #d0d0d0;font-size:12px;font-family:Segoe UI,Malgun Gothic,sans-serif;">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function buildSectionHtml(section) {
  const countLabel = section.truncated
    ? `${section.totalMatched.toLocaleString("ko-KR")}건 중 ${section.rows.length.toLocaleString("ko-KR")}건 표시`
    : `${section.totalMatched.toLocaleString("ko-KR")}건`;

  return `<div style="margin:0 0 24px;">
    <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#1b2b48;">${escapeHtml(section.categoryLabel)} · ${escapeHtml(section.templateName)}</p>
    <p style="margin:0 0 10px;font-size:12px;color:#6b7280;">${countLabel}${section.fetchNote ? ` · ${escapeHtml(section.fetchNote)}` : ""}</p>
    ${
      section.rows.length === 0
        ? `<p style="margin:0;font-size:13px;color:#8a94a6;">조건에 맞는 결과가 없습니다.</p>`
        : buildDataTableHtml(section.headers, section.rows)
    }
  </div>`;
}

function buildPlainTextForSection(section) {
  const lines = [`Nexvia · ${section.templateName}`, ""];
  lines.push(`[${section.categoryLabel}] — ${section.totalMatched}건`);
  if (section.fetchNote) lines.push(`(${section.fetchNote})`);
  if (section.rows.length === 0) {
    lines.push("(결과 없음)");
  } else {
    lines.push(section.headers.join(" | "));
    for (const row of section.rows.slice(0, 50)) {
      const cells = row.map((c) => cellPlainText(c));
      lines.push(cells.join(" | "));
    }
    if (section.rows.length > 50) lines.push(`… 외 ${section.rows.length - 50}행`);
  }
  return lines.join("\n");
}

function buildPlainText(sections) {
  const lines = ["Nexvia · 템플릿 검색 결과", ""];
  for (const s of sections) {
    lines.push(`[${s.categoryLabel}] ${s.templateName} — ${s.totalMatched}건`);
    if (s.fetchNote) lines.push(`  (${s.fetchNote})`);
    if (s.rows.length === 0) {
      lines.push("  (결과 없음)");
    } else {
      lines.push(`  ${s.headers.join(" | ")}`);
      for (const row of s.rows.slice(0, 50)) {
        const cells = row.map((c) => cellPlainText(c));
        lines.push(`  ${cells.join(" | ")}`);
      }
      if (s.rows.length > 50) lines.push(`  … 외 ${s.rows.length - 50}행`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildListTemplateEmailSubject(section) {
  const name = String(section.templateName ?? "").trim() || "템플릿 검색 결과";
  return `[Nexvia] ${name}`.slice(0, 200);
}

function emailHtmlShell(bodyInner) {
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:16px;font-family:Segoe UI,Malgun Gothic,sans-serif;color:#2c3437;font-size:13px;line-height:1.5;">
${bodyInner}
</body>
</html>`;
}

export function buildSingleSectionEmailContent(section, { note = "" } = {}) {
  const subject = buildListTemplateEmailSubject(section);
  const countLabel = section.truncated
    ? `${section.totalMatched.toLocaleString("ko-KR")}건 중 ${section.rows.length.toLocaleString("ko-KR")}건 표시`
    : `${section.totalMatched.toLocaleString("ko-KR")}건`;

  const html = emailHtmlShell(`
    <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#1b2b48;">${escapeHtml(section.templateName)}</p>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">${escapeHtml(section.categoryLabel)} · ${countLabel}${section.fetchNote ? ` · ${escapeHtml(section.fetchNote)}` : ""}</p>
    <p style="margin:0 0 14px;font-size:12px;color:#6b7280;">상세 데이터는 첨부 엑셀 파일을 이용해 주세요.</p>
    ${note ? `<p style="margin:0 0 14px;font-size:13px;color:#44474d;white-space:pre-wrap;">${escapeHtml(note)}</p>` : ""}
    ${
      section.rows.length === 0
        ? `<p style="margin:0;font-size:13px;color:#8a94a6;">조건에 맞는 결과가 없습니다.</p>`
        : buildDataTableHtml(section.headers, section.rows)
    }
    <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">본 메일은 Nexvia에서 발송되었습니다.</p>
  `);
  const text = `${buildPlainTextForSection(section)}${note ? `\n\n메모:\n${note}\n` : ""}`;
  return { subject, html, text };
}

export function buildListTemplateEmailContent(sections, { note = "" } = {}) {
  const sectionCount = sections.length;
  const rowTotal = sections.reduce((n, s) => n + s.rows.length, 0);
  const subject = `[Nexvia] 템플릿 검색 결과 ${sectionCount}건 (${rowTotal}행)`;
  const html = emailHtmlShell(`
    <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#1b2b48;">Nexvia · 템플릿 검색 결과</p>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">저장한 템플릿 조건으로 조회한 결과입니다. (템플릿 ${sectionCount}건)</p>
    <p style="margin:0 0 14px;font-size:12px;color:#6b7280;">상세 데이터는 첨부 엑셀 파일을 이용해 주세요.</p>
    ${note ? `<p style="margin:0 0 14px;font-size:13px;color:#44474d;white-space:pre-wrap;">${escapeHtml(note)}</p>` : ""}
    ${sections.map(buildSectionHtml).join("")}
    <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">본 메일은 Nexvia에서 발송되었습니다.</p>
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
  const hasPerTemplateAttachments = allAttachments.some((a) => a?.templateId);

  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    const { subject, html, text } = buildSingleSectionEmailContent(section, { note });

    let sectionAttachments = allAttachments;
    if (hasPerTemplateAttachments) {
      sectionAttachments = allAttachments.filter(
        (a) => a?.templateId && String(a.templateId) === String(section.templateId)
      );
    } else if (sections.length === 1) {
      sectionAttachments = allAttachments;
    } else {
      sectionAttachments = allAttachments.slice(i, i + 1);
    }

    const mailAttachments = sectionAttachments
      .filter((a) => a?.contentBase64 && a?.filename)
      .slice(0, 2)
      .map((a) => ({
        filename: String(a.filename).slice(0, 120),
        content: Buffer.from(String(a.contentBase64), "base64"),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }));

    await transporter.sendMail({
      from: `"Nexvia" <${process.env.EMAIL_USER.trim()}>`,
      to: toAddr,
      subject,
      text,
      html,
      attachments: mailAttachments,
    });

    if (i < sections.length - 1) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}
