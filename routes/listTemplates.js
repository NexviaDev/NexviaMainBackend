import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { resolveAuthUser } from "../lib/authSession.js";
import { isEmailConfigured, maskEmail } from "../lib/mail.js";
import { sendListTemplateEmail } from "../lib/listTemplateEmail.js";

const router = Router();

const MAX_TEMPLATES_PER_TABLE = 50;
const MAX_NAME_LEN = 80;
const MAX_TABLE_KEY_LEN = 64;
const MAX_FILTER_KEYS = 40;
const MAX_FILTER_VALUE_LEN = 240;
const MAX_COLUMN_ORDER = 40;

const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
});

router.use(limiter);

const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "메일 발송 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_RECIPIENTS = 5;
const MAX_SEND_TEMPLATE_IDS = 10;
const MAX_EMAIL_ROWS_PER_SECTION = 300;
const MAX_EMAIL_HEADERS = 20;
const MAX_EMAIL_CELL_LEN = 500;

function sanitizeEmailList(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\s]+/) : [];
  const out = [];
  for (const item of list) {
    const e = String(item ?? "")
      .trim()
      .toLowerCase();
    if (!e || !EMAIL_RE.test(e)) continue;
    if (out.includes(e)) continue;
    out.push(e);
    if (out.length >= MAX_EMAIL_RECIPIENTS) break;
  }
  return out;
}

function normalizeSectionRow(row) {
  if (!Array.isArray(row)) return [];
  return row
    .map((cell) => {
      if (cell != null && typeof cell === "object" && !Array.isArray(cell)) {
        const text = String(cell.text ?? "").trim().slice(0, MAX_EMAIL_CELL_LEN);
        const hrefRaw = String(cell.href ?? "").trim();
        const href = hrefRaw && /^https?:\/\//i.test(hrefRaw) ? hrefRaw.slice(0, 512) : undefined;
        return href ? { text, href } : { text };
      }
      return { text: String(cell ?? "").trim().slice(0, MAX_EMAIL_CELL_LEN) };
    })
    .filter((c) => c.text.length > 0 || c.href);
}

function sanitizeEmailSections(raw, allowedIds) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_SEND_TEMPLATE_IDS) break;
    if (!item || typeof item !== "object") continue;
    const templateId = String(item.templateId ?? "").trim();
    if (!templateId || !allowedIds.has(templateId)) continue;
    const templateName = String(item.templateName ?? "").trim().slice(0, MAX_NAME_LEN);
    const categoryLabel = String(item.categoryLabel ?? "").trim().slice(0, 120);
    const fetchNote = String(item.fetchNote ?? "").trim().slice(0, 240);
    const headers = Array.isArray(item.headers)
      ? item.headers.map((h) => String(h ?? "").trim().slice(0, 80)).filter(Boolean).slice(0, MAX_EMAIL_HEADERS)
      : [];
    const rows = Array.isArray(item.rows)
      ? item.rows
          .slice(0, MAX_EMAIL_ROWS_PER_SECTION)
          .map((row) => normalizeSectionRow(row))
          .filter((row) => row.length > 0)
      : [];
    const totalMatched = Math.max(
      0,
      Math.min(Number(item.totalMatched) || rows.length, 1_000_000)
    );
    out.push({
      templateId,
      templateName: templateName || "템플릿",
      categoryLabel: categoryLabel || "—",
      headers,
      rows,
      totalMatched,
      truncated: Boolean(item.truncated),
      fetchNote: fetchNote || undefined,
    });
  }
  return out;
}

function sanitizeTemplateIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    const v = String(id ?? "").trim();
    if (!v || out.includes(v)) continue;
    out.push(v);
    if (out.length >= MAX_SEND_TEMPLATE_IDS) break;
  }
  return out;
}

const MAX_EMAIL_ATTACHMENT_BYTES = 4 * 1024 * 1024;

function sanitizeEmailAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= 10) break;
    if (!item || typeof item !== "object") continue;
    const filename = String(item.filename ?? "").trim().slice(0, 120);
    const contentBase64 = String(item.contentBase64 ?? "").trim();
    const templateId = String(item.templateId ?? "").trim().slice(0, 64);
    if (!filename || !contentBase64) continue;
    if (contentBase64.length > MAX_EMAIL_ATTACHMENT_BYTES * 1.4) continue;
    out.push({
      filename,
      contentBase64,
      ...(templateId ? { templateId } : {}),
    });
  }
  return out;
}

function sanitizeTableKey(raw) {
  return String(raw ?? "")
    .trim()
    .slice(0, MAX_TABLE_KEY_LEN);
}

function sanitizeName(raw) {
  return String(raw ?? "")
    .trim()
    .slice(0, MAX_NAME_LEN);
}

function sanitizeSort(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object") return null;
  const col = String(raw.col ?? "").trim().slice(0, 64);
  const dir = raw.dir === "desc" ? "desc" : raw.dir === "asc" ? "asc" : null;
  if (!col || !dir) return null;
  return { col, dir };
}

function sanitizeColumnFilters(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  let count = 0;
  for (const [key, val] of Object.entries(raw)) {
    if (count >= MAX_FILTER_KEYS) break;
    const k = String(key).trim().slice(0, 64);
    if (!k) continue;
    const v = String(val ?? "").trim().slice(0, MAX_FILTER_VALUE_LEN);
    if (!v) continue;
    out[k] = v;
    count += 1;
  }
  return out;
}

function sanitizeColumnOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_COLUMN_ORDER) break;
    const id = String(item ?? "").trim().slice(0, 64);
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function sanitizeHiddenColumns(raw) {
  return sanitizeColumnOrder(raw);
}

function publicTemplate(doc) {
  const columnOrder = Array.isArray(doc.columnOrder) ? doc.columnOrder : [];
  const hiddenColumns = Array.isArray(doc.hiddenColumns) ? doc.hiddenColumns : [];
  return {
    id: doc.id,
    name: doc.name,
    tableKey: doc.tableKey,
    sort: doc.sort ?? null,
    columnFilters: doc.columnFilters ?? {},
    columnOrder: columnOrder.length ? columnOrder : undefined,
    hiddenColumns: hiddenColumns.length ? hiddenColumns : undefined,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** GET /api/v1/list-templates?tableKey=bid:Thng */
router.get("/", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }

  const tableKey = sanitizeTableKey(req.query.tableKey);
  const filter = { userId: auth.user.userId };
  if (tableKey) filter["listTemplates.tableKey"] = tableKey;

  try {
    const user = await auth.db.collection("users").findOne(
      { userId: auth.user.userId },
      { projection: { listTemplates: 1 } }
    );
    let templates = Array.isArray(user?.listTemplates) ? user.listTemplates : [];
    if (tableKey) {
      templates = templates.filter((t) => t?.tableKey === tableKey);
    }
    templates.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return res.json({ ok: true, templates: templates.map(publicTemplate) });
  } catch (e) {
    console.error("[list-templates GET]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "목록 템플릿 조회 중 오류가 발생했습니다." });
  }
});

/** POST /api/v1/list-templates — 저장 */
router.post("/", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }

  const name = sanitizeName(req.body?.name);
  const tableKey = sanitizeTableKey(req.body?.tableKey);
  const sort = sanitizeSort(req.body?.sort);
  const columnFilters = sanitizeColumnFilters(req.body?.columnFilters);
  const columnOrder = sanitizeColumnOrder(req.body?.columnOrder);
  const hiddenColumns = sanitizeHiddenColumns(req.body?.hiddenColumns);

  if (!name) {
    return res.status(400).json({ error: "invalid_name", message: "템플릿 이름을 입력해 주세요." });
  }
  if (!tableKey) {
    return res.status(400).json({ error: "invalid_table_key", message: "테이블 구분(tableKey)이 필요합니다." });
  }

  const now = new Date();
  const doc = {
    id: crypto.randomUUID(),
    name,
    tableKey,
    sort,
    columnFilters,
    ...(columnOrder.length ? { columnOrder } : {}),
    ...(hiddenColumns.length ? { hiddenColumns } : {}),
    createdAt: now,
    updatedAt: now,
  };

  try {
    const users = auth.db.collection("users");
    const existing = await users.findOne(
      { userId: auth.user.userId },
      { projection: { listTemplates: 1 } }
    );
    const list = Array.isArray(existing?.listTemplates) ? existing.listTemplates : [];
    const sameTable = list.filter((t) => t?.tableKey === tableKey);
    if (sameTable.length >= MAX_TEMPLATES_PER_TABLE) {
      return res.status(409).json({
        error: "limit_reached",
        message: `같은 테이블당 최대 ${MAX_TEMPLATES_PER_TABLE}개까지 저장할 수 있습니다.`,
      });
    }
    const dupName = sameTable.some((t) => String(t?.name).trim() === name);
    if (dupName) {
      return res.status(409).json({ error: "duplicate_name", message: "같은 이름의 템플릿이 이미 있습니다." });
    }

    await users.updateOne(
      { userId: auth.user.userId },
      { $push: { listTemplates: doc }, $set: { updatedAt: now } }
    );

    return res.status(201).json({ ok: true, template: publicTemplate(doc) });
  } catch (e) {
    console.error("[list-templates POST]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "목록 템플릿 저장 중 오류가 발생했습니다." });
  }
});

