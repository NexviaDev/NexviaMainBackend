import { isEmailConfigured, getTransporter } from "./mail.js";

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
    const href = raw.href && /^https?:\/\//i.test(String(raw.href)) ? String(raw.href).trim() : null;
    return { text, href };
  }
  return { text: String(raw ?? ""), href: null };
}

function renderCell(cell) {
  const { text, href } = normalizeCell(cell);
  if (href) {
    return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" style="color:#4a6fa5;text-decoration:underline;">${escapeHtml(text)}</a>`;
  }
  return escapeHtml(text);
}

function buildDataTableHtml(headers, rows) {
  const head = headers
    .map(
      (h) =>
        `<th style="padding:8px 10px;border:1px solid #d0d0d0;background:#f0f1f3;font-weight:700;white-space:nowrap;">${escapeHtml(h)}</th>`
    )
    .join("");

  const body = rows
    .map(
      (cells) =>
        `<tr>${cells
          .map(
            (c) =>
              `<td style="padding:8px 10px;border:1px solid #d0d0d0;background:#fff;white-space:nowrap;vertical-align:top;font-size:12px;">${renderCell(c)}</td>`
          )
          .join("")}</tr>`
    )
    .join("");

  const minWidth = Math.max(960, headers.length * 88);

  return `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;border:1px solid #dce4ef;border-radius:8px;background:#fff;">
  <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;min-width:${minWidth}px;width:max-content;font-size:12px;font-family:Segoe UI,Malgun Gothic,sans-serif;">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>
<p style="margin:6px 0 0;font-size:11px;color:#9ca3af;">← 표가 넓으면 좌우로 스크롤하세요. 공고명·번호를 누르면 나라장터로 이동합니다.</p>`;
}

function buildSectionHtml(section) {
  const countLabel = section.truncated
    ? `${section.totalMatched.toLocaleString("ko-KR")}건 중 ${section.rows.length.toLocaleString("ko-KR")}건 표시`
    : `${section.totalMatched.toLocaleString("ko-KR")}건`;

  return `<div style="margin:0 0 22px;">
    <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#1b2b48;">${escapeHtml(section.categoryLabel)} · ${escapeHtml(section.templateName)}</p>
    <p style="margin:0 0 8px;font-size:12px;color:#6b7280;">${countLabel}${section.fetchNote ? ` · ${escapeHtml(section.fetchNote)}` : ""}</p>
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
      const cells = row.map((c) => {
        const { text, href } = normalizeCell(c);
        return href ? `${text} (${href})` : text;
      });
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
        const cells = row.map((c) => {
          const { text, href } = normalizeCell(c);
          return href ? `${text} (${href})` : text;
        });
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

export function buildSingleSectionEmailContent(section, { note = "" } = {}) {
  const subject = buildListTemplateEmailSubject(section);
  const countLabel = section.truncated
    ? `${section.totalMatched.toLocaleString("ko-KR")}건 중 ${section.rows.length.toLocaleString("ko-KR")}건 표시`
    : `${section.totalMatched.toLocaleString("ko-KR")}건`;

  const html = `<!DOCTYPE html>
<html lang="ko">
<body style="margin:0;padding:24px;background:#eef1f6;font-family:Segoe UI,Malgun Gothic,sans-serif;color:#2c3437;">
  <div style="max-width:960px;margin:0 auto;background:#fff;border:1px solid #dce4ef;border-radius:12px;padding:20px 22px;">
    <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#1b2b48;">${escapeHtml(section.templateName)}</p>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">${escapeHtml(section.categoryLabel)} · ${countLabel}${section.fetchNote ? ` · ${escapeHtml(section.fetchNote)}` : ""}</p>
    <p style="margin:0 0 16px;font-size:12px;color:#6b7280;">엑셀 파일이 첨부되어 있습니다. 메일 본문 표는 가로 스크롤로 전체 열을 확인할 수 있습니다.</p>
    ${note ? `<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:#44474d;white-space:pre-wrap;">${escapeHtml(note)}</p>` : ""}
    ${
      section.rows.length === 0
        ? `<p style="margin:0;font-size:13px;color:#8a94a6;">조건에 맞는 결과가 없습니다.</p>`
        : buildDataTableHtml(section.headers, section.rows)
    }
    <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">본 메일은 Nexvia에서 발송되었습니다.</p>
  </div>
</body>
</html>`;
  const text = `${buildPlainTextForSection(section)}${note ? `\n\n메모:\n${note}\n` : ""}`;
  return { subject, html, text };
}

export function buildListTemplateEmailContent(sections, { note = "" } = {}) {
  const sectionCount = sections.length;
  const rowTotal = sections.reduce((n, s) => n + s.rows.length, 0);
  const subject = `[Nexvia] 템플릿 검색 결과 ${sectionCount}건 (${rowTotal}행)`;
  const html = `<!DOCTYPE html>
<html lang="ko">
<body style="margin:0;padding:24px;background:#eef1f6;font-family:Segoe UI,Malgun Gothic,sans-serif;color:#2c3437;">
  <div style="max-width:960px;margin:0 auto;background:#fff;border:1px solid #dce4ef;border-radius:12px;padding:20px 22px;">
    <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#1b2b48;">Nexvia · 템플릿 검색 결과</p>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">저장한 템플릿 조건으로 조회한 결과입니다. (템플릿 ${sectionCount}건)</p>
    <p style="margin:0 0 16px;font-size:12px;color:#6b7280;">엑셀 파일이 첨부되어 있습니다. 메일 본문 표는 가로 스크롤로 전체 열을 확인할 수 있습니다.</p>
    ${note ? `<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:#44474d;white-space:pre-wrap;">${escapeHtml(note)}</p>` : ""}
    ${sections.map(buildSectionHtml).join("")}
    <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">본 메일은 Nexvia에서 발송되었습니다.</p>
  </div>
</body>
</html>`;
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
