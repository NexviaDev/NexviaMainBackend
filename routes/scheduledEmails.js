import { Router } from "express";
import rateLimit from "express-rate-limit";
import { resolveAuthUser } from "../lib/authSession.js";
import { maskEmail } from "../lib/mail.js";
import {
  sanitizeEmailAttachments,
  sanitizeEmailList,
  sanitizeEmailSections,
  sanitizeTemplateIds,
} from "../lib/listTemplateEmailPayload.js";
import {
  cancelScheduledEmail,
  getEmailSchedulePrefs,
  insertScheduledEmail,
  listScheduledEmailsForUser,
  newScheduledEmailId,
  parseScheduledAtUtc,
  saveEmailSchedulePrefs,
  sanitizeTimezone,
} from "../lib/scheduledEmailStore.js";
import { runDueScheduledEmails } from "../lib/scheduledEmailRun.js";
import { runDueRecurringEmails } from "../lib/recurringEmailRun.js";
import {
  disableRecurringEmail,
  listRecurringEmailsForUser,
  MAX_RECURRING_PER_USER,
  upsertRecurringEmail,
} from "../lib/recurringEmailStore.js";
import { formatRecurringLabel } from "../lib/recurringEmailTime.js";
import { isMongoConfigured } from "../lib/mongo.js";

const router = Router();
const WARM_TOKEN = String(process.env.CACHE_WARM_TOKEN ?? "").trim();

const MAX_PENDING_PER_USER = 20;
const MIN_LEAD_MS = 5 * 60 * 1000;
const MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const scheduleLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "예약 요청이 너무 많습니다." },
});

function authWarm(req, res, next) {
  if (!WARM_TOKEN) {
    return res.status(503).json({
      error: "warm_unconfigured",
      message: "CACHE_WARM_TOKEN 이 설정되지 않았습니다.",
    });
  }
  const token = String(req.query.token ?? req.headers["x-cache-warm-token"] ?? "").trim();
  if (!token || token !== WARM_TOKEN) {
    return res.status(401).json({ error: "unauthorized", message: "유효하지 않은 token" });
  }
  next();
}

router.use(limiter);

/** GET /api/v1/scheduled-emails/prefs */
router.get("/prefs", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }
  try {
    const prefs = await getEmailSchedulePrefs(auth.user.userId);
    return res.json({
      ok: true,
      prefs: {
        ...prefs,
        recipients: prefs.recipients.map((e) => maskEmail(e)),
      },
      recipientsRaw: prefs.recipients,
    });
  } catch (e) {
    console.error("[scheduled-emails prefs GET]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "설정 조회 실패" });
  }
});

/** PUT /api/v1/scheduled-emails/prefs */
router.put("/prefs", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }
  const recipients = sanitizeEmailList(req.body?.recipients ?? req.body?.to);
  const timezone = sanitizeTimezone(req.body?.timezone);
  if (recipients.length === 0) {
    return res.status(400).json({ error: "invalid_recipients", message: "수신 이메일을 입력해 주세요." });
  }
  try {
    await saveEmailSchedulePrefs(auth.user.userId, { recipients, timezone });
    return res.json({
      ok: true,
      prefs: { recipients: recipients.map((e) => maskEmail(e)), timezone },
    });
  } catch (e) {
    console.error("[scheduled-emails prefs PUT]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "설정 저장 실패" });
  }
});

/** GET /api/v1/scheduled-emails */
router.get("/", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }
  try {
    const jobs = await listScheduledEmailsForUser(auth.user.userId);
    return res.json({
      ok: true,
      jobs: jobs.map((j) => ({
        ...j,
        recipients: (j.recipients ?? []).map((e) => maskEmail(e)),
      })),
    });
  } catch (e) {
    console.error("[scheduled-emails GET]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "예약 목록 조회 실패" });
  }
});

