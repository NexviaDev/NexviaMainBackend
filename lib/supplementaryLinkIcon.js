/** 연계조회 표 SupplementaryTableLinkIcon 과 동일 — 메일 HTML용 */

export const NXBID_SUP_LINK_ICON_CLASS = "nxbid-sup-link-icon";

export const SUP_LINK_ICON_DEFAULT_LABEL = "링크 열기";

const SUP_LINK_ICON_INLINE_STYLE =
  'display:inline-block;width:28px;height:28px;border-radius:6px;color:#5a6d9e;background:#eef2fa;border:1px solid #d8e0f0;text-decoration:none;vertical-align:middle;line-height:1;text-align:center;';

const SUP_LINK_ICON_SVG_INNER = [
  '<path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M14 4h6v6" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M20 4L9 15" stroke-linecap="round" stroke-linejoin="round"/>',
].join("");

function supplementaryLinkIconSvgMarkup(size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${SUP_LINK_ICON_SVG_INNER}</svg>`;
}

export function buildSupplementaryLinkIconHtml(href, label = SUP_LINK_ICON_DEFAULT_LABEL) {
  const safeHref = String(href ?? "")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const safeLabel = String(label ?? SUP_LINK_ICON_DEFAULT_LABEL)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" style='${SUP_LINK_ICON_INLINE_STYLE}' aria-label="${safeLabel}" title="${safeLabel}">${supplementaryLinkIconSvgMarkup()}</a>`;
}
