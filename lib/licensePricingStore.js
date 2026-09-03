/**
 * 라이선스 가격 정책 — MongoDB 단일 문서.
 * 공개 GET /v1/pricing 과 결제 금액 계산이 같은 문서를 본다.
 * 쓰기는 관리자 토큰(또는 관리자 콘솔 중계)만.
 */

import { getDb, isMongoConfigured } from "./mongo.js";
import {
  MODULE_LABEL,
  MODULE_PRICE_KRW as DEFAULT_PERPETUAL,
  TERM_PRICE_KRW as DEFAULT_TERM,
  VAT_RATE as DEFAULT_VAT,
  CURRENCY,
} from "./licensePricing.js";

const COL = "license_pricing";
const DOC_ID = "policy";

/** @typedef {{
 *   perpetual: { viewer: number|null, cad: number|null, re: number|null },
 *   term: { viewer: Record<string, number|null>, cad: Record<string, number|null>, re: Record<string, number|null> },
 *   vat_rate: number,
 *   currency: string,
 *   updatedAt?: string,
 *   updatedBy?: string,
 * }} PricingPolicy */

let cache = { at: 0, policy: null };
const CACHE_MS = 5_000;

function cloneDefaults() {
  return {
    perpetual: { ...DEFAULT_PERPETUAL },
    term: {
      viewer: { ...DEFAULT_TERM.viewer },
      cad: { ...DEFAULT_TERM.cad },
      re: { ...DEFAULT_TERM.re },
    },
    vat_rate: DEFAULT_VAT,
    currency: CURRENCY,
    source: "defaults",
  };
}

function sanitizeNum(v, { allowNull = true } = {}) {
  if (v === null || v === undefined || v === "") return allowNull ? null : null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) {
    throw new Error("가격은 0~10억 사이 숫자여야 합니다.");
  }
  return Math.round(n);
}

/**
 * @param {Partial<PricingPolicy>} raw
 * @returns {PricingPolicy}
 */
export function normalizePolicy(raw = {}) {
  const base = cloneDefaults();
  const perpetual = { ...base.perpetual, ...(raw.perpetual || {}) };
  for (const k of Object.keys(MODULE_LABEL)) {
    perpetual[k] = sanitizeNum(perpetual[k]);
  }
  const termIn = raw.term || {};
  const term = {};
  for (const k of Object.keys(MODULE_LABEL)) {
    const row = { 1: null, 3: null, 12: null, ...(termIn[k] || {}) };
    term[k] = {
      1: sanitizeNum(row[1] ?? row["1"]),
      3: sanitizeNum(row[3] ?? row["3"]),
      12: sanitizeNum(row[12] ?? row["12"]),
    };
  }
  let vat = Number(raw.vat_rate ?? base.vat_rate);
  if (!Number.isFinite(vat) || vat < 0 || vat > 1) {
    throw new Error("부가세율은 0~1 사이여야 합니다 (예: 0.1 = 10%).");
  }
  return {
    perpetual,
    term,
    vat_rate: vat,
    currency: String(raw.currency || base.currency || "KRW"),
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null,
    source: raw.source || "mongo",
  };
}

async function col() {
  const db = await getDb();
  return db.collection(COL);
}

/** 캐시 무시하고 DB(또는 기본값)에서 읽기. */
export async function loadPricingPolicy({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && cache.policy && now - cache.at < CACHE_MS) {
    return cache.policy;
  }
  if (!isMongoConfigured()) {
    const d = cloneDefaults();
    cache = { at: now, policy: d };
    return d;
  }
  try {
    const c = await col();
    const doc = await c.findOne({ _id: DOC_ID });
    if (!doc) {
      const d = cloneDefaults();
      cache = { at: now, policy: d };
      return d;
    }
    const { _id, ...rest } = doc;
    const policy = normalizePolicy({ ...rest, source: "mongo" });
    cache = { at: now, policy };
    return policy;
  } catch (e) {
    console.warn("[license-pricing] Mongo 읽기 실패 — 기본값 사용:", e?.message || e);
    const d = cloneDefaults();
    cache = { at: now, policy: d };
    return d;
  }
}

/** 관리자 저장. 없으면 upsert. */
export async function savePricingPolicy(input, { by = "admin" } = {}) {
  if (!isMongoConfigured()) {
    throw new Error("MONGODB_URI 가 없어 가격 정책을 저장할 수 없습니다.");
  }
  const policy = normalizePolicy(input);
  const now = new Date().toISOString();
  const doc = {
    ...policy,
    updatedAt: now,
    updatedBy: String(by || "admin").slice(0, 120),
    source: "mongo",
  };
  delete doc._id;
  const c = await col();
  await c.updateOne(
    { _id: DOC_ID },
    { $set: doc, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  cache = { at: Date.now(), policy: doc };
  return doc;
}

export function invalidatePricingCache() {
  cache = { at: 0, policy: null };
}

/**
 * 정책 기준 금액 계산 (동기 — 호출 전에 loadPricingPolicy).
 * @param {{ tier: string, kind: string, months?: number, qty: number }} o
 * @param {PricingPolicy} policy
 */
export function priceOrderWithPolicy({ tier, kind, months = 0, qty }, policy) {
  const n = Number(qty);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error("수량은 1~50 사이여야 합니다.");
  }
  let unit = null;
  if (kind === "perpetual") {
    unit = policy.perpetual?.[tier] ?? null;
  } else if (kind === "term") {
    unit = policy.term?.[tier]?.[Number(months)] ?? null;
  }
  if (unit === null || unit === undefined) {
    const err = new Error("이 조건의 가격표가 없습니다 — 발주서로 문의해 주세요.");
    err.code = "price_unavailable";
    throw err;
  }
  const vatRate = policy.vat_rate ?? DEFAULT_VAT;
  const supply = unit * n;
  const vat = Math.round(supply * vatRate);
  return { supply, vat, total: supply + vat };
}

/** 공개 API 응답 본문. */
export function publicPricingFromPolicy(policy) {
  const vatRate = policy.vat_rate ?? DEFAULT_VAT;
  return {
    currency: policy.currency || CURRENCY,
    vat_rate: vatRate,
    vat_included: false,
    source: policy.source || "defaults",
    updated_at: policy.updatedAt || null,
    modules: Object.keys(MODULE_LABEL).map((tier) => {
      const supply = policy.perpetual?.[tier] ?? null;
      return {
        tier,
        label: MODULE_LABEL[tier],
        perpetual_supply: supply,
        perpetual_total:
          supply === null || supply === undefined
            ? null
            : supply + Math.round(supply * vatRate),
        term: policy.term?.[tier] || { 1: null, 3: null, 12: null },
      };
    }),
  };
}
