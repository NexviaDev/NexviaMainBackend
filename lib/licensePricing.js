/**
 * NEXGEOM 모듈 가격표.
 *
 * 금액은 **서버에서만** 계산한다 — 클라이언트가 보낸 금액은 절대 믿지 않는다.
 * (결제 승인 때 주문에 저장된 금액과 토스가 알려 준 금액이 일치해야 통과)
 */

/** 공급가액(원). 2026-09-03 확정: Viewer 50만 · Design 350만 · Reverse engineering 500만. */
export const MODULE_PRICE_KRW = {
  viewer: 500_000,
  cad: 3_500_000, // 판매 명칭 Design (내부 코드값은 cad 유지 — 이미 발급된 자격과 호환)
  re: 5_000_000,
};

/** 화면 표기 이름. 내부 코드값(viewer|cad|re)은 바꾸지 않는다. */
export const MODULE_LABEL = {
  viewer: "Viewer",
  cad: "Design",
  re: "Reverse engineering",
};

export const CURRENCY = "KRW";

/** 부가세 10% 별도. 표기는 공급가액 + 부가세로 나눠 보여 준다. */
export const VAT_RATE = 0.1;

/**
 * 기간제 가격은 아직 확정되지 않았다 — 임의로 만들어 팔면 안 되므로 null.
 * 값이 채워지기 전까지 기간제는 「가격 문의(발주서)」로만 접수한다.
 */
export const TERM_PRICE_KRW = {
  viewer: { 1: null, 3: null, 12: null },
  cad: { 1: null, 3: null, 12: null },
  re: { 1: null, 3: null, 12: null },
};

/**
 * 주문 금액 계산.
 * @param {{ tier: string, kind: string, months?: number, qty: number }} o
 * @returns {{ supply: number, vat: number, total: number }}
 */
export function priceOrder({ tier, kind, months = 0, qty }) {
  const n = Number(qty);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error("수량은 1~50 사이여야 합니다.");
  }
  let unit = null;
  if (kind === "perpetual") {
    unit = MODULE_PRICE_KRW[tier] ?? null;
  } else if (kind === "term") {
    unit = TERM_PRICE_KRW[tier]?.[Number(months)] ?? null;
  }
  if (unit === null || unit === undefined) {
    const err = new Error("이 조건의 가격표가 없습니다 — 발주서로 문의해 주세요.");
    err.code = "price_unavailable";
    throw err;
  }
  const supply = unit * n;
  const vat = Math.round(supply * VAT_RATE);
  return { supply, vat, total: supply + vat };
}

/** 공개 가격표 (결제 화면용). */
export function publicPricing() {
  return {
    currency: CURRENCY,
    vat_rate: VAT_RATE,
    vat_included: false,
    modules: Object.keys(MODULE_PRICE_KRW).map((tier) => ({
      tier,
      label: MODULE_LABEL[tier],
      perpetual_supply: MODULE_PRICE_KRW[tier],
      perpetual_total: MODULE_PRICE_KRW[tier] + Math.round(MODULE_PRICE_KRW[tier] * VAT_RATE),
      term: TERM_PRICE_KRW[tier],
    })),
  };
}
