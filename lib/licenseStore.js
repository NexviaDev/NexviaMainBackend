/**
 * NEXCAD license seats / revocations / audit — MongoDB.
 *
 * Floating 키(영구 등)는 암호상 동일 코드가 나오므로,
 * 「수량 N」= 같은 codeBody 에 좌석 슬롯 N개 (seatId 고유).
 */
import { randomUUID } from "node:crypto";
import { getDb, isMongoConfigured } from "./mongo.js";

const SEATS = "license_seats";
const REVOCATIONS = "license_revocations";
const AUDIT = "license_audit";

let indexesReady = false;

async function col(name) {
  if (!isMongoConfigured()) {
    const err = new Error("MONGODB_URI is not configured");
    err.code = "mongo_unconfigured";
    throw err;
  }
  const db = await getDb();
  return db.collection(name);
}

async function migrateSeatIds(seats) {
  const missing = await seats.find({ seatId: { $exists: false } }).project({ _id: 1 }).toArray();
  for (const doc of missing) {
    await seats.updateOne({ _id: doc._id }, { $set: { seatId: randomUUID() } });
  }
}

async function dropLegacyUniqueCodeBody(seats) {
  try {
    const indexes = await seats.indexes();
    for (const idx of indexes) {
      if (idx.name === "_id_") continue;
      const keys = idx.key || {};
      if (keys.codeBody === 1 && idx.unique && !keys.seatId) {
        await seats.dropIndex(idx.name);
      }
    }
  } catch {
    /* index may already be gone */
  }
}

export async function ensureLicenseIndexes() {
  if (indexesReady) return;
  const seats = await col(SEATS);
  const revs = await col(REVOCATIONS);
  const audit = await col(AUDIT);
  await dropLegacyUniqueCodeBody(seats);
  await migrateSeatIds(seats);
  await Promise.all([
    seats.createIndex({ seatId: 1 }, { unique: true }),
    seats.createIndex({ codeBody: 1 }),
    seats.createIndex({ machineId: 1 }, { sparse: true }),
    revs.createIndex({ codeBody: 1, machineId: 1 }, { unique: true }),
    revs.createIndex({ revokedAt: -1 }),
    audit.createIndex({ at: -1 }),
  ]);
  indexesReady = true;
}

/** @param {string} action @param {Record<string, unknown>} detail */
export async function writeAudit(action, detail = {}) {
  try {
    const c = await col(AUDIT);
    await c.insertOne({ action, ...detail, at: new Date().toISOString() });
  } catch {
    /* audit must not break API */
  }
}

/** @param {string} codeBody */
export async function findSeat(codeBody) {
  await ensureLicenseIndexes();
  return col(SEATS).then((c) => c.findOne({ codeBody }));
}

/** @param {string} codeBody @param {string} machineId */
export async function findSeatByCodeAndMachine(codeBody, machineId) {
  await ensureLicenseIndexes();
  if (!machineId) return null;
  return col(SEATS).then((c) => c.findOne({ codeBody, machineId }));
}

/** @param {string} machineId */
export async function findSeatByMachine(machineId) {
  await ensureLicenseIndexes();
  return col(SEATS).then((c) => c.findOne({ machineId }));
}

/**
 * Admin issue — always insert a new seat slot (same floating code may repeat).
 * @param {{ codeBody: string, kind: string, expires: string|null, tier?: string, updatedAt: string }} row
 */
export async function insertSeatIssued(row) {
  await ensureLicenseIndexes();
  const c = await col(SEATS);
  const seatId = randomUUID();
  await c.insertOne({
    seatId,
    codeBody: row.codeBody,
    kind: row.kind,
    expires: row.expires,
    tier: row.tier || "cad",
    machineId: null,
    activatedAt: null,
    updatedAt: row.updatedAt,
    issuedAt: row.updatedAt,
  });
  return seatId;
}

/**
 * @deprecated use insertSeatIssued — kept for callers; now inserts a slot.
 * @param {{ codeBody: string, kind: string, expires: string|null, tier?: string, updatedAt: string }} row
 */
export async function upsertSeatIssued(row) {
  return insertSeatIssued(row);
}

/**
 * 업그레이드 / 갱신 — 같은 코드의 모든 좌석 자격을 올린다.
 * @param {{ codeBody: string, tier?: string, expires?: string|null, updatedAt: string }} row
 */
export async function updateSeatEntitlement(row) {
  await ensureLicenseIndexes();
  const c = await col(SEATS);
  const set = { updatedAt: row.updatedAt };
  if (row.tier) set.tier = row.tier;
  if (row.expires !== undefined) set.expires = row.expires;
  const r = await c.updateMany({ codeBody: row.codeBody }, { $set: set });
  if (!r.matchedCount) return null;
  return c.findOne({ codeBody: row.codeBody });
}

