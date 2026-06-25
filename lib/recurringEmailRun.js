import { sendListTemplateEmail } from "./listTemplateEmail.js";
import { buildSectionExcelAttachments } from "./listTemplateExcelExport.js";
import { isEmailConfigured } from "./mail.js";
import { isMongoConfigured } from "./mongo.js";
import { buildRecurringEmailSection } from "./recurringEmailSections.js";
import {
  isRecurringEmailDue,
  localDateInTimezone,
  sanitizeTimeLocal,
} from "./recurringEmailTime.js";
import {
  listDueRecurringEmails,
  markRecurringEmailGroupAttemptFailed,
  markRecurringEmailGroupSent,
} from "./recurringEmailStore.js";
import { wakeBackendIfConfigured } from "./scheduledEmailWake.js";

const MAX_RECURRING_GROUPS_PER_RUN = 8;

/** 동일 수신·동일 시각 예약 — 한 통 메일로 묶음 (즉시 발송과 동일) */
export function recurringSendGroupKey(job) {
  const rec = [...(job.recipients ?? [])].sort().join(",");
  const tz = String(job.timezone ?? "Asia/Seoul");
  const time = sanitizeTimeLocal(job.timeLocal);
  return `${job.userId}|${tz}|${time}|${rec}`;
}

function groupDueRecurringJobs(candidates, now) {
  const due = candidates.filter((job) => isRecurringEmailDue(job, now));
  const map = new Map();
  for (const job of due) {
    const key = recurringSendGroupKey(job);
    const list = map.get(key);
    if (list) list.push(job);
    else map.set(key, [job]);
  }
  return [...map.values()];
}

async function buildSectionForJob(job) {
  try {
    return await buildRecurringEmailSection(job.template);
  } catch (e) {
    const template = job.template ?? {};
    const tableKey = String(template.tableKey ?? "");
    return {
      templateId: template.id ?? job.templateId,
      templateName: template.name ?? job.templateId,
      categoryLabel: tableKey,
      headers: ["No"],
      rows: [],
      totalMatched: 0,
      truncated: false,
      fetchNote: `MongoDB 탭 동기화 스냅샷 · 매일 반복 발송 (${e?.message || "조회 실패"})`,
    };
  }
}

/**
 * cron — 매일 지정 시각 반복 메일 (5분 cron 과 함께 호출)
 * 같은 수신·시각의 템플릿은 즉시 발송처럼 메일 1통 + 템플릿별 엑셀 첨부
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
  const groups = groupDueRecurringJobs(candidates, now);
  const skippedNotDue = candidates.length - groups.reduce((n, g) => n + g.length, 0);
  const results = [];

  for (const jobs of groups) {
    if (results.length >= MAX_RECURRING_GROUPS_PER_RUN) break;
    if (jobs.length === 0) continue;

    const first = jobs[0];
    const tag = `[recurring-email][group:${String(first.timeLocal)}]`;
    const tz = first.timezone ?? "Asia/Seoul";
    const localDate = localDateInTimezone(now, tz);
    const templateIds = jobs.map((j) => j.templateId);
    const recipients = first.recipients ?? [];

    try {
      const sections = [];
      for (const job of jobs) {
        sections.push(await buildSectionForJob(job));
      }
      const attachments = buildSectionExcelAttachments(sections);
      const note = jobs.map((j) => j.note).find((n) => String(n ?? "").trim()) ?? "";

      await sendListTemplateEmail({
        to: recipients,
        sections,
        note,
        attachments,
      });

      await markRecurringEmailGroupSent(first.userId, templateIds, localDate);
      const rowCount = sections.reduce((n, s) => n + (s.rows?.length ?? 0), 0);
      console.log(
        `${tag} sent · templates=${sections.length} rows=${rowCount} excel=${attachments.length} to=${recipients.length}`
      );
      results.push({
        groupKey: recurringSendGroupKey(first),
        userId: first.userId,
        templateIds,
        ok: true,
        rowCount,
        templateCount: sections.length,
      });
    } catch (e) {
      const err = e?.message || "send_failed";
      await markRecurringEmailGroupAttemptFailed(first.userId, templateIds, err);
      console.log(`${tag} failed — ${err} (will retry on next tick)`);
      results.push({
        groupKey: recurringSendGroupKey(first),
        userId: first.userId,
        templateIds,
        ok: false,
        error: err,
      });
    }
  }

  if (results.length > 0) {
    console.log(`[recurring-email] run done · groups=${results.length}`);
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
