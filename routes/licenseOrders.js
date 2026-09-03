/**
 * NEXGEOM 라이선스 신청·결제 — https://www.nexvia.co.kr/api/license/v1/*
 *
 * 두 갈래:
 *   토스페이먼츠 : 주문 생성 → 결제창 → successUrl → **서버 승인** → 코드 발급 → 메일
 *   발주서(후불) : 주문 생성 → 발주서 제출 → 관리자 승인 → 코드 발급 → 메일
 *
 * 금액은 서버에서만 계산·검증한다. 발급은 주문당 정확히 한 번(상태 선점 + 멱등키).
 */
import { Router } from "express";
import crypto from "node:crypto";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { isMongoConfigured } from "../lib/mongo.js";
import { issueFloating, parseCode, utcNowIso } from "../lib/licenseCrypto.js";
import { upsertSeatIssued, writeAudit } from "../lib/licenseStore.js";
import { expandModules, normalizeTier } from "../lib/licenseModules.js";
import { MODULE_LABEL } from "../lib/licensePricing.js";
import {
  loadPricingPolicy,
  savePricingPolicy,
  priceOrderWithPolicy,
  publicPricingFromPolicy,
} from "../lib/licensePricingStore.js";
import {
  claimForPayment,
  findOrder,
  insertOrder,
  listOrders,
  makeOrderId,
  markOrderPaid,
  releaseClaim,
  setOrderState,
} from "../lib/licenseOrders.js";
import { isTossConfigured, tossClientKey, tossConfirmPayment } from "../lib/licenseToss.js";
import { sendLicenseCodesEmail, sendPurchaseOrderNotice } from "../lib/licenseMail.js";

const router = Router();

const ADMIN_TOKEN = String(process.env.NEXVIA_LICENSE_ADMIN_TOKEN || "").trim();
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ADMIN_TOKEN_OK = ADMIN_TOKEN.length >= 24 || (!IS_PROD && ADMIN_TOKEN.length > 0);

const orderLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});
const confirmLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});
const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});

