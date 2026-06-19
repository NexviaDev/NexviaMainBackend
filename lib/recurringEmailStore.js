import { getDb, isMongoConfigured } from "./mongo.js";
import { sanitizeTimezone } from "./scheduledEmailStore.js";
import { sanitizeTimeLocal } from "./recurringEmailTime.js";
import { sanitizeEmailList, isDefaultListTemplateId } from "./listTemplateEmailPayload.js";

export const RECURRING_EMAILS_COLLECTION = "template_recurring_emails";

const MAX_RECURRING_PER_USER = 30;

let indexesReady = false;

export async function ensureRecurringEmailIndexes() {
  if (!isMongoConfigured() || indexesReady) return;
  const db = await getDb();
  const col = db.collection(RECURRING_EMAILS_COLLECTION);
  await col.createIndex({ userId: 1, templateId: 1 }, { unique: true });
  await col.createIndex({ enabled: 1, timezone: 1 });
  indexesReady = true;
}

function sanitizeTemplateSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim();
  const tableKey = String(raw.tableKey ?? "").trim();
  const name = String(raw.name ?? "").trim().slice(0, 80);
  if (!id || !tableKey || !name) return null;
  const sort =
    raw.sort && typeof raw.sort === "object" && raw.sort.col
      ? { col: String(raw.sort.col).trim(), dir: raw.sort.dir === "asc" ? "asc" : "desc" }
      : null;
  const columnFilters = {};
  if (raw.columnFilters && typeof raw.columnFilters === "object") {
    for (const [k, v] of Object.entries(raw.columnFilters)) {
      const key = String(k).trim();
      const val = String(v ?? "").trim();
      if (key && val) columnFilters[key] = val.slice(0, 200);
    }
  }
  const columnOrder = Array.isArray(raw.columnOrder)
    ? raw.columnOrder.map((c) => String(c).trim()).filter(Boolean).slice(0, 40)
    : [];
  const hiddenColumns = Array.isArray(raw.hiddenColumns)
    ? raw.hiddenColumns.map((c) => String(c).trim()).filter(Boolean).slice(0, 40)
    : [];
  return { id, name, tableKey, sort, columnFilters, columnOrder, hiddenColumns };
}

export async function listRecurringEmailsForUser(userId) {
  await ensureRecurringEmailIndexes();
  const db = await getDb();
  const rows = await db
    .collection(RECURRING_EMAILS_COLLECTION)
    .find({ userId })
    .project({
      _id: 0,
      templateId: 1,
      enabled: 1,
      recipients: 1,
      timezone: 1,
      timeLocal: 1,
      repeat: 1,
      note: 1,
      template: 1,
      lastSentLocalDate: 1,
      lastSentAt: 1,
      lastSendError: 1,
      lastSendAttemptAt: 1,
      updatedAt: 1,
    })
    .sort({ templateId: 1 })
    .limit(MAX_RECURRING_PER_USER)
    .toArray();
  return rows.map((r) => ({
    ...r,
    lastSentAt: r.lastSentAt instanceof Date ? r.lastSentAt.toISOString() : r.lastSentAt ?? null,
    lastSendAttemptAt:
      r.lastSendAttemptAt instanceof Date
        ? r.lastSendAttemptAt.toISOString()
        : r.lastSendAttemptAt ?? null,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt ?? null,
  }));
}

export async function listDueRecurringEmails(now = new Date()) {
  await ensureRecurringEmailIndexes();
  const db = await getDb();
  return db
    .collection(RECURRING_EMAILS_COLLECTION)
    .find({ enabled: true })
    .limit(50)
    .toArray();
}

export async function upsertRecurringEmail(userId, templateId, payload, ownedTemplateIds) {
  await ensureRecurringEmailIndexes();
  const id = String(templateId ?? "").trim();
  if (!id) throw new Error("invalid_template_id");
  const isOwned = ownedTemplateIds.has(id);
  if (!isOwned && !isDefaultListTemplateId(id)) {
    throw new Error("template_not_owned");
  }

  const recipients = sanitizeEmailList(payload.recipients ?? payload.to);
  const timezone = sanitizeTimezone(payload.timezone);
  const timeLocal = sanitizeTimeLocal(payload.timeLocal);
  const enabled = Boolean(payload.enabled);
  const note = String(payload.note ?? "")
    .trim()
    .slice(0, 500);
  const template = sanitizeTemplateSnapshot(payload.template);
  if (!template || template.id !== id) {
    throw new Error("invalid_template_snapshot");
  }

  if (enabled && recipients.length === 0) {
    throw new Error("invalid_recipients");
  }

  const db = await getDb();
  const col = db.collection(RECURRING_EMAILS_COLLECTION);
  const existing = await col.findOne({ userId, templateId: id });
  if (!existing) {
    const count = await col.countDocuments({ userId });
    if (count >= MAX_RECURRING_PER_USER) {
      throw new Error("limit_reached");
    }
  }

  const now = new Date();
  const scheduleChanged =
    existing != null &&
    (sanitizeTimeLocal(existing.timeLocal) !== timeLocal ||
      sanitizeTimezone(existing.timezone) !== timezone);

  const doc = {
    userId,
    templateId: id,
    enabled,
    recipients,
    timezone,
    timeLocal,
    repeat: "daily",
    note: note || null,
    template,
    updatedAt: now,
  };
  if (!existing) {
    doc.createdAt = now;
    doc.lastSentLocalDate = null;
    doc.lastSentAt = null;
    doc.lastSendError = null;
    doc.lastSendAttemptAt = null;
  } else if (scheduleChanged) {
    doc.lastSentLocalDate = null;
    doc.lastSentAt = null;
    doc.lastSendError = null;
    doc.lastSendAttemptAt = null;
  }

  await col.updateOne({ userId, templateId: id }, { $set: doc }, { upsert: true });
  return { doc, scheduleChanged: Boolean(scheduleChanged) };
}

export async function disableRecurringEmail(userId, templateId) {
  await ensureRecurringEmailIndexes();
  const db = await getDb();
  const result = await db.collection(RECURRING_EMAILS_COLLECTION).updateOne(
    { userId, templateId: String(templateId).trim() },
    { $set: { enabled: false, updatedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

export async function markRecurringEmailSent(userId, templateId, localDate) {
  const db = await getDb();
  await db.collection(RECURRING_EMAILS_COLLECTION).updateOne(
    { userId, templateId },
    {
      $set: {
        lastSentLocalDate: localDate,
        lastSentAt: new Date(),
        lastSendError: null,
        lastSendAttemptAt: null,
      },
    }
  );
}

/** 발송 실패 — lastSentLocalDate 는 건드리지 않음 → 다음 tick 에 재시도 */
export async function markRecurringEmailAttemptFailed(userId, templateId, error) {
  const db = await getDb();
  await db.collection(RECURRING_EMAILS_COLLECTION).updateOne(
    { userId, templateId },
    {
      $set: {
        lastSendError: String(error ?? "send_failed").slice(0, 500),
        lastSendAttemptAt: new Date(),
      },
    }
  );
}

export { MAX_RECURRING_PER_USER };
