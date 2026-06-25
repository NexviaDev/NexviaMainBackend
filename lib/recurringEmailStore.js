import crypto from "node:crypto";
import { getDb, isMongoConfigured } from "./mongo.js";
import { sanitizeTimezone } from "./scheduledEmailStore.js";
import { sanitizeTimeLocal } from "./recurringEmailTime.js";
import {
  sanitizeEmailList,
  isDefaultListTemplateId,
  MAX_SEND_TEMPLATE_IDS,
} from "./listTemplateEmailPayload.js";

export const RECURRING_EMAILS_COLLECTION = "template_recurring_emails";

const MAX_RECURRING_PER_USER = 30;

let indexesReady = false;

export function newRecurringScheduleId() {
  return crypto.randomUUID();
}

function recipientsKey(recipients) {
  return [...(recipients ?? [])].sort().join(",");
}

/** 기존 non-sparse 인덱스와 충돌 시 드롭 후 재생성 */
async function dropIndexIfExists(col, name) {
  try {
    await col.dropIndex(name);
  } catch (e) {
    if (e?.code !== 27 && !String(e?.message ?? "").includes("index not found")) {
      throw e;
    }
  }
}

async function ensureCollectionIndex(col, keys, options) {
  const name =
    options.name ??
    Object.entries(keys)
      .map(([k, v]) => `${k}_${v}`)
      .join("_");
  const opts = { ...options, name };
  try {
    await col.createIndex(keys, opts);
    return;
  } catch (e) {
    const code = e?.code;
    const msg = String(e?.message ?? e);
    if (code === 85 || msg.includes("same name")) {
      try {
        await col.dropIndex(name);
      } catch {
        /* index may already be gone */
      }
      await col.createIndex(keys, opts);
      return;
    }
    if (code === 86) {
      const existing = await col.listIndexes().toArray();
      const keyStr = JSON.stringify(keys);
      for (const idx of existing) {
        if (JSON.stringify(idx.key) === keyStr && idx.name !== name) {
          try {
            await col.dropIndex(idx.name);
          } catch {
            /* ignore */
          }
        }
      }
      await col.createIndex(keys, opts);
      return;
    }
    if (code === 68 || msg.includes("already exists")) return;
    throw e;
  }
}

export async function ensureRecurringEmailIndexes() {
  if (!isMongoConfigured() || indexesReady) return;
  const db = await getDb();
  const col = db.collection(RECURRING_EMAILS_COLLECTION);
  try {
    await dropIndexIfExists(col, "userId_1_templateId_1");
    await dropIndexIfExists(col, "userId_1_scheduleId_1");

    // 구형(템플릿당 1문서): templateId 있는 행만 유니크
    await ensureCollectionIndex(
      col,
      { userId: 1, templateId: 1 },
      {
        unique: true,
        name: "userId_1_templateId_1",
        partialFilterExpression: { templateId: { $exists: true, $type: "string" } },
      }
    );
    // 배치(예약 1건): scheduleId 있는 행만 유니크
    await ensureCollectionIndex(
      col,
      { userId: 1, scheduleId: 1 },
      {
        unique: true,
        name: "userId_1_scheduleId_1",
        partialFilterExpression: { scheduleId: { $exists: true, $type: "string" } },
      }
    );
    await ensureCollectionIndex(col, { enabled: 1, timezone: 1 }, { name: "enabled_1_timezone_1" });
    indexesReady = true;
  } catch (e) {
    console.error("[recurring-email] index ensure failed:", e?.message || e);
  }
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

function sanitizeTemplatesArray(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const t = sanitizeTemplateSnapshot(item);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= MAX_SEND_TEMPLATE_IDS) break;
  }
  return out;
}

/** 구형(템플릿당 1문서) → 배치 형태로 통일 */
export function normalizeRecurringRow(row) {
  if (!row || typeof row !== "object") return null;
  if (row.scheduleId && Array.isArray(row.templates) && row.templates.length > 0) {
    return row;
  }
  if (row.templateId && row.template) {
    return {
      ...row,
      scheduleId: String(row.scheduleId ?? row.templateId),
      templates: [row.template],
      _legacyTemplateIds: [row.templateId],
    };
  }
  return null;
}

function serializeRecurringRow(r) {
  return {
    scheduleId: r.scheduleId,
    enabled: Boolean(r.enabled),
    recipients: r.recipients ?? [],
    timezone: r.timezone,
    timeLocal: r.timeLocal,
    repeat: r.repeat ?? "daily",
    note: r.note ?? null,
    templates: (r.templates ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      tableKey: t.tableKey,
    })),
    lastSentLocalDate: r.lastSentLocalDate ?? null,
    lastSentAt: r.lastSentAt instanceof Date ? r.lastSentAt.toISOString() : r.lastSentAt ?? null,
    lastSendError: r.lastSendError ?? null,
    lastSendAttemptAt:
      r.lastSendAttemptAt instanceof Date
        ? r.lastSendAttemptAt.toISOString()
        : r.lastSendAttemptAt ?? null,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt ?? null,
  };
}