/** POST /api/v1/list-templates/send-email — 선택 템플릿 조회 결과를 고객 메일로 발송 */
router.post("/send-email", emailLimiter, async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }

  if (!isEmailConfigured()) {
    return res.status(503).json({
      error: "email_unconfigured",
      message: "이메일(EMAIL_USER, EMAIL_PASS)이 설정되지 않았습니다.",
    });
  }

  const recipients = sanitizeEmailList(req.body?.to);
  const templateIds = sanitizeTemplateIds(req.body?.templateIds);
  const note = String(req.body?.note ?? "")
    .trim()
    .slice(0, 500);

  if (recipients.length === 0) {
    return res.status(400).json({ error: "invalid_to", message: "수신 이메일을 입력해 주세요." });
  }

  try {
    const user = await auth.db.collection("users").findOne(
      { userId: auth.user.userId },
      { projection: { listTemplates: 1 } }
    );
    const list = Array.isArray(user?.listTemplates) ? user.listTemplates : [];
    const ownedIds = new Set(list.map((t) => t?.id).filter(Boolean));

    let sections = sanitizeEmailSections(req.body?.sections, ownedIds);

    if (sections.length === 0) {
      if (templateIds.length === 0) {
        return res.status(400).json({ error: "invalid_sections", message: "발송할 조회 결과가 없습니다." });
      }
      const idSet = new Set(templateIds.filter((id) => ownedIds.has(id)));
      if (idSet.size === 0) {
        return res.status(404).json({ error: "not_found", message: "선택한 템플릿을 찾을 수 없습니다." });
      }
      return res.status(400).json({
        error: "missing_sections",
        message: "조회 결과(sections)가 필요합니다. 화면에서 다시 발송해 주세요.",
      });
    }

    const sectionIds = new Set(sections.map((s) => s.templateId));
    for (const id of templateIds) {
      if (ownedIds.has(id) && !sectionIds.has(id)) {
        return res.status(400).json({
          error: "incomplete_sections",
          message: "선택한 템플릿 중 조회 결과가 누락된 항목이 있습니다.",
        });
      }
    }

    await sendListTemplateEmail({
      to: recipients,
      sections,
      note,
      attachments: sanitizeEmailAttachments(req.body?.attachments),
    });

    const rowCount = sections.reduce((n, s) => n + s.rows.length, 0);
    return res.json({
      ok: true,
      sent: sections.length,
      emailCount: sections.length,
      rowCount,
      maskedTo: recipients.map((e) => maskEmail(e)),
    });
  } catch (e) {
    console.error("[list-templates send-email]", e?.message || e);
    if (String(e?.message || "").includes("EMAIL_NOT_CONFIGURED")) {
      return res.status(503).json({
        error: "email_unconfigured",
        message: "이메일 설정이 되어 있지 않습니다.",
      });
    }
    return res.status(502).json({ error: "send_failed", message: "메일 발송에 실패했습니다. 잠시 후 다시 시도해 주세요." });
  }
});

