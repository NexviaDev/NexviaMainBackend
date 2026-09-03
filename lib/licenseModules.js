/**
 * NEXGEOM 모듈 등급 — Viewer ⊂ CAD ⊂ Reverse engineering.
 *
 * 코드(발급물)에는 등급을 넣지 않는다. 업그레이드해도 **고객 코드는 바뀌지 않아야**
 * 하므로 등급은 자격(entitlement)에만 담고 서버가 관리한다.
 */

/** 하위 → 상위 순서. 배열 순서가 곧 포함 관계다. */
export const TIER_ORDER = ["viewer", "cad", "re"];

export const TIER_LABEL = {
  viewer: "Viewer",
  cad: "Design", // 판매 명칭. 내부 코드값 cad 는 유지(발급된 자격과 호환)
  re: "Reverse engineering",
};

/** 알 수 없는 값은 null (호출부에서 400 으로 거른다). */
export function normalizeTier(raw) {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!t) return null;
  if (t === "design") return "cad"; // 판매 명칭 → 내부 코드값
  if (t === "reverse" || t === "reverse-engineering" || t === "reverse_engineering") return "re";
  return TIER_ORDER.includes(t) ? t : null;
}

/** 상위 등급은 하위를 포함한다 — 클라이언트가 포함관계를 계산하지 않도록 펼쳐서 준다. */
export function expandModules(tier) {
  const t = normalizeTier(tier) || "viewer";
  const idx = TIER_ORDER.indexOf(t);
  return TIER_ORDER.slice(0, idx + 1);
}

/** a 가 b 이상인가 (업그레이드 방향 검사). */
export function tierAtLeast(a, b) {
  const ia = TIER_ORDER.indexOf(normalizeTier(a) || "viewer");
  const ib = TIER_ORDER.indexOf(normalizeTier(b) || "viewer");
  return ia >= ib;
}
