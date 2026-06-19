import crypto from "node:crypto";
import { getDb, isMongoConfigured } from "./mongo.js";

export const SCHEDULED_EMAILS_COLLECTION = "scheduled_list_emails";

const ALLOWED_TIMEZONES = new Set(["Asia/Seoul", "UTC", "Asia/Tokyo"]);

let indexesReady = false;

export async function ensureScheduledEmailIndexes() {
  if (!isMongoConfigured() || indexesReady) return;
  const db = await getDb();
  const col = db.collection(SCHEDULED_EMAILS_COLLECTION);
  await col.createIndex({ userId: 1, scheduledAt: -1 });
  await col.createIndex({ status: 1, scheduledAt: 1 });
  await col.createIndex({ id: 1 }, { unique: true });
  indexesReady = true;
}

export function sanitizeTimezone(raw) {
  const tz = String(raw ?? "Asia/Seoul").trim();
  return ALLOWED_TIMEZONES.has(tz) ? tz : "Asia/Seoul";
}

export function parseScheduledAtUtc(isoUtc) {
  const d = new Date(String(isoUtc ?? ""));
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

export async function listScheduledEmailsForUser(userId) {
  await ensureScheduledEmailIndexes();
  const db = await getDb();
  const rows = await db
    .collection(SCHEDULED_EMAILS_COLLECTION)
    .find({ userId })
    .project({
      _id: 0,
      id: 1,
      recipients: 1,
      templateIds: 1,
      note: 1,
      timezone: 1,
      scheduledAt: 1,
      status: 1,
      createdAt: 1,
      sentAt: 1,
      error: 1,
      rowCount: 1,
      emailCount: 1,
    })
    .sort({ scheduledAt: 1 })
    .limit(50)
    .toArray();
  return rows.map((r) => ({
    ...r,
    scheduledAt: r.scheduledAt instanceof Date ? r.scheduledAt.toISOString() : r.scheduledAt,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    sentAt: r.sentAt instanceof Date ? r.sentAt.toISOString() : r.sentAt ?? null,
  }));
}

export async function insertScheduledEmail(doc) {
  await ensureScheduledEmailIndexes();
  const db = await getDb();
  await db.collection(SCHEDULED_EMAILS_COLLECTION).insertOne(doc);
  return doc;
}

export async function cancelScheduledEmail(userId, id) {
  await ensureScheduledEmailIndexes();
  const db = await getDb();
  const result = await db.collection(SCHEDULED_EMAILS_COLLECTION).updateOne(
    { userId, id, status: "pending" },
    { $set: { status: "cancelled", updatedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

export async function claimDueScheduledEmail(now = new Date()) {
  await ensureScheduledEmailIndexes();
  const db = await getDb();
  return db.collection(SCHEDULED_EMAILS_COLLECTION).findOneAndUpdate(
    { status: "pending", scheduledAt: { $lte: now } },
    { $set: { status: "processing", lastAttemptAt: now } },
    { sort: { scheduledAt: 1 }, returnDocument: "after" }
  );
}

export async function markScheduledEmailSent(id, meta = {}) {
  const db = await getDb();
  await db.collection(SCHEDULED_EMAILS_COLLECTION).updateOne(
    { id },
    {
      $set: {
        status: "sent",
        sentAt: new Date(),
        rowCount: meta.rowCount ?? null,
        emailCount: meta.emailCount ?? null,
        error: null,
      },
    }
  );
}

export async function markScheduledEmailFailed(id, error) {
  const db = await getDb();
  await db.collection(SCHEDULED_EMAILS_COLLECTION).updateOne(
    { id },
    { $set: { status: "failed", error: String(error ?? "send_failed").slice(0, 500) } }
  );
}

export function newScheduledEmailId() {
  return crypto.randomUUID();
}

export async function getEmailSchedulePrefs(userId) {
  const db = await getDb();
  const user = await db.collection("users").findOne(
    { userId },
    { projection: { emailSchedulePrefs: 1, userId: 1 } }
  );
  const prefs = user?.emailSchedulePrefs ?? {};
  return {
    recipients: Array.isArray(prefs.recipients) ? prefs.recipients : [],
    timezone: sanitizeTimezone(prefs.timezone),
  };
}

export async function saveEmailSchedulePrefs(userId, { recipients, timezone }) {
  const db = await getDb();
  const now = new Date();
  await db.collection("users").updateOne(
    { userId },
    {
      $set: {
        emailSchedulePrefs: {
          recipients: recipients ?? [],
          timezone: sanitizeTimezone(timezone),
          updatedAt: now,
        },
        updatedAt: now,
      },
    },
    { upsert: true }
  );
}