/** POST /api/v1/scheduled-emails — 예약 등록 */
router.post("/", scheduleLimiter, async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }

  const recipients = sanitizeEmailList(req.body?.to ?? req.body?.recipients);
  const templateIds = sanitizeTemplateIds(req.body?.templateIds);
  const scheduledAt = parseScheduledAtUtc(req.body?.scheduledAt);
  const timezone = sanitizeTimezone(req.body?.timezone);
  const note = String(req.body?.note ?? "")
    .trim()
    .slice(0, 500);

  if (recipients.length === 0) {
    return res.status(400).json({ error: "invalid_to", message: "수신 이메일을 입력해 주세요." });
  }
  if (!scheduledAt) {
    return res.status(400).json({ error: "invalid_time", message: "예약 시각이 올바르지 않습니다." });
  }
  const lead = scheduledAt.getTime() - Date.now();
  if (lead < MIN_LEAD_MS) {
    return res.status(400).json({
      error: "too_soon",
      message: "예약은 최소 5분 후부터 가능합니다.",
    });
  }
  if (lead > MAX_LEAD_MS) {
    return res.status(400).json({
      error: "too_far",
      message: "예약은 30일 이내만 가능합니다.",
    });
  }
  if (templateIds.length === 0) {
    return res.status(400).json({ error: "invalid_templates", message: "템플릿을 선택해 주세요." });
  }

  try {
    const user = await auth.db.collection("users").findOne(
      { userId: auth.user.userId },
      { projection: { listTemplates: 1 } }
    );
    const list = Array.isArray(user?.listTemplates) ? user.listTemplates : [];
    const ownedIds = new Set(list.map((t) => t?.id).filter(Boolean));
    const sections = sanitizeEmailSections(req.body?.sections, ownedIds);
    if (sections.length === 0) {
      return res.status(400).json({
        error: "missing_sections",
        message: "조회 결과(sections)가 필요합니다.",
      });
    }

    const pendingCount = await auth.db
      .collection("scheduled_list_emails")
      .countDocuments({ userId: auth.user.userId, status: "pending" });
    if (pendingCount >= MAX_PENDING_PER_USER) {
      return res.status(409).json({
        error: "limit_reached",
        message: `대기 중 예약은 최대 ${MAX_PENDING_PER_USER}건까지입니다.`,
      });
    }

    const now = new Date();
    const id = newScheduledEmailId();
    const rowCount = sections.reduce((n, s) => n + s.rows.length, 0);
    const doc = {
      id,
      userId: auth.user.userId,
      recipients,
      templateIds,
      note: note || null,
      timezone,
      scheduledAt,
      sections,
      attachments: sanitizeEmailAttachments(req.body?.attachments),
      status: "pending",
      createdAt: now,
      sentAt: null,
      error: null,
      rowCount,
      emailCount: 1,
    };
    await insertScheduledEmail(doc);
    await saveEmailSchedulePrefs(auth.user.userId, { recipients, timezone });

    return res.status(201).json({
      ok: true,
      job: {
        id,
        scheduledAt: scheduledAt.toISOString(),
        timezone,
        status: "pending",
        templateCount: sections.length,
        rowCount,
        maskedTo: recipients.map((e) => maskEmail(e)),
      },
    });
  } catch (e) {
    console.error("[scheduled-emails POST]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "예약 저장 실패" });
  }
});

/** DELETE /api/v1/scheduled-emails/:id */
router.delete("/:id", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }
  const id = String(req.params.id ?? "").trim();
  if (!id) {
    return res.status(400).json({ error: "invalid_id", message: "id가 필요합니다." });
  }
  try {
    const ok = await cancelScheduledEmail(auth.user.userId, id);
    if (!ok) {
      return res.status(404).json({
        error: "not_found",
        message: "취소할 예약을 찾을 수 없습니다. (이미 발송·취소됨)",
      });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("[scheduled-emails DELETE]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "예약 취소 실패" });
  }
});

