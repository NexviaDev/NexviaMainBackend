import { Router } from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getDb, isMongoConfigured } from "../lib/mongo.js";
import { isEmailConfigured, sendOtpEmail } from "../lib/mail.js";
import { hashPassword, validatePassword, verifyPassword } from "../lib/password.js";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
/** 로그인 유지 — 3개월 */
const JWT_EXPIRES = "90d";

const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
});

const sendCodeLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "인증메일 요청이 너무 많습니다. 1분 후 다시 시도해 주세요." },
});

const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요." },
});

function normalizeUserId(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

function normalizeEmail(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

function isValidEmailUserId(raw) {
  const id = normalizeUserId(raw);
  return EMAIL_RE.test(id) && id.length <= 120;
}

function invalidUserIdMessage() {
  return "아이디는 이메일 형식으로 입력해 주세요. (예: name@company.com)";
}

function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return String(raw ?? "").trim();
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function generateCode() {
  return String(crypto.randomInt(100_000, 1_000_000));
}

function signToken(user) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error("AUTH_JWT_SECRET missing");
  return jwt.sign(
    {
      sub: user.userId,
      name: user.name,
      company: user.company,
      email: user.email,
    },
    secret,
    { expiresIn: JWT_EXPIRES }
  );
}

function readBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

function publicUser(user) {
  return {
    userId: user.userId,
    name: user.name,
    company: user.company,
    email: user.email,
    phone: user.phone,
  };
}

function mongoUnavailable(res) {
  return res.status(503).json({
    error: "mongo_unconfigured",
    message: "회원 DB(MONGODB_URI)가 설정되지 않았습니다. backend/.env 를 확인해 주세요.",
  });
}

function emailUnavailable(res) {
  return res.status(503).json({
    error: "email_unconfigured",
    message: "이메일(EMAIL_USER, EMAIL_PASS)이 설정되지 않았습니다. Gmail 앱 비밀번호를 확인해 주세요.",
  });
}

async function dispatchOtpEmail({ to, code, purpose }) {
  if (!isEmailConfigured()) {
    throw new Error("EMAIL_NOT_CONFIGURED");
  }
  return sendOtpEmail({ to, code, purpose });
}

async function ensureUserIndexes(db) {
  await db.collection("users").createIndex({ userId: 1 }, { unique: true }).catch(() => {});
  await db.collection("users").createIndex({ email: 1 }, { unique: true }).catch(() => {});
  await db.collection("login_codes").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  await db.collection("register_pending").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
}

router.use(authLimiter);

router.get("/health", async (_req, res) => {
  const payload = { ok: false, mongo: false, email: isEmailConfigured() };
  if (!isMongoConfigured()) return res.json(payload);
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return res.json({ ok: true, mongo: true, email: isEmailConfigured() });
  } catch (e) {
    console.error("[auth health]", e?.message || e);
    return res.status(503).json({ ...payload, message: "MongoDB 연결 실패" });
  }
});

/** GET /api/v1/auth/me — Bearer JWT */
router.get("/me", async (req, res) => {
  if (!isMongoConfigured()) return mongoUnavailable(res);

  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "unauthorized", message: "로그인이 필요합니다." });
  }

  try {
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret) {
      return res.status(503).json({ error: "auth_misconfigured", message: "AUTH_JWT_SECRET 이 설정되지 않았습니다." });
    }
    const payload = jwt.verify(token, secret);
    const userId = normalizeUserId(payload.sub);
    const db = await getDb();
    const user = await db.collection("users").findOne({ userId, status: "active" });
    if (!user) {
      return res.status(401).json({ error: "user_not_found", message: "계정을 찾을 수 없습니다." });
    }
    return res.json({ ok: true, user: publicUser(user), expiresIn: JWT_EXPIRES });
  } catch (e) {
    if (e?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "token_expired", message: "로그인 유효기간(3개월)이 만료되었습니다. 다시 로그인해 주세요." });
    }
    return res.status(401).json({ error: "invalid_token", message: "로그인 정보가 유효하지 않습니다." });
  }
});