/**
 * Activate: rebind same machine, else claim a free slot, else create one if none issued.
 * @param {{ codeBody: string, kind: string, expires: string|null, tier?: string, machineId: string, activatedAt: string, updatedAt: string }} row
 */
export async function claimSeatActivated(row) {
  await ensureLicenseIndexes();
  const c = await col(SEATS);

  const mine = await c.findOne({ codeBody: row.codeBody, machineId: row.machineId });
  if (mine) {
    await c.updateOne(
      { _id: mine._id },
      {
        $set: {
          kind: row.kind,
          expires: row.expires,
          activatedAt: row.activatedAt,
          updatedAt: row.updatedAt,
        },
      },
    );
    return { ...mine, kind: row.kind, expires: row.expires, activatedAt: row.activatedAt };
  }

  const free = await c.findOneAndUpdate(
    {
      codeBody: row.codeBody,
      $or: [{ machineId: null }, { machineId: { $exists: false } }, { machineId: "" }],
    },
    {
      $set: {
        kind: row.kind,
        expires: row.expires,
        machineId: row.machineId,
        activatedAt: row.activatedAt,
        updatedAt: row.updatedAt,
      },
    },
    { returnDocument: "after" },
  );
  const claimed = free?.value ?? free;
  if (claimed && claimed.machineId === row.machineId) {
    return claimed;
  }

  const any = await c.findOne({ codeBody: row.codeBody });
  if (any) {
    const err = new Error("seat_in_use");
    err.code = "seat_in_use";
    throw err;
  }

  // 미발급 코드 — 레거시: 첫 등록 시 좌석 1개 생성
  const seatId = randomUUID();
  const doc = {
    seatId,
    codeBody: row.codeBody,
    kind: row.kind,
    expires: row.expires,
    tier: row.tier || "cad",
    machineId: row.machineId,
    activatedAt: row.activatedAt,
    updatedAt: row.updatedAt,
    issuedAt: row.updatedAt,
  };
  await c.insertOne(doc);
  return doc;
}

/** @deprecated prefer claimSeatActivated */
export async function upsertSeatActivated(row) {
  return claimSeatActivated(row);
}

/**
 * Clear binding for one seat (by machine), or first occupied seat for the code.
 * @param {string} codeBody
 * @param {string} updatedAt
 * @param {string} [machineId]
 */
export async function clearSeat(codeBody, updatedAt, machineId) {
  await ensureLicenseIndexes();
  const c = await col(SEATS);
  if (machineId) {
    await c.updateOne(
      { codeBody, machineId },
      { $set: { machineId: null, activatedAt: null, updatedAt } },
    );
    return;
  }
  await c.findOneAndUpdate(
    { codeBody, machineId: { $nin: [null, ""] } },
    { $set: { machineId: null, activatedAt: null, updatedAt } },
  );
}

/** @param {string} codeBody @param {string} machineId */
export async function deleteRevocation(codeBody, machineId) {
  await ensureLicenseIndexes();
  const c = await col(REVOCATIONS);
  await c.deleteOne({ codeBody, machineId });
}

/**
 * @param {{ codeBody: string, machineId: string, revokedAt: string, reason: string }} row
 */
export async function upsertRevocation(row) {
  await ensureLicenseIndexes();
  const c = await col(REVOCATIONS);
  await c.updateOne(
    { codeBody: row.codeBody, machineId: row.machineId },
    {
      $set: {
        revokedAt: row.revokedAt,
        reason: row.reason,
      },
      $setOnInsert: {
        codeBody: row.codeBody,
        machineId: row.machineId,
      },
    },
    { upsert: true },
  );
}

/** @param {string} codeBody @param {string} machineId */
export async function findRevocation(codeBody, machineId) {
  await ensureLicenseIndexes();
  return col(REVOCATIONS).then((c) => c.findOne({ codeBody, machineId }));
}

export async function listSeats(limit = 200) {
  await ensureLicenseIndexes();
  const c = await col(SEATS);
  return c.find({}).sort({ updatedAt: -1 }).limit(Math.min(limit, 500)).toArray();
}

export async function listRevocations(limit = 100) {
  await ensureLicenseIndexes();
  const c = await col(REVOCATIONS);
  return c.find({}).sort({ revokedAt: -1 }).limit(Math.min(limit, 500)).toArray();
}

export async function listAudit(limit = 100) {
  await ensureLicenseIndexes();
  const c = await col(AUDIT);
  return c.find({}).sort({ at: -1 }).limit(Math.min(limit, 500)).toArray();
}

export async function countSeatsForCode(codeBody) {
  await ensureLicenseIndexes();
  const c = await col(SEATS);
  const total = await c.countDocuments({ codeBody });
  const used = await c.countDocuments({
    codeBody,
    machineId: { $nin: [null, ""] },
  });
  return { total, used, free: Math.max(0, total - used) };
}
