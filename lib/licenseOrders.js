/**
 * NEXGEOM 라이선스 주문 — MongoDB.
 *
 * 결제 승인은 **한 번만** 라이선스를 발급해야 한다(웹훅·새로고침·뒤로가기 재시도).
 * 그래서 주문 상태 전이를 원자적 조건부 갱신으로 처리한다.
 */
import { getDb, isMongoConfigured } from "./mongo.js";

const ORDERS = "license_orders";

let indexesReady = false;

async function col() {
  if (!isMongoConfigured()) {
    const err = new Error("MONGODB_URI is not configured");
    err.code = "mongo_unconfigured";
    throw err;
  }
  const db = await getDb();
  return db.collection(ORDERS);
}

export async function ensureOrderIndexes() {
  if (indexesReady) return;
  const c = await col();
  await Promise.all([
    c.createIndex({ orderId: 1 }, { unique: true }),
    c.createIndex({ state: 1, createdAt: -1 }),
    c.createIndex({ paymentKey: 1 }, { sparse: true }),
  ]);
  indexesReady = true;
}

/** 주문번호는 서버가 만든다 — 클라이언트가 정하면 금액 바꿔치기의 통로가 된다. */
export function makeOrderId(now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `NG-${d}-${rand}`;
}

export async function insertOrder(row) {
  await ensureOrderIndexes();
  const c = await col();
  await c.insertOne(row);
  return row;
}

export async function findOrder(orderId) {
  await ensureOrderIndexes();
  const c = await col();
  return c.findOne({ orderId: String(orderId) });
}

export async function listOrders({ state = null, limit = 100 } = {}) {
  await ensureOrderIndexes();
  const c = await col();
  const q = state ? { state: String(state) } : {};
  return c
    .find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500))
    .toArray();
}

/**
 * `pending` → `paying` 원자적 선점. 이미 처리 중이거나 끝난 주문이면 null.
 * 승인 API 를 두 번 불러도 발급은 한 번만 일어나게 하는 잠금이다.
 */
export async function claimForPayment(orderId) {
  await ensureOrderIndexes();
  const c = await col();
  const r = await c.findOneAndUpdate(
    { orderId: String(orderId), state: { $in: ["pending", "po_submitted"] } },
    { $set: { state: "paying", updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  return r?.value ?? r ?? null;
}

/** 승인 실패 시 되돌린다 (다시 시도할 수 있게). */
export async function releaseClaim(orderId, previousState = "pending") {
  const c = await col();
  await c.updateOne(
    { orderId: String(orderId), state: "paying" },
    { $set: { state: previousState, updatedAt: new Date().toISOString() } }
  );
}

export async function markOrderPaid(orderId, { paymentKey, method, codes, receipt }) {
  const c = await col();
  const now = new Date().toISOString();
  const r = await c.findOneAndUpdate(
    { orderId: String(orderId) },
    {
      $set: {
        state: "paid",
        paymentKey: paymentKey || null,
        payMethod: method || null,
        licenseCodes: codes || [],
        receiptUrl: receipt || null,
        paidAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );
  return r?.value ?? r ?? null;
}

export async function setOrderState(orderId, state, extra = {}) {
  const c = await col();
  const r = await c.findOneAndUpdate(
    { orderId: String(orderId) },
    { $set: { state: String(state), updatedAt: new Date().toISOString(), ...extra } },
    { returnDocument: "after" }
  );
  return r?.value ?? r ?? null;
}