router.get("/check-userid", async (req, res) => {
  if (!isMongoConfigured()) return mongoUnavailable(res);

  const userId = normalizeUserId(req.query.userId);
  if (!isValidEmailUserId(userId)) {
    return res.status(400).json({
      available: false,
      message: invalidUserIdMessage(),
    });
  }

  try {
    const db = await getDb();
    const existing = await db.collection("users").findOne({ userId }, { projection: { _id: 1 } });
    const pending = await db.collection("register_pending").findOne({ userId }, { projection: { _id: 1 } });
    const taken = Boolean(existing);
    return res.json({
      available: !taken,
      message: taken ? "이미 사용 중인 아이디입니다." : pending ? "가입 진행 중인 아이디입니다. 인증메일을 확인해 주세요." : "사용 가능한 아이디입니다.",
    });
  } catch (e) {
    console.error("[auth check-userid]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "아이디 확인 중 오류가 발생했습니다." });
  }
});

/** 이메일 중복 확인 + 인증번호 발송 (가입 1단계) */
async function issueRegisterEmailOtp(db, userId) {
  const email = userId;
  const users = db.collection("users");
  if (await users.findOne({ userId }, { projection: { _id: 1 } })) {
    return { ok: false, status: 409, error: "duplicate_user_id", message: "이미 사용 중인 아이디입니다." };
  }
  if (await users.findOne({ email }, { projection: { _id: 1 } })) {
    return { ok: false, status: 409, error: "duplicate_email", message: "이미 가입된 이메일입니다." };
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await db.collection("register_pending").updateOne(
    { userId },
    {
      $set: {
        userId,
        email,
        codeHash: hashCode(code),
        expiresAt,
        attempts: 0,
        emailVerifiedPending: true,
        updatedAt: new Date(),
      },
      $unset: { passwordHash: "", name: "", company: "", companyAddress: "", phone: "" },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  const { masked } = await dispatchOtpEmail({ to: email, code, purpose: "register" });
  const devExpose = String(process.env.AUTH_DEV_EXPOSE_CODE || "").toLowerCase() === "true";
  const payload = {
    ok: true,
    available: true,
    message: `${masked} 로 인증번호를 발송했습니다. 메일함을 확인해 주세요.`,
    expiresInSec: Math.floor(CODE_TTL_MS / 1000),
  };
  if (devExpose) payload.devCode = code;
  return { ok: true, status: 200, payload };
}

/** POST /api/v1/auth/register/pre-verify { userId } — 중복 확인 + 인증메일 발송 */
router.post("/register/pre-verify", sendCodeLimiter, async (req, res) => {
  if (!isMongoConfigured()) return mongoUnavailable(res);
  if (!isEmailConfigured()) return emailUnavailable(res);

  const userId = normalizeUserId(req.body?.userId);
  if (!isValidEmailUserId(userId)) {
    return res.status(400).json({ available: false, message: invalidUserIdMessage() });
  }

  try {
    const db = await getDb();
    await ensureUserIndexes(db);
    const result = await issueRegisterEmailOtp(db, userId);
    if (!result.ok) {
      return res.status(result.status).json({
        available: false,
        error: result.error,
        message: result.message,
      });
    }
    return res.json(result.payload);
  } catch (e) {
    console.error("[auth register/pre-verify]", e?.message || e);
    if (String(e?.message || "").includes("EMAIL_NOT_CONFIGURED")) return emailUnavailable(res);
    return res.status(502).json({ error: "send_failed", message: "인증메일 발송에 실패했습니다." });
  }
});

/** POST /api/v1/auth/register/send-code — (레거시) pre-verify 와 동일 + 가입 정보 저장 */
router.post("/register/send-code", sendCodeLimiter, async (req, res) => {
  if (!isMongoConfigured()) return mongoUnavailable(res);
  if (!isEmailConfigured()) return emailUnavailable(res);

  const userId = normalizeUserId(req.body?.userId);
  const name = String(req.body?.name ?? "").trim();
  const company = String(req.body?.company ?? "").trim();
  const companyAddress = String(req.body?.companyAddress ?? "").trim();
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password ?? "");
  const passwordConfirm = String(req.body?.passwordConfirm ?? "");

  if (!isValidEmailUserId(userId)) {
    return res.status(400).json({ error: "invalid_user_id", message: invalidUserIdMessage() });
  }
  const email = userId;
  const pwdError = validatePassword(password);
  if (pwdError) {
    return res.status(400).json({ error: "invalid_password", message: pwdError });
  }
  if (password !== passwordConfirm) {
    return res.status(400).json({ error: "password_mismatch", message: "비밀번호 확인이 일치하지 않습니다." });
  }
  if (!name || name.length > 40) {
    return res.status(400).json({ error: "invalid_name", message: "이름을 입력해 주세요." });
  }
  if (!company || company.length > 80) {
    return res.status(400).json({ error: "invalid_company", message: "회사명을 입력해 주세요." });
  }
  if (!companyAddress || companyAddress.length > 200) {
    return res.status(400).json({ error: "invalid_address", message: "회사 주소를 입력해 주세요." });
  }
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 11) {
    return res.status(400).json({ error: "invalid_phone", message: "연락처 형식을 확인해 주세요." });
  }

  try {
    const db = await getDb();
    await ensureUserIndexes(db);

    const users = db.collection("users");
    if (await users.findOne({ userId }, { projection: { _id: 1 } })) {
      return res.status(409).json({ error: "duplicate_user_id", message: "이미 사용 중인 아이디입니다." });
    }
    if (await users.findOne({ email }, { projection: { _id: 1 } })) {
      return res.status(409).json({ error: "duplicate_email", message: "이미 가입된 이메일입니다." });
    }

    const passwordHash = await hashPassword(password);
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await db.collection("register_pending").updateOne(
      { userId },
      {
        $set: {
          userId,
          email,
          name,
          company,
          companyAddress,
          phone,
          passwordHash,
          codeHash: hashCode(code),
          expiresAt,
          attempts: 0,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    const { masked } = await dispatchOtpEmail({ to: email, code, purpose: "register" });

    const devExpose = String(process.env.AUTH_DEV_EXPOSE_CODE || "").toLowerCase() === "true";
    const payload = {
      ok: true,
      message: `${masked} 로 회원가입 인증번호를 발송했습니다.`,
      expiresInSec: Math.floor(CODE_TTL_MS / 1000),
    };
    if (devExpose) payload.devCode = code;

    return res.json(payload);
  } catch (e) {
    console.error("[auth register/send-code]", e?.message || e);
    if (String(e?.message || "").includes("EMAIL_NOT_CONFIGURED")) return emailUnavailable(res);
    return res.status(502).json({ error: "send_failed", message: "인증메일 발송에 실패했습니다. Gmail 설정을 확인해 주세요." });
  }
});

/** POST /api/v1/auth/register — 인증번호 + 가입 정보 제출 후 가입 완료 */
router.post("/register", async (req, res) => {
  if (!isMongoConfigured()) return mongoUnavailable(res);

  const userId = normalizeUserId(req.body?.userId);
  const code = String(req.body?.code ?? "").trim();
  const name = String(req.body?.name ?? "").trim();
  const company = String(req.body?.company ?? "").trim();
  const companyAddress = String(req.body?.companyAddress ?? "").trim();
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password ?? "");
  const passwordConfirm = String(req.body?.passwordConfirm ?? "");

  if (!isValidEmailUserId(userId)) {
    return res.status(400).json({ error: "invalid_user_id", message: invalidUserIdMessage() });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "invalid_code", message: "6자리 인증번호를 입력해 주세요." });
  }
  const pwdError = validatePassword(password);
  if (pwdError) {
    return res.status(400).json({ error: "invalid_password", message: pwdError });
  }
  if (password !== passwordConfirm) {
    return res.status(400).json({ error: "password_mismatch", message: "비밀번호 확인이 일치하지 않습니다." });
  }
  if (!name || name.length > 40) {
    return res.status(400).json({ error: "invalid_name", message: "이름을 입력해 주세요." });
  }
  if (!company || company.length > 80) {
    return res.status(400).json({ error: "invalid_company", message: "회사명을 입력해 주세요." });
  }
  if (!companyAddress || companyAddress.length > 200) {
    return res.status(400).json({ error: "invalid_address", message: "회사 주소를 입력해 주세요." });
  }
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 11) {
    return res.status(400).json({ error: "invalid_phone", message: "연락처 형식을 확인해 주세요." });
  }

  try {
    const db = await getDb();
    await ensureUserIndexes(db);

    const pending = await db.collection("register_pending").findOne({ userId });
    if (!pending) {
      return res.status(400).json({ error: "pending_missing", message: "먼저 중복 확인 · 인증번호 받기를 눌러 주세요." });
    }
    if (pending.expiresAt && new Date(pending.expiresAt) < new Date()) {
      return res.status(400).json({ error: "code_expired", message: "인증번호가 만료되었습니다. 다시 요청해 주세요." });
    }
    if ((pending.attempts ?? 0) >= MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({ error: "too_many_attempts", message: "인증 시도 횟수를 초과했습니다. 인증번호를 다시 요청해 주세요." });
    }
    if (pending.codeHash !== hashCode(code)) {
      await db.collection("register_pending").updateOne({ userId }, { $inc: { attempts: 1 } });
      return res.status(401).json({ error: "invalid_code", message: "인증번호가 올바르지 않습니다." });
    }

    const users = db.collection("users");
    const email = userId;
    if (await users.findOne({ userId }, { projection: { _id: 1 } })) {
      await db.collection("register_pending").deleteOne({ userId });
      return res.status(409).json({ error: "duplicate_user_id", message: "이미 사용 중인 아이디입니다." });
    }
    if (await users.findOne({ email }, { projection: { _id: 1 } })) {
      await db.collection("register_pending").deleteOne({ userId });
      return res.status(409).json({ error: "duplicate_email", message: "이미 가입된 이메일입니다." });
    }

    const passwordHash = await hashPassword(password);
    const now = new Date();
    const doc = {
      userId,
      email,
      passwordHash,
      name,
      company,
      companyAddress,
      phone,
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await users.insertOne(doc);
    await db.collection("register_pending").deleteOne({ userId });

    return res.status(201).json({
      ok: true,
      message: "회원가입이 완료되었습니다. 로그인 페이지에서 이메일과 비밀번호로 로그인해 주세요.",
      userId: doc.userId,
    });
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({ error: "duplicate", message: "이미 가입된 아이디 또는 이메일입니다." });
    }
    console.error("[auth register]", e?.message || e);
    return res.status(502).json({ error: "db_error", message: "회원가입 처리 중 오류가 발생했습니다." });
  }
});

/** POST /api/v1/auth/login { userId, password } — 비밀번호 확인 후 이메일 OTP 발송 */
router.post("/login", loginLimiter, async (req, res) => {
  if (!isMongoConfigured()) return mongoUnavailable(res);
  if (!isEmailConfigured()) return emailUnavailable(res);

  const userId = normalizeUserId(req.body?.userId);
  const password = String(req.body?.password ?? "");

  if (!isValidEmailUserId(userId)) {
    return res.status(400).json({ error: "invalid_user_id", message: invalidUserIdMessage() });
  }
  if (!password) {
    return res.status(400).json({ error: "invalid_password", message: "비밀번호를 입력해 주세요." });
  }

  try {
    const db = await getDb();
    await ensureUserIndexes(db);

    const user = await db.collection("users").findOne({ userId, status: "active" });
    if (!user?.passwordHash) {
      return res.status(401).json({
        error: "invalid_credentials",
        message: "아이디 또는 비밀번호가 올바르지 않습니다.",
      });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({
        error: "invalid_credentials",
        message: "아이디 또는 비밀번호가 올바르지 않습니다.",
      });
    }

    const otpEmail = user.email || user.userId;
    if (!otpEmail || !EMAIL_RE.test(otpEmail)) {
      return res.status(400).json({
        error: "email_missing",
        message: "등록된 이메일이 없습니다. 관리자에게 문의해 주세요.",
      });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await db.collection("login_codes").updateOne(
      { userId },
      {
        $set: {
          userId,
          codeHash: hashCode(code),
          expiresAt,
          attempts: 0,
          passwordVerifiedAt: new Date(),
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    const { masked } = await dispatchOtpEmail({ to: otpEmail, code, purpose: "login" });

    const devExpose = String(process.env.AUTH_DEV_EXPOSE_CODE || "").toLowerCase() === "true";
    const payload = {
      ok: true,
      message: `${masked} 로 일회용 인증번호를 발송했습니다. 메일함을 확인해 주세요.`,
      expiresInSec: Math.floor(CODE_TTL_MS / 1000),
    };
    if (devExpose) payload.devCode = code;

    return res.json(payload);
  } catch (e) {
    console.error("[auth login]", e?.message || e);
    if (String(e?.message || "").includes("EMAIL_NOT_CONFIGURED")) return emailUnavailable(res);
    return res.status(502).json({ error: "send_failed", message: "인증메일 발송에 실패했습니다." });
  }
});

/** POST /api/v1/auth/send-code { userId, password } — login 과 동일 (비밀번호 필수) */
router.post("/send-code", sendCodeLimiter, async (req, res) => {
  if (!isMongoConfigured()) return mongoUnavailable(res);
  if (!isEmailConfigured()) return emailUnavailable(res);

  const userId = normalizeUserId(req.body?.userId);
  const password = String(req.body?.password ?? "");

  if (!isValidEmailUserId(userId)) {
    return res.status(400).json({ error: "invalid_user_id", message: invalidUserIdMessage() });
  }
  if (!password) {
    return res.status(400).json({ error: "invalid_password", message: "비밀번호를 입력해 주세요." });
  }

  try {
    const db = await getDb();
    await ensureUserIndexes(db);

    const user = await db.collection("users").findOne({ userId, status: "active" });
    if (!user) {
      return res.status(404).json({
        error: "user_not_found",
        message: "등록되지 않은 아이디입니다. 회원가입 후 이용해 주세요.",
      });
    }
    if (!user.passwordHash) {
      return res.status(401).json({
        error: "invalid_credentials",
        message: "아이디 또는 비밀번호가 올바르지 않습니다.",
      });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({
        error: "invalid_credentials",
        message: "아이디 또는 비밀번호가 올바르지 않습니다.",
      });
    }

    const otpEmail = user.email || user.userId;
    if (!otpEmail || !EMAIL_RE.test(otpEmail)) {
      return res.status(400).json({
        error: "email_missing",
        message: "등록된 이메일이 없습니다. 관리자에게 문의해 주세요.",
      });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await db.collection("login_codes").updateOne(
      { userId },
      {
        $set: {
          userId,
          codeHash: hashCode(code),
          expiresAt,
          attempts: 0,
          passwordVerifiedAt: new Date(),
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    const { masked } = await dispatchOtpEmail({ to: otpEmail, code, purpose: "login" });

    const devExpose = String(process.env.AUTH_DEV_EXPOSE_CODE || "").toLowerCase() === "true";
    const payload = {
      ok: true,
      message: `${masked} 로 로그인 인증번호를 발송했습니다.`,
      expiresInSec: Math.floor(CODE_TTL_MS / 1000),
    };
    if (devExpose) payload.devCode = code;

    return res.json(payload);
  } catch (e) {
    console.error("[auth send-code]", e?.message || e);
    if (String(e?.message || "").includes("EMAIL_NOT_CONFIGURED")) return emailUnavailable(res);
    return res.status(502).json({ error: "send_failed", message: "인증메일 발송에 실패했습니다." });
  }
});

/** POST /api/v1/auth/verify { userId, code } */
router.post("/verify", async (req, res) => {
  if (!isMongoConfigured()) return mongoUnavailable(res);

  const userId = normalizeUserId(req.body?.userId);
  const code = String(req.body?.code ?? "").trim();

  if (!isValidEmailUserId(userId)) {
    return res.status(400).json({ error: "invalid_user_id", message: invalidUserIdMessage() });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "invalid_code", message: "6자리 인증번호를 입력해 주세요." });
  }

  try {
    const db = await getDb();
    const user = await db.collection("users").findOne({ userId, status: "active" });
    if (!user) {
      return res.status(404).json({ error: "user_not_found", message: "등록되지 않은 아이디입니다." });
    }

    const record = await db.collection("login_codes").findOne({ userId });
    if (!record) {
      return res.status(400).json({ error: "code_missing", message: "먼저 로그인 버튼으로 인증번호를 요청해 주세요." });
    }
    if (!record.passwordVerifiedAt) {
      return res.status(400).json({ error: "password_not_verified", message: "비밀번호 확인 후 인증번호를 요청해 주세요." });
    }
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
      return res.status(400).json({ error: "code_expired", message: "인증번호가 만료되었습니다. 다시 요청해 주세요." });
    }
    if ((record.attempts ?? 0) >= MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({ error: "too_many_attempts", message: "인증 시도 횟수를 초과했습니다. 인증번호를 다시 요청해 주세요." });
    }

    if (record.codeHash !== hashCode(code)) {
      await db.collection("login_codes").updateOne({ userId }, { $inc: { attempts: 1 } });
      return res.status(401).json({ error: "invalid_code", message: "인증번호가 올바르지 않습니다." });
    }

    await db.collection("login_codes").deleteOne({ userId });

    const token = signToken(user);
    return res.json({
      ok: true,
      message: "로그인되었습니다.",
      token,
      expiresIn: JWT_EXPIRES,
      user: publicUser(user),
    });
  } catch (e) {
    console.error("[auth verify]", e?.message || e);
    if (String(e?.message || "").includes("AUTH_JWT_SECRET")) {
      return res.status(503).json({ error: "auth_misconfigured", message: "AUTH_JWT_SECRET 이 설정되지 않았습니다." });
    }
    return res.status(502).json({ error: "db_error", message: "로그인 처리 중 오류가 발생했습니다." });
  }
});

export default router;
