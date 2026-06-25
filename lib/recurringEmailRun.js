import { sendListTemplateEmail } from "./listTemplateEmail.js";
import { buildSectionExcelAttachments } from "./listTemplateExcelExport.js";
import { isEmailConfigured } from "./mail.js";
import { isMongoConfigured } from "./mongo.js";
import { buildRecurringEmailSection } from "./recurringEmailSections.js";
import { isRecurringEmailDue, localDateInTimezone, sanitizeTimeLocal } from "./recurringEmailTime.js";
import {
  listDueRecurringEmails,
  markRecurringBatchAttemptFailed,
  markRecurringBatchSent,
  markRecurringEmailGroupAttemptFailed,
  markRecurringEmailGroupSent,
  normalizeRecurringRow,
} from "./recurringEmailStore.js";
import { wakeBackendIfConfigured } from "./scheduledEmailWake.js";

const MAX_RECURRING_BATCHES_PER_RUN = 8;

export function recurringSendGroupKey(job) {
  const rec = [...(job.recipients ?? [])].sort().join(",");
  const tz = String(job.timezone ?? "Asia/Seoul");
  const time = sanitizeTimeLocal(job.timeLocal);
  return `${job.userId}|${tz}|${time}|${rec}`;
}

function isModernBatch(row) {
  return Boolean(
    row?.scheduleId &&
    !String(row.scheduleId).startsWith("legacy:") &&
    Array.isArray(row.templates) &&
    row.templates.length > 0
  );
}

function mergeLegacyJobsToBatch(jobs) {
  const first = jobs[0];
  return {
    userId: first.userId,
    scheduleId: `legacy:${recurringSendGroupKey(first)}`,
    recipients: first.recipients ?? [],
    timeLocal: first.timeLocal,
    timezone: first.timezone ?? "Asia/Seoul",
    templates: jobs.map((j) => j.template).filter(Boolean),
    note: jobs.map((j) => j.note).find((n) => String(n ?? "").trim()) ?? null,
    _legacyTemplateIds: jobs.map((j) => j.templateId).filter(Boolean),
  };
}

function toSendBatches(candidates, now) {
  const due = candidates.filter((row) => isRecurringEmailDue(row, now));
  const modern = [];
  const legacy = [];

  for (const raw of due) {
    const row = normalizeRecurringRow(raw);
    if (!row) continue;
    if (isModernBatch(row)) {
      modern.push(row);
    } else {
      legacy.push(row);
    }
  }

  const legacyMap = new Map();
  for (const row of legacy) {
    const key = recurringSendGroupKey(row);
    const list = legacyMap.get(key);
    if (list) list.push(row);
    else legacyMap.set(key, [row]);
  }

  const legacyBatches = [...legacyMap.values()].map((jobs) => mergeLegacyJobsToBatch(jobs));
  return [...modern, ...legacyBatches];
}

async function buildSectionForTemplate(template) {
  try {
    return await buildRecurringEmailSection(template);
  } catch (e) {
    const tableKey = String(template?.tableKey ?? "");
    return {
      templateId: template?.id,
      templateName: template?.name ?? template?.id,
      categoryLabel: tableKey,
      headers: ["No"],
      rows: [],
      totalMatched: 0,
      truncated: false,
      fetchNote: `MongoDB 탭 동기화 스냅샷 · 매일 반복 발송 (${e?.message || "조회 실패"})`,
    };
  }
}

async function sendRecurringBatch(batch, now) {
  const tz = batch.timezone ?? "Asia/Seoul";
  const localDate = localDateInTimezone(now, tz);
  const templates = Array.isArray(batch.templates) ? batch.templates : [];
  const sections = [];
  for (const template of templates) {
    sections.push(await buildSectionForTemplate(template));
  }
  const attachments = buildSectionExcelAttachments(sections);
  const note = String(batch.note ?? "").trim();

  await sendListTemplateEmail({
    to: batch.recipients ?? [],
    sections,
    note,
    attachments,
  });

  const legacyIds = batch._legacyTemplateIds ?? [];
  if (isModernBatch(batch)) {
    await markRecurringBatchSent(batch.userId, batch.scheduleId, localDate, legacyIds);
  } else if (legacyIds.length > 0) {
    await markRecurringEmailGroupSent(batch.userId, legacyIds, localDate);
  }

  return {
    scheduleId: batch.scheduleId,
    userId: batch.userId,
    templateCount: sections.length,
    rowCount: sections.reduce((n, s) => n + (s.rows?.length ?? 0), 0),
  };
}

async function failRecurringBatch(batch, error) {
  const err = error?.message || "send_failed";
  const legacyIds = batch._legacyTemplateIds ?? [];
  if (isModernBatch(batch)) {
    await markRecurringBatchAttemptFailed(batch.userId, batch.scheduleId, err, legacyIds);
  } else if (legacyIds.length > 0) {
    await markRecurringEmailGroupAttemptFailed(batch.userId, legacyIds, err);
  }
  return err;
}

/**
 * cron — 매일 지정 시각 반복 메일 (배치 1문서 = 메일 1통 + 템플릿별 엑셀)
 */
export async function runDueRecurringEmails() {
  if (!isMongoConfigured()) {
    return { ok: false, error: "mongodb_not_configured", processed: 0, results: [] };
  }
  if (!isEmailConfigured()) {
    return { ok: false, error: "email_unconfigured", processed: 0, results: [] };
  }

  await wakeBackendIfConfigured();

  const candidates = await listDueRecurringEmails();
  const now = new Date();
  const batches = toSendBatches(candidates, now);
  const skippedNotDue = candidates.length - batches.reduce((n, b) => n + (b.templates?.length ?? 0), 0);
  const results = [];

  for (const batch of batches) {
    if (results.length >= MAX_RECURRING_BATCHES_PER_RUN) break;
    const tag = `[recurring-email][${String(batch.scheduleId).slice(0, 16)}]`;
    try {
      const sent = await sendRecurringBatch(batch, now);
      console.log(
        `${tag} sent · templates=${sent.templateCount} rows=${sent.rowCount} to=${(batch.recipients ?? []).length}`
      );
      results.push({ ...sent, ok: true });
    } catch (e) {
      const err = await failRecurringBatch(batch, e);
      console.log(`${tag} failed — ${err} (will retry on next tick)`);
      results.push({
        scheduleId: batch.scheduleId,
        userId: batch.userId,
        ok: false,
        error: err,
      });
    }
  }

  if (results.length > 0) {
    console.log(`[recurring-email] run done · batches=${results.length}`);
  } else if (candidates.length > 0) {
    console.log(
      `[recurring-email] no send · enabled=${candidates.length} not_due=${skippedNotDue} at=${now.toISOString()}`
    );
  }

  return {
    ok: results.every((r) => r.ok) || results.length === 0,
    processed: results.length,
    enabled: candidates.length,
    skippedNotDue,
    results,
    at: new Date().toISOString(),
  };
}