/** PUT /api/v1/list-templates/:id — 수정 */
router.put("/:id", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }

  const id = String(req.params.id ?? "").trim();
  if (!id) {
    return res.status(400).json({ error: "invalid_id", message: "템플릿 id가 필요합니다." });
  }

  const name = sanitizeName(req.body?.name);
  const sort = sanitizeSort(req.body?.sort);
  const columnFilters = sanitizeColumnFilters(req.body?.columnFilters);
  const columnOrder = sanitizeColumnOrder(req.body?.columnOrder);
  const hiddenColumns = sanitizeHiddenColumns(req.body?.hiddenColumns);

  if (!name) {
    return res.status(400).json({ error: "invalid_name", message: "템플릿 이름을 입력해 주세요." });
  }

  try {
    const users = auth.db.collection("users");
    const existing = await users.findOne(
      { userId: auth.user.userId },
      { projection: { listTemplates: 1 } }
    );
    const list = Array.isArray(existing?.listTemplates) ? existing.listTemplates : [];
    const current = list.find((t) => t?.id === id);
    if (!current) {
      return res.status(404).json({ error: "not_found", message: "템플릿을 찾을 수 없습니다." });
    }

    const tableKey = sanitizeTableKey(current.tableKey);
    const sameTable = list.filter((t) => t?.tableKey === tableKey && t?.id !== id);
    const dupName = sameTable.some((t) => String(t?.name).trim() === name);
    if (dupName) {
      return res.status(409).json({ error: "duplicate_name", message: "같은 이름의 템플릿이 이미 있습니다." });
    }

    const now = new Date();
    const patch = {
      name,
      sort,
      columnFilters,
      updatedAt: now,
    };
    if (columnOrder.length) patch.columnOrder = columnOrder;
    else patch.columnOrder = undefined;
    if (hiddenColumns.length) patch.hiddenColumns = hiddenColumns;
    else patch.hiddenColumns = undefined;

    const nextDoc = { ...current, ...patch };
    const unset = {};
    if (!columnOrder.length) unset["listTemplates.$.columnOrder"] = "";
    if (!hiddenColumns.length) unset["listTemplates.$.hiddenColumns"] = "";

    const setFields = {
      "listTemplates.$.name": name,
      "listTemplates.$.sort": sort,
      "listTemplates.$.columnFilters": columnFilters,
      "listTemplates.$.updatedAt": now,
    };
    if (columnOrder.length) setFields["listTemplates.$.columnOrder"] = columnOrder;
    if (hiddenColumns.length) setFields["listTemplates.$.hiddenColumns"] = hiddenColumns;

    const update = { $set: setFields };
    if (Object.keys(unset).length) update.$unset = unset;

    const result = await users.updateOne({ userId: auth.user.userId, "listTemplates.id": id }, update);
    if (result.modifiedCount === 0 && result.matchedCount === 0) {
      return res.status(404).json({ error: "not_found", message: "템플릿을 찾을 수 없습니다." });
    }

    return res.json({ ok: true, template: publicTemplate(nextDoc) });
  } catch (e) {
    console.error("[list-templates PUT]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "목록 템플릿 수정 중 오류가 발생했습니다." });
  }
});

/** DELETE /api/v1/list-templates/:id */
router.delete("/:id", async (req, res) => {
  const auth = await resolveAuthUser(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error, message: auth.message });
  }

  const id = String(req.params.id ?? "").trim();
  if (!id) {
    return res.status(400).json({ error: "invalid_id", message: "템플릿 id가 필요합니다." });
  }

  try {
    const result = await auth.db.collection("users").updateOne(
      { userId: auth.user.userId },
      { $pull: { listTemplates: { id } }, $set: { updatedAt: new Date() } }
    );
    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: "not_found", message: "템플릿을 찾을 수 없습니다." });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("[list-templates DELETE]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "목록 템플릿 삭제 중 오류가 발생했습니다." });
  }
});

export default router;