export async function listRecurringEmailsForUser(userId) {
  await ensureRecurringEmailIndexes();
  const db = await getDb();
  const rows = await db
    .collection(RECURRING_EMAILS_COLLECTION)
    .find({ userId })
    .sort({ updatedAt: -1, scheduleId: 1, templateId: 1 })
    .limit(MAX_RECURRING_PER_USER * 4)
    .toArray();

  const batchMap = new Map();
  const legacyRows = [];

  for (const raw of rows) {
    const norm = normalizeRecurringRow(raw);
    if (!norm) continue;
    if (raw.scheduleId && Array.isArray(raw.templates) && raw.templates.length > 0 && !raw.templateId) {
      batchMap.set(norm.scheduleId, serializeRecurringRow({ ...raw, ...norm }));
    } else {
      legacyRows.push(norm);
    }
  }

  for (const leg of legacyRows) {
    const recKey = recipientsKey(leg.recipients);
    const slotKey = `${sanitizeTimeLocal(leg.timeLocal)}|${leg.timezone ?? "Asia/Seoul"}|${recKey}`;
    const existing = batchMap.get(`legacy:${slotKey}`);
    if (existing) {
      existing.templates.push(...leg.templates.map((t) => ({ id: t.id, name: t.name, tableKey: t.tableKey })));
      if (leg.lastSentAt && (!existing.lastSentAt || leg.lastSentAt > existing.lastSentAt)) {
        existing.lastSentAt = leg.lastSentAt;
      }
      if (leg.lastSendError) existing.lastSendError = leg.lastSendError;
    } else {
      batchMap.set(`legacy:${slotKey}`, {
        ...serializeRecurringRow({ ...leg, scheduleId: `legacy:${slotKey}` }),
        scheduleId: `legacy:${slotKey}`,
      });
    }
  }

  return [...batchMap.values()].slice(0, MAX_RECURRING_PER_USER);
}

export async function listDueRecurringEmails() {
  await ensureRecurringEmailIndexes();
  const db = await getDb();
  const rows = await db.collection(RECURRING_EMAILS_COLLECTION).find({ enabled: true }).limit(80).toArray();
  return rows.map((r) => normalizeRecurringRow(r)).filter(Boolean);
}

async function findBatchBySlot(userId, timeLocal, timezone, recipients) {
  const db = await getDb();
  const key = recipientsKey(recipients);
  const rows = await db
    .collection(RECURRING_EMAILS_COLLECTION)
    .find({
      userId,
      scheduleId: { $exists: true },
      timeLocal: sanitizeTimeLocal(timeLocal),
      timezone: sanitizeTimezone(timezone),
      enabled: true,
    })
    .toArray();
  return rows.find((r) => recipientsKey(r.recipients) === key) ?? null;
}