/** GET /api/v1/scheduled-emails/recurring — 템플릿별 매일 반복 설정 */
router.get("/recurring", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }
  try {
    const schedules = await listRecurringEmailsForUser(auth.user.userId);
    return res.json({
      ok: true,
      schedules: schedules.map((s) => ({
        ...s,
        recipients: (s.recipients ?? []).map((e) => maskEmail(e)),
        label: formatRecurringLabel(s.timeLocal, s.timezone),
      })),
      recipientsByTemplate: Object.fromEntries(
        schedules.map((s) => [s.templateId, s.recipients ?? []])
      ),
    });
  } catch (e) {
    console.error("[scheduled-emails recurring GET]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "반복 설정 조회 실패" });
  }
});

/** PUT /api/v1/scheduled-emails/recurring/:templateId */
router.put("/recurring/:templateId", scheduleLimiter, async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }
  const templateId = String(req.params.templateId ?? "").trim();
  if (!templateId) {
    return res.status(400).json({ error: "invalid_id", message: "templateId가 필요합니다." });
  }
  try {
    const user = await auth.db.collection("users").findOne(
      { userId: auth.user.userId },
      { projection: { listTemplates: 1 } }
    );
    const list = Array.isArray(user?.listTemplates) ? user.listTemplates : [];
    const ownedIds = new Set(list.map((t) => t?.id).filter(Boolean));

    const { doc, scheduleChanged } = await upsertRecurringEmail(
      auth.user.userId,
      templateId,
      req.body,
      ownedIds
    );
    return res.json({
      ok: true,
      schedule: {
        templateId: doc.templateId,
        enabled: doc.enabled,
        timezone: doc.timezone,
        timeLocal: doc.timeLocal,
        repeat: doc.repeat,
        maskedTo: doc.recipients.map((e) => maskEmail(e)),
        label: formatRecurringLabel(doc.timeLocal, doc.timezone),
        scheduleReset: scheduleChanged,
      },
    });
  } catch (e) {
    const msg = e?.message || "save_failed";
    if (msg === "limit_reached") {
      return res.status(409).json({
        error: "limit_reached",
        message: `반복 설정은 최대 ${MAX_RECURRING_PER_USER}건까지입니다.`,
      });
    }
    if (msg === "template_not_owned" || msg === "invalid_template_snapshot") {
      return res.status(400).json({ error: msg, message: "템플릿 정보가 올바르지 않습니다." });
    }
    if (msg === "invalid_recipients") {
      return res.status(400).json({ error: msg, message: "수신 이메일을 입력해 주세요." });
    }
    console.error("[scheduled-emails recurring PUT]", msg);
    return res.status(502).json({ error: "db_error", message: "반복 설정 저장 실패" });
  }
});

/** DELETE /api/v1/scheduled-emails/recurring/:templateId — 반복 해제 */
router.delete("/recurring/:templateId", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }
  const templateId = String(req.params.templateId ?? "").trim();
  if (!templateId) {
    return res.status(400).json({ error: "invalid_id", message: "templateId가 필요합니다." });
  }
  try {
    const ok = await disableRecurringEmail(auth.user.userId, templateId);
    if (!ok) {
      return res.status(404).json({ error: "not_found", message: "반복 설정을 찾을 수 없습니다." });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("[scheduled-emails recurring DELETE]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "반복 해제 실패" });
  }
});

/** GET /api/v1/scheduled-emails/run?token= — cron 발송 처리 */
router.get("/run", authWarm, async (_req, res) => {
  if (!isMongoConfigured()) {
    return res.status(503).json({ error: "mongodb_not_configured" });
  }
  const oneShot = await runDueScheduledEmails();
  const recurring = await runDueRecurringEmails();
  const ok = oneShot.ok !== false && recurring.ok !== false;
  const result = {
    ok,
    oneShot,
    recurring,
    at: new Date().toISOString(),
  };
  if (oneShot.error === "email_unconfigured") {
    return res.status(503).json(result);
  }
  return res.status(ok ? 200 : 502).json(result);
});

/** GET /api/v1/scheduled-emails/health */
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mongoConfigured: isMongoConfigured(),
    tokenConfigured: Boolean(WARM_TOKEN),
    cronHint: "GET /api/v1/scheduled-emails/run?token=... every 5 min (one-shot + daily recurring)",
  });
});

export default router;
