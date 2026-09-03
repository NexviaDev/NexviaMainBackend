/**
 * 리턴 / 강제리턴 신청 티켓 — MongoDB.
 *
 * 강제리턴은 「PC 가 죽어서 그 PC 에서 반납할 수 없는」 경우다. 좌석을 관리자가 풀어
 * 주는 일이라 **누가 요청했는지**(이름·연락처·업체명)와 **동의**를 반드시 남긴다.
 * 개인정보는 처리 목적(좌석 회수)에만 쓰고, 관리자 목록에서는 기본적으로 가린다.
 */
import { getDb, isMongoConfigured } from "./mongo.js";

const RETURNS = "license_return_requests";

let indexesReady = false;

async function col() {
  if (!isMongoConfigured()) {
    const err = new Error("MONGODB_URI is not configured");
    err.code = "mongo_unconfigured";
    throw err;
  }
  const db = await getDb();
  return db.collection(RETURNS);
}

export async function ensureReturnIndexes() {
  if (indexesReady) return;
  const c = await col();
  await Promise.all([
    c.createIndex({ ticket: 1 }, { unique: true }),
    c.createIndex({ state: 1, createdAt: -1 }),
    c.createIndex({ codeBody: 1, createdAt: -1 }),
  ]);
  indexesReady = true;
}

/** RT-YYYYMMDD-#### — 날짜별 순번. */
export async function nextTicketId(now = new Date()) {
  const c = await col();
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `RT-${day}-`;
  const last = await c
    .find({ ticket: { $regex: `^${prefix}` } })
    .sort({ ticket: -1 })
    .limit(1)
    .toArray();
  const n = last.length ? Number(last[0].ticket.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
}

export async function insertReturnRequest(row) {
  await ensureReturnIndexes();
  const c = await col();
  await c.insertOne(row);
  return row;
}

export async function findReturnRequest(ticket) {
  await ensureReturnIndexes();
  const c = await col();
  return c.findOne({ ticket: String(ticket) });
}

export async function listReturnRequests({ state = null, limit = 100 } = {}) {
  await ensureReturnIndexes();
  const c = await col();
  const q = state ? { state: String(state) } : {};
  return c
    .find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500))
    .toArray();
}

export async function setReturnState(ticket, state, extra = {}) {
  await ensureReturnIndexes();
  const c = await col();
  const r = await c.findOneAndUpdate(
    { ticket: String(ticket) },
    { $set: { state: String(state), updatedAt: new Date().toISOString(), ...extra } },
    { returnDocument: "after" },
  );
  return r?.value ?? r ?? null;
}

/** 최근 같은 코드로 접수된 처리 대기 티켓 — 중복 신청 방지. */
export async function findPendingByCode(codeBody) {
  await ensureReturnIndexes();
  const c = await col();
  return c.findOne({ codeBody: String(codeBody), state: "received" });
}

/** 관리자 목록 표시용 — 개인정보는 기본 마스킹. */
export function maskContact(contact, full = false) {
  const c = contact || {};
  if (full) return c;
  const maskTail = (s, keep = 4) => {
    const v = String(s ?? "");
    if (v.length <= keep) return v ? "*".repeat(v.length) : "";
    return "*".repeat(v.length - keep) + v.slice(-keep);
  };
  const maskEmail = (s) => {
    const v = String(s ?? "");
    const at = v.indexOf("@");
    if (at <= 0) return v ? "***" : "";
    const id = v.slice(0, at);
    const head = id.slice(0, 2);
    return `${head}${"*".repeat(Math.max(1, id.length - 2))}${v.slice(at)}`;
  };
  return {
    name: c.name ? `${String(c.name).slice(0, 1)}${"*".repeat(Math.max(1, String(c.name).length - 1))}` : "",
    phone: maskTail(c.phone, 4),
    company: c.company || "",
    email: maskEmail(c.email),
  };
}