/** 발송 목록 여러 템플릿 → MongoDB 문서 1건 */
export async function upsertRecurringBatch(userId, payload, ownedTemplateIds) {
  await ensureRecurringEmailIndexes();
  const templates = sanitizeTemplatesArray(payload.templates);
  if (templates.length === 0) throw new Error("invalid_templates");

  for (const t of templates) {
    if (!ownedTemplateIds.has(t.id) && !isDefaultListTemplateId(t.id)) {
      throw new Error("template_not_owned");
    }
  }

  const recipients = sanitizeEmailList(payload.recipients ?? payload.to);
  const timezone = sanitizeTimezone(payload.timezone);
  const timeLocal = sanitizeTimeLocal(payload.timeLocal);
  const enabled = payload.enabled !== false;
  const note = String(payload.note ?? "")
    .trim()
    .slice(0, 500);

  if (enabled && recipients.length === 0) {
    throw new Error("invalid_recipients");
  }

  const db = await getDb();
  const col = db.collection(RECURRING_EMAILS_COLLECTION);

  const slotBatch = await findBatchBySlot(userId, timeLocal, timezone, recipients);
  const scheduleId = String(payload.scheduleId ?? slotBatch?.scheduleId ?? newRecurringScheduleId()).trim();
  const existing = await col.findOne({ userId, scheduleId });
  if (!existing && !slotBatch) {
    const count = await col.countDocuments({ userId, scheduleId: { $exists: true }, enabled: true });
    if (count >= MAX_RECURRING_PER_USER) {
      throw new Error("limit_reached");
    }
  }

  const templateIds = templates.map((t) => t.id);
  await col.deleteMany({
    userId,
    templateId: { $in: templateIds },
    scheduleId: { $exists: false },
  });

  const now = new Date();
  const scheduleChanged =
    existing != null &&
    (sanitizeTimeLocal(existing.timeLocal) !== timeLocal ||
      sanitizeTimezone(existing.timezone) !== timezone);

  const doc = {
    userId,
    scheduleId,
    enabled,
    recipients,
    timezone,
    timeLocal,
    repeat: "daily",
    note: note || null,
    templates,
    updatedAt: now,
  };

  if (!existing && !slotBatch) {
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

  await col.updateOne(
    { userId, scheduleId },
    { $set: doc, $unset: { templateId: "", template: "" } },
    { upsert: true }
  );

  return { doc, scheduleChanged: Boolean(scheduleChanged) };
}

/** 구형 API — 템플릿 1건 (하위 호환) */
export async function upsertRecurringEmail(userId, templateId, payload, ownedTemplateIds) {
  const template = sanitizeTemplateSnapshot(payload.template);
  if (!template) throw new Error("invalid_template_snapshot");
  return upsertRecurringBatch(
    userId,
    {
      ...payload,
      templates: [template],
      scheduleId: payload.scheduleId,
    },
    ownedTemplateIds
  );
}

export async function disableRecurringBatch(userId, scheduleId) {
  await ensureRecurringEmailIndexes();
  const id = String(scheduleId ?? "").trim();
  if (!id) return false;
  const db = await getDb();
  const col = db.collection(RECURRING_EMAILS_COLLECTION);

  if (id.startsWith("legacy:")) {
    const rest = id.slice("legacy:".length);
    const parts = rest.split("|");
    const timeLocal = sanitizeTimeLocal(parts[0]);
    const timezone = sanitizeTimezone(parts[1]);
    const recKey = parts.slice(2).join("|");
    const rows = await col
      .find({
        userId,
        templateId: { $exists: true },
        scheduleId: { $exists: false },
        enabled: true,
        timeLocal,
        timezone,
      })
      .toArray();
    const templateIds = rows
      .filter((r) => recipientsKey(r.recipients) === recKey)
      .map((r) => r.templateId)
      .filter(Boolean);
    if (templateIds.length === 0) return false;
    const result = await col.updateMany(
      { userId, templateId: { $in: templateIds } },
      { $set: { enabled: false, updatedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  const result = await col.updateOne(
    { userId, scheduleId: id },
    { $set: { enabled: false, updatedAt: new Date() } }
  );
  if (result.modifiedCount > 0) return true;

  const legacy = await col.updateOne(
    { userId, templateId: id },
    { $set: { enabled: false, updatedAt: new Date() } }
  );
  return legacy.modifiedCount > 0;
}

export async function disableRecurringEmail(userId, templateId) {
  return disableRecurringBatch(userId, templateId);
}

export async function markRecurringBatchSent(userId, scheduleId, localDate, legacyTemplateIds = []) {
  const db = await getDb();
  const sid = String(scheduleId ?? "").trim();
  if (sid && !sid.startsWith("legacy:")) {
    await db.collection(RECURRING_EMAILS_COLLECTION).updateOne(
      { userId, scheduleId: sid },
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
  const legacyIds = [...new Set((legacyTemplateIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
  if (legacyIds.length > 0) {
    await db.collection(RECURRING_EMAILS_COLLECTION).updateMany(
      { userId, templateId: { $in: legacyIds } },
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
}

export async function markRecurringBatchAttemptFailed(userId, scheduleId, error, legacyTemplateIds = []) {
  const db = await getDb();
  const sid = String(scheduleId ?? "").trim();
  const err = String(error ?? "send_failed").slice(0, 500);
  if (sid && !sid.startsWith("legacy:")) {
    await db.collection(RECURRING_EMAILS_COLLECTION).updateOne(
      { userId, scheduleId: sid },
      { $set: { lastSendError: err, lastSendAttemptAt: new Date() } }
    );
  }
  const legacyIds = [...new Set((legacyTemplateIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
  if (legacyIds.length > 0) {
    await db.collection(RECURRING_EMAILS_COLLECTION).updateMany(
      { userId, templateId: { $in: legacyIds } },
      { $set: { lastSendError: err, lastSendAttemptAt: new Date() } }
    );
  }
}

export async function markRecurringEmailGroupSent(userId, templateIds, localDate) {
  const ids = [...new Set((templateIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) return;
  const db = await getDb();
  await db.collection(RECURRING_EMAILS_COLLECTION).updateMany(
    { userId, templateId: { $in: ids } },
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

export async function markRecurringEmailGroupAttemptFailed(userId, templateIds, error) {
  const ids = [...new Set((templateIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) return;
  const db = await getDb();
  await db.collection(RECURRING_EMAILS_COLLECTION).updateMany(
    { userId, templateId: { $in: ids } },
    {
      $set: {
        lastSendError: String(error ?? "send_failed").slice(0, 500),
        lastSendAttemptAt: new Date(),
      },
    }
  );
}

export { MAX_RECURRING_PER_USER };