// 발주서 PDF/이미지 — 메모리로만 받아 메일로 넘긴다(디스크·DB 에 남기지 않는다).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  const len = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ba.copy(pa);
  bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && ba.length === bb.length;
}

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN_OK) {
    res.status(503).json({ ok: false, error: "admin_disabled" });
    return false;
  }
  const token = String(req.headers["x-admin-token"] ?? "").trim();
  if (!token || !safeEqual(token, ADMIN_TOKEN)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

function requireMongo(res) {
  if (!isMongoConfigured()) {
    res.status(503).json({ ok: false, error: "mongo_unconfigured" });
    return false;
  }
  return true;
}

function field(raw, { max, min = 0, label }) {
  const v = String(raw ?? "").trim();
  if (v.length < min) throw new Error(`${label} 이(가) 필요합니다`);
  if (v.length > max) throw new Error(`${label} 이(가) 너무 깁니다 (최대 ${max}자)`);
  return v;
}

function readBuyer(body) {
  const buyer = {
    company: field(body?.buyer?.company, { max: 80, min: 1, label: "업체명" }),
    name: field(body?.buyer?.name, { max: 40, min: 1, label: "담당자 이름" }),
    phone: field(body?.buyer?.phone, { max: 24, min: 6, label: "연락처" }),
    email: field(body?.buyer?.email, { max: 254, min: 5, label: "이메일" }),
    bizNo: field(body?.buyer?.biz_no ?? "", { max: 20, label: "사업자등록번호" }),
    memo: field(body?.buyer?.memo ?? "", { max: 500, label: "요청사항" }),
  };
  if (!/^[0-9+\-() .]{6,24}$/.test(buyer.phone)) throw new Error("연락처 형식을 확인해 주세요.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(buyer.email)) throw new Error("이메일 형식을 확인해 주세요.");
  return buyer;
}

/** 주문 한 건에 대한 라이선스 코드 발급 — 수량 = 좌석 슬롯. 플로팅 코드는 1개. */
async function issueCodesForOrder(order) {
  const now = utcNowIso();
  const expires = order.kind === "term" && order.expires ? new Date(`${order.expires}T00:00:00.000Z`) : null;
  const code = issueFloating(order.kind, expires);
  const parsed = parseCode(code);
  for (let i = 0; i < order.qty; i++) {
    await upsertSeatIssued({
      codeBody: parsed.body,
      kind: parsed.kind,
      expires: parsed.expires,
      tier: order.tier,
      updatedAt: now,
    });
  }
  await writeAudit("issue-by-order", {
    order_id: order.orderId,
    tier: order.tier,
    kind: order.kind,
    qty: order.qty,
    license_code: code,
    company: order.buyer?.company || null,
  });
  return [code];
}

/* ── 공개: 가격표 / 결제 설정 ─────────────────────────────────────────── */
router.get("/v1/pricing", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const policy = await loadPricingPolicy();
    res.json({
      ok: true,
      ...publicPricingFromPolicy(policy),
      toss_ready: isTossConfigured(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** 관리자: 현재 가격 정책(원본) */
router.get("/v1/admin/pricing", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const policy = await loadPricingPolicy({ bypassCache: true });
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, policy });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** 관리자: 가격 정책 저장 → 공개 /v1/pricing · 결제 금액에 즉시 반영 */
router.put("/v1/admin/pricing", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireMongo(res)) return;
  try {
    const by =
      String(req.headers["x-admin-actor"] || "").trim() ||
      String(req.body?.updated_by || "admin").slice(0, 120);
    const policy = await savePricingPolicy(req.body || {}, { by });
    await writeAudit("pricing-update", {
      by,
      perpetual: policy.perpetual,
      vat_rate: policy.vat_rate,
    });
    res.json({ ok: true, policy, public: publicPricingFromPolicy(policy) });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get("/v1/pay-config", (_req, res) => {
  res.set("Cache-Control", "no-store");
  // 클라이언트 키만 내려간다. 시크릿 키는 서버 밖으로 나가지 않는다.
  res.json({ ok: true, client_key: tossClientKey(), ready: isTossConfigured() });
});

/* ── 주문 생성 ────────────────────────────────────────────────────────── */
router.post("/v1/orders", orderLimiter, async (req, res) => {
  if (!requireMongo(res)) return;
  try {
    const tier = normalizeTier(req.body?.tier);
    if (!tier) return res.status(400).json({ ok: false, error: "tier must be viewer|cad|re" });
    const kind = String(req.body?.kind || "perpetual").toLowerCase();
    if (kind !== "perpetual" && kind !== "term") {
      return res.status(400).json({ ok: false, error: "kind must be perpetual|term" });
    }
    const months = kind === "term" ? Number(req.body?.months || 0) : 0;
    if (kind === "term" && ![1, 3, 12].includes(months)) {
      return res.status(400).json({ ok: false, error: "months must be 1|3|12" });
    }
    const qty = Number(req.body?.qty || 1);
    const payMethod = String(req.body?.pay_method || "toss").toLowerCase();
    if (payMethod !== "toss" && payMethod !== "po") {
      return res.status(400).json({ ok: false, error: "pay_method must be toss|po" });
    }
    const buyer = readBuyer(req.body);

    const policy = await loadPricingPolicy();
    let amount = null;
    try {
      amount = priceOrderWithPolicy({ tier, kind, months, qty }, policy);
    } catch (e) {
      // 가격표에 없는 조건(기간제 등)은 발주서로만 접수한다.
      if (e.code !== "price_unavailable" || payMethod === "toss") {
        return res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }

    const now = utcNowIso();
    const order = {
      orderId: makeOrderId(new Date()),
      tier,
      tierLabel: MODULE_LABEL[tier],
      kind,
      months,
      qty,
      expires: null, // 기간제 만료일은 발급 시 관리자가 확정
      buyer,
      payMethod,
      amount, // null = 가격 문의(발주서)
      state: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await insertOrder(order);
    await writeAudit("order-create", {
      order_id: order.orderId,
      tier,
      kind,
      qty,
      pay_method: payMethod,
      company: buyer.company,
      total: amount?.total ?? null,
    });
    return res.json({
      ok: true,
      order_id: order.orderId,
      tier,
      label: MODULE_LABEL[tier],
      modules: expandModules(tier),
      kind,
      qty,
      amount,
      order_name: `NEXGEOM ${MODULE_LABEL[tier]} ${kind === "term" ? `${months}개월` : "영구"} x${qty}`,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ── 토스 결제 승인 ───────────────────────────────────────────────────── */
router.post("/v1/orders/:orderId/confirm", confirmLimiter, async (req, res) => {
  if (!requireMongo(res)) return;
  const orderId = String(req.params.orderId || "").trim();
  try {
    const order = await findOrder(orderId);
    if (!order) return res.status(404).json({ ok: false, error: "order_not_found" });
    if (order.state === "paid") {
      // 새로고침·뒤로가기로 다시 들어온 경우 — 이미 발급된 코드를 그대로 돌려준다.
      return res.json({ ok: true, order_id: orderId, state: "paid", codes: order.licenseCodes || [] });
    }
    if (!order.amount) {
      return res.status(400).json({ ok: false, error: "order_has_no_price" });
    }
    const paymentKey = field(req.body?.paymentKey, { max: 200, min: 1, label: "paymentKey" });
    const amount = Number(req.body?.amount);
    // 화면이 보낸 금액은 **대조용**으로만 쓴다. 승인에 넘기는 값은 주문에 저장된 금액.
    if (!Number.isFinite(amount) || amount !== order.amount.total) {
      await writeAudit("order-amount-mismatch", {
        order_id: orderId,
        expected: order.amount.total,
        got: amount,
      });
      return res.status(400).json({ ok: false, error: "amount_mismatch" });
    }

    const claimed = await claimForPayment(orderId);
    if (!claimed) {
      const cur = await findOrder(orderId);
      return res.status(409).json({ ok: false, error: "order_not_payable", state: cur?.state });
    }

    let payment = null;
    try {
      payment = await tossConfirmPayment({
        paymentKey,
        orderId,
        amount: order.amount.total,
      });
    } catch (e) {
      await releaseClaim(orderId, "pending");
      await writeAudit("order-confirm-failed", { order_id: orderId, error: String(e?.message || e) });
      return res.status(e.status || 400).json({ ok: false, error: String(e?.message || e) });
    }

    const codes = await issueCodesForOrder(order);
    await markOrderPaid(orderId, {
      paymentKey,
      method: payment?.method || "toss",
      codes,
      receipt: payment?.receipt?.url || null,
    });
    await sendLicenseCodesEmail({ order, codes }).catch(() => {});
    await writeAudit("order-paid", { order_id: orderId, qty: order.qty, tier: order.tier });
    return res.json({ ok: true, order_id: orderId, state: "paid", codes });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ── 발주서(후불) 제출 ────────────────────────────────────────────────── */
router.post(
  "/v1/orders/:orderId/purchase-order",
  orderLimiter,
  upload.single("file"),
  async (req, res) => {
    if (!requireMongo(res)) return;
    try {
      const orderId = String(req.params.orderId || "").trim();
      const order = await findOrder(orderId);
      if (!order) return res.status(404).json({ ok: false, error: "order_not_found" });
      if (order.state !== "pending") {
        return res.status(409).json({ ok: false, error: "order_not_pending", state: order.state });
      }
      const file = req.file || null;
      if (file && !/^(application\/pdf|image\/(png|jpeg))$/.test(file.mimetype)) {
        return res.status(400).json({ ok: false, error: "PDF 또는 PNG/JPG 만 첨부할 수 있습니다." });
      }
      await setOrderState(orderId, "po_submitted", {
        poFileName: file?.originalname || null,
        poSubmittedAt: utcNowIso(),
      });
      // 파일은 저장하지 않고 영업 담당에게 메일로만 넘긴다(보관 최소화).
      await sendPurchaseOrderNotice({ order, file }).catch(() => {});
      await writeAudit("order-po-submitted", {
        order_id: orderId,
        company: order.buyer?.company || null,
        file: file?.originalname || null,
      });
      return res.json({ ok: true, order_id: orderId, state: "po_submitted" });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  }
);

/* ── 주문 조회(구매자용) — 코드는 결제 완료 후에만 ────────────────────── */
router.get("/v1/orders/:orderId", orderLimiter, async (req, res) => {
  if (!requireMongo(res)) return;
  const order = await findOrder(String(req.params.orderId || "").trim());
  if (!order) return res.status(404).json({ ok: false, error: "order_not_found" });
  return res.json({
    ok: true,
    order_id: order.orderId,
    state: order.state,
    tier: order.tier,
    label: order.tierLabel,
    kind: order.kind,
    qty: order.qty,
    amount: order.amount,
    codes: order.state === "paid" ? order.licenseCodes || [] : [],
  });
});

/* ── 관리자: 주문 목록 / 발주서 승인·반려 ─────────────────────────────── */
router.get("/v1/admin/orders", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  const rows = await listOrders({
    state: req.query.state ? String(req.query.state) : null,
    limit: Number(req.query.limit) || 100,
  });
  return res.json({
    ok: true,
    orders: rows.map((o) => ({
      order_id: o.orderId,
      state: o.state,
      tier: o.tier,
      label: o.tierLabel,
      kind: o.kind,
      months: o.months,
      qty: o.qty,
      amount: o.amount,
      pay_method: o.payMethod,
      company: o.buyer?.company || null,
      name: o.buyer?.name || null,
      email: o.buyer?.email || null,
      po_file: o.poFileName || null,
      codes: o.licenseCodes || [],
      created_at: o.createdAt,
    })),
  });
});

router.post("/v1/admin/orders/:orderId/approve", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  try {
    const orderId = String(req.params.orderId || "").trim();
    const order = await findOrder(orderId);
    if (!order) return res.status(404).json({ ok: false, error: "order_not_found" });
    if (order.state === "paid") {
      return res.json({ ok: true, order_id: orderId, state: "paid", codes: order.licenseCodes || [] });
    }
    const claimed = await claimForPayment(orderId);
    if (!claimed) {
      return res.status(409).json({ ok: false, error: "order_not_approvable", state: order.state });
    }
    // 기간제는 만료일을 승인 시점에 확정한다(관리자 입력).
    const expires = req.body?.expires ? String(req.body.expires).trim() : null;
    if (order.kind === "term" && !expires) {
      await releaseClaim(orderId, "po_submitted");
      return res.status(400).json({ ok: false, error: "expires_required_for_term" });
    }
    const codes = await issueCodesForOrder({ ...order, expires });
    await markOrderPaid(orderId, { paymentKey: null, method: "purchase_order", codes, receipt: null });
    await sendLicenseCodesEmail({ order, codes }).catch(() => {});
    await writeAudit("order-approve", { order_id: orderId, qty: order.qty, by: "admin" });
    return res.json({ ok: true, order_id: orderId, state: "paid", codes });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post("/v1/admin/orders/:orderId/reject", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  try {
    const orderId = String(req.params.orderId || "").trim();
    const reason = field(req.body?.reason ?? "", { max: 300, label: "반려 사유" });
    const order = await findOrder(orderId);
    if (!order) return res.status(404).json({ ok: false, error: "order_not_found" });
    if (order.state === "paid") {
      return res.status(409).json({ ok: false, error: "already_paid" });
    }
    await setOrderState(orderId, "rejected", { rejectedReason: reason, rejectedAt: utcNowIso() });
    await writeAudit("order-reject", { order_id: orderId, reason });
    return res.json({ ok: true, order_id: orderId, state: "rejected" });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
