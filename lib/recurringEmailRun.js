import { sendListTemplateEmail } from "./listTemplateEmail.js";
import { isEmailConfigured } from "./mail.js";
import { isMongoConfigured } from "./mongo.js";
import { buildRecurringEmailSection } from "./recurringEmailSections.js";
import { isRecurringEmailDue, localDateInTimezone } from "./recurringEmailTime.js";
import {
  listDueRecurringEmails,
  markRecurringEmailAttemptFailed,
  markRecurringEmailSent,
} from "./recurringEmailStore.js";
import { wakeBackendIfConfigured } from "./scheduledEmailWake.js";

const MAX_RECURRING_PER_RUN = 8;

/**
 * cron — 매일 지정 시각 반복 메일 (5분 cron 과 함께 호출)
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
  const results = [];
  const now = new Date();
  let skippedNotDue = 0;

  for (const job of candidates) {
    if (results.length >= MAX_RECURRING_PER_RUN) break;
    if (!isRecurringEmailDue(job, now)) {
      skippedNotDue += 1;
      continue;
    }

    const tag = `[recurring-email][${String(job.templateId).slice(0, 12)}]`;
    const tz = job.timezone ?? "Asia/Seoul";
    const localDate = localDateInTimezone(now, tz);

    try {
      const section = await buildRecurringEmailSection(job.template);
      await sendListTemplateEmail({
        to: job.recipients,
        sections: [section],
        note: job.note ?? "",
        attachments: [],
      });
      await markRecurringEmailSent(job.userId, job.templateId, localDate);
      console.log(
        `${tag} sent · user=${job.userId} rows=${section.rows.length} to=${job.recipients.length}`
      );
      results.push({ templateId: job.templateId, userId: job.userId, ok: true, rowCount: section.rows.length });
    } catch (e) {
      const err = e?.message || "send_failed";
      await markRecurringEmailAttemptFailed(job.userId, job.templateId, err);
      console.log(`${tag} failed — ${err} (will retry on next tick, lastSentLocalDate unchanged)`);
      results.push({ templateId: job.templateId, userId: job.userId, ok: false, error: err });
    }
  }

  if (results.length > 0) {
    console.log(`[recurring-email] run done · jobs=${results.length}`);
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
