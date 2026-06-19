import { isEmailConfigured } from "./mail.js";
import { sendListTemplateEmail } from "./listTemplateEmail.js";
import {
  claimDueScheduledEmail,
  markScheduledEmailFailed,
  markScheduledEmailSent,
} from "./scheduledEmailStore.js";
import { isMongoConfigured } from "./mongo.js";
import { wakeBackendIfConfigured } from "./scheduledEmailWake.js";

const MAX_JOBS_PER_RUN = 5;

/**
 * cron-job.org — GET /api/v1/scheduled-emails/run?token=...
 */
export async function runDueScheduledEmails() {
  if (!isMongoConfigured()) {
    return { ok: false, error: "mongodb_not_configured", processed: 0, results: [] };
  }
  if (!isEmailConfigured()) {
    return { ok: false, error: "email_unconfigured", processed: 0, results: [] };
  }

  await wakeBackendIfConfigured();

  const results = [];
  const started = Date.now();

  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    const claimed = await claimDueScheduledEmail(new Date());
    const job = claimed?.value ?? claimed;
    if (!job?.id) break;

    const tag = `[scheduled-email][${job.id.slice(0, 8)}]`;
    try {
      const sections = Array.isArray(job.sections) ? job.sections : [];
      if (sections.length === 0) {
        throw new Error("empty_sections");
      }
      await sendListTemplateEmail({
        to: job.recipients,
        sections,
        note: job.note ?? "",
        attachments: Array.isArray(job.attachments) ? job.attachments : [],
      });
      const rowCount = sections.reduce((n, s) => n + (s.rows?.length ?? 0), 0);
      await markScheduledEmailSent(job.id, {
        rowCount,
        emailCount: sections.length,
      });
      console.log(`${tag} sent · templates=${sections.length} rows=${rowCount}`);
      results.push({ id: job.id, ok: true, rowCount });
    } catch (e) {
      const err = e?.message || "send_failed";
      await markScheduledEmailFailed(job.id, err);
      console.log(`${tag} failed — ${err}`);
      results.push({ id: job.id, ok: false, error: err });
    }
  }

  const sec = Math.round((Date.now() - started) / 1000);
  if (results.length > 0) {
    console.log(`[scheduled-email] run done ${sec}s · jobs=${results.length}`);
  }

  return {
    ok: results.every((r) => r.ok) || results.length === 0,
    processed: results.length,
    results,
    at: new Date().toISOString(),
  };
}
