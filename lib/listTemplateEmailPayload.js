/** list-templates 즉시·예약 메일 공통 payload 정제 */

export const DEFAULT_LIST_TEMPLATE_ID_PREFIX = "default:";
export const MAX_EMAIL_RECIPIENTS = 5;
export const MAX_SEND_TEMPLATE_IDS = 10;
export const MAX_NAME_LEN = 80;
const MAX_EMAIL_ROWS_PER_SECTION = 300;
const MAX_EMAIL_HEADERS = 20;
const MAX_EMAIL_CELL_LEN = 500;
const MAX_EMAIL_LINK_LEN = 8192;
const MAX_EMAIL_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isDefaultListTemplateId(id) {
  return String(id ?? "").startsWith(DEFAULT_LIST_TEMPLATE_ID_PREFIX);
}

export function isAllowedEmailTemplateId(id, ownedIds) {
  return ownedIds.has(id) || isDefaultListTemplateId(id);
}

function trimEmailHref(hrefRaw) {
  const href = String(hrefRaw ?? "").trim();
  if (!href || !/^https?:\/\//i.test(href)) return undefined;
  return href.slice(0, MAX_EMAIL_LINK_LEN);
}

export function sanitizeEmailList(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\s]+/) : [];
  const out = [];
  for (const item of list) {
    const e = String(item ?? "")
      .trim()
      .toLowerCase();
    if (!e || !EMAIL_RE.test(e)) continue;
    if (out.includes(e)) continue;
    out.push(e);
    if (out.length >= MAX_EMAIL_RECIPIENTS) break;
  }
  return out;
}

function normalizeSectionRow(row) {
  if (!Array.isArray(row)) return [];
  return row.map((cell) => {
    if (cell != null && typeof cell === "object" && !Array.isArray(cell)) {
      const text = String(cell.text ?? "").trim().slice(0, MAX_EMAIL_CELL_LEN);
      const links = Array.isArray(cell.links)
        ? cell.links
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const linkText = String(item.text ?? "").trim().slice(0, MAX_EMAIL_CELL_LEN);
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
      const hrefRaw = String(cell.href ?? "").trim();
      const href = trimEmailHref(hrefRaw);
      const linkIcon = cell.linkIcon === true;
      const linkIconLabel = String(cell.linkIconLabel ?? text).trim().slice(0, MAX_EMAIL_CELL_LEN);
      if (href && linkIcon) return { text, href, linkIcon: true, linkIconLabel };
      return href ? { text, href } : { text };
    }
    return { text: String(cell ?? "").trim().slice(0, MAX_EMAIL_CELL_LEN) };
  });
}

export function sanitizeEmailSections(raw, allowedIds) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_SEND_TEMPLATE_IDS) break;
    if (!item || typeof item !== "object") continue;
    const templateId = String(item.templateId ?? "").trim();
    if (!templateId || !isAllowedEmailTemplateId(templateId, allowedIds)) continue;
    const templateName = String(item.templateName ?? "").trim().slice(0, MAX_NAME_LEN);
    const categoryLabel = String(item.categoryLabel ?? "").trim().slice(0, 120);
    const fetchNote = String(item.fetchNote ?? "").trim().slice(0, 240);
    const headers = Array.isArray(item.headers)
      ? item.headers.map((h) => String(h ?? "").trim().slice(0, 80)).filter(Boolean).slice(0, MAX_EMAIL_HEADERS)
      : [];
    const rows = Array.isArray(item.rows)
      ? item.rows
          .slice(0, MAX_EMAIL_ROWS_PER_SECTION)
          .map((row) => normalizeSectionRow(row))
          .filter((row) => row.length > 0)
      : [];
    const totalMatched = Math.max(0, Math.min(Number(item.totalMatched) || rows.length, 1_000_000));
    out.push({
      templateId,
      templateName: templateName || "템플릿",
      categoryLabel: categoryLabel || "—",
      headers,
      rows,
      totalMatched,
      truncated: Boolean(item.truncated),
      fetchNote: fetchNote || undefined,
    });
  }
  return out;
}

export function sanitizeTemplateIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    const v = String(id ?? "").trim();
    if (!v || out.includes(v)) continue;
    out.push(v);
    if (out.length >= MAX_SEND_TEMPLATE_IDS) break;
  }
  return out;
}

export function sanitizeEmailAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= 10) break;
    if (!item || typeof item !== "object") continue;
    const filename = String(item.filename ?? "").trim().slice(0, 120);
    const contentBase64 = String(item.contentBase64 ?? "").trim();
    const templateId = String(item.templateId ?? "").trim().slice(0, 64);
    if (!filename || !contentBase64) continue;
    if (contentBase64.length > MAX_EMAIL_ATTACHMENT_BYTES * 1.4) continue;
    out.push({
      filename,
      contentBase64,
      ...(templateId ? { templateId } : {}),
    });
  }
  return out;
}
