/** 메일 href — osnap 제거·길이 제한 (Gmail HTML 깨짐 방지) */

/** Gmail 등 — href 속성이 길면 중간에서 HTML이 끊겨 `<a href=` 가 글자로 보임 */
export const MAX_EMAIL_RENDER_HREF = 900;

const KEEP_QUERY_KEYS = new Set(["tab", "openg", "pblanc", "detail", "id", "ntce"]);

function prodAppOrigin() {
  return String(process.env.NEXVIA_APP_ORIGIN ?? process.env.BIDDING_APP_ORIGIN ?? "")
    .trim()
    .replace(/\/$/, "");
}

function stripSnapParams(href) {
  try {
    const u = new URL(href);
    u.searchParams.delete("osnap");
    u.searchParams.delete("psnap");
    let out = u.toString();
    out = out.replace(/\?&/, "?").replace(/[?&]$/, "");
    return out;
  } catch {
    return href
      .replace(/([?&])(osnap|psnap)=[^&]*/gi, "")
      .replace(/\?&/, "?")
      .replace(/[?&]$/, "");
  }
}

function replaceLocalhostOrigin(href) {
  const prod = prodAppOrigin();
  if (!prod) return href;
  try {
    const u = new URL(href);
    if (!/^localhost$/i.test(u.hostname) && u.hostname !== "127.0.0.1") return href;
    return `${prod}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return href;
  }
}

function slimQueryString(href) {
  try {
    const u = new URL(href);
    const slim = new URL(`${u.origin}${u.pathname}`);
    for (const [k, v] of u.searchParams) {
      if (KEEP_QUERY_KEYS.has(k)) slim.searchParams.set(k, v);
    }
    return slim.toString();
  } catch {
    return href;
  }
}

/** 메일·payload 공통 — http(s)만, osnap/psnap 제거, 길이 제한 */
export function shortenEmailHref(hrefRaw) {
  let href = String(hrefRaw ?? "").trim();
  if (!href || !/^https?:\/\//i.test(href)) return null;

  href = stripSnapParams(href);
  href = replaceLocalhostOrigin(href);

  if (href.length > MAX_EMAIL_RENDER_HREF) {
    href = slimQueryString(href);
  }
  if (href.length > MAX_EMAIL_RENDER_HREF) {
    href = href.slice(0, MAX_EMAIL_RENDER_HREF);
  }
  return href || null;
}
