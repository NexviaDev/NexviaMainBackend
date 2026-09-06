/**
 * NEXCAD license API — https://www.nexvia.co.kr/api/license/v1/*
 * Contract matches Nexvia-CAD-Viewer license-server/server.py
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { isMongoConfigured } from "../lib/mongo.js";
import {
  DEFAULT_PRODUCT_YEAR,
  OFFLINE_LEASE_DAYS,
  clampProductYear,
  formatDisplay,
  issueFloating,
  leaseUntilIso,
  licenseCoversApp,
  makeEntitlementToken,
  normalizeMachineId,
  parseCode,
  todayLocalIso,
  utcNowIso,
} from "../lib/licenseCrypto.js";
import crypto from "node:crypto";
import { expandModules, normalizeTier, tierAtLeast } from "../lib/licenseModules.js";
import {
  findPendingByCode,
  findReturnRequest,
  insertReturnRequest,
  listReturnRequests,
  maskContact,
  nextTicketId,
  setReturnState,
} from "../lib/licenseReturns.js";
import {
  claimSeatActivated,
  clearSeat,
  countSeatsForCode,
  deleteRevocation,
  findRevocation,
  findSeat,
  findSeatByCodeAndMachine,
  findSeatByMachine,
  insertSeatIssued,
  listAudit,
  listRevocations,
  listSeats,
  upsertRevocation,
  updateSeatEntitlement,
  writeAudit,
} from "../lib/licenseStore.js";

const router = Router();

const ADMIN_TOKEN = String(process.env.NEXVIA_LICENSE_ADMIN_TOKEN || "").trim();
/** 라이선스 관리 페이지(`/license-admin`) 진입 비밀번호 — API Admin 토큰과 별개. */
const PAGE_PASSWORD = String(process.env.NEXVIA_LICENSE_ADMIN_PAGE_PASSWORD || "").trim();
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
/** 개발 편의용 기본 토큰은 **운영에서 금지**. 미설정 상태로 배포되면 관리자 API 를 연다. */
const ADMIN_TOKEN_OK = ADMIN_TOKEN.length >= 24 || (!IS_PROD && ADMIN_TOKEN.length > 0);
if (IS_PROD && !ADMIN_TOKEN_OK) {
  console.error(
    "[license] NEXVIA_LICENSE_ADMIN_TOKEN 이 없거나 24자 미만입니다 — 관리자 API 를 모두 차단합니다."
  );
}
if (IS_PROD && !PAGE_PASSWORD) {
  console.error(
    "[license] NEXVIA_LICENSE_ADMIN_PAGE_PASSWORD 가 없습니다 — /license-admin 페이지 게이트를 차단합니다."
  );
}

const licenseLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});

const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});

/** 리턴 신청은 사람이 손으로 넣는 폼 — 분당 5회면 충분하다(자동 살포 차단). */
const returnLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});

/** 페이지 게이트 비밀번호 추측 차단. */
const pageGateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});

function requireMongo(res) {
  if (!isMongoConfigured()) {
    res.status(503).json({
      ok: false,
      error: "mongo_unconfigured",
      message: "MONGODB_URI 가 backend/.env 에 설정되지 않았습니다.",
    });
    return false;
  }
  return true;
}

/** 길이 노출·타이밍 공격을 막는 상수시간 비교. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  const len = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ba.copy(pa);
  bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && ba.length === bb.length;
}

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN_OK) {
    res.status(503).json({ ok: false, error: "admin_disabled" });
    return false;
  }
  const token = String(req.headers["x-admin-token"] ?? "").trim();
  if (!token || !safeEqual(token, ADMIN_TOKEN)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

/** 신청 폼 입력 정리 — 길이 상한을 넘으면 거절(자르지 않는다). */
function field(raw, { max, min = 0, label }) {
  const v = String(raw ?? "").trim();
  if (v.length < min) throw new Error(`${label} 이(가) 필요합니다`);
  if (v.length > max) throw new Error(`${label} 이(가) 너무 깁니다 (최대 ${max}자)`);
  return v;
}

function validPhone(v) {
  return /^[0-9+\-() .]{6,24}$/.test(v);
}

function validEmail(v) {
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/** 좌석 행에서 자격(등급·모듈)을 만든다. 없으면 CAD 로 본다(구 데이터 호환). */
function entitlementTier(row) {
  return normalizeTier(row?.tier) || "cad";
}

router.get("/v1/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "nexvia-license",
    seats: "N_slots_per_key",
    offline_lease_days: OFFLINE_LEASE_DAYS,
    base: "/api/license",
    mongo: isMongoConfigured(),
    default_product_year: DEFAULT_PRODUCT_YEAR,
    product_year_rule: "license_year >= app_year",
  });
});

/**
 * 라이선스 관리 SPA 진입 비밀번호 검증.
 * 성공 시 프론트가 ?security=nexgeom 으로 이동한다.
 * Admin API 토큰(NEXVIA_LICENSE_ADMIN_TOKEN)과 별개 — NEXVIA_LICENSE_ADMIN_PAGE_PASSWORD.
 */
router.post("/v1/admin/page-gate", pageGateLimiter, (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!PAGE_PASSWORD) {
    res.status(503).json({
      ok: false,
      error: "page_gate_unconfigured",
      message: "NEXVIA_LICENSE_ADMIN_PAGE_PASSWORD 가 backend/.env 에 없습니다.",
    });
    return;
  }
  const password = String(req.body?.password ?? "");
  if (!password || !safeEqual(password, PAGE_PASSWORD)) {
    res.status(401).json({ ok: false, error: "invalid_password", message: "비밀번호가 올바르지 않습니다." });
    return;
  }
  res.json({
    ok: true,
    unlock: "nexgeom",
    security_param: "security",
    security_value: "nexgeom",
  });
});

router.post("/v1/admin/issue", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  try {
    const kind = String(req.body?.kind || "perpetual").toLowerCase();
    const expiresS = req.body?.expires ? String(req.body.expires).trim() : null;
    let expires = null;
    if (expiresS) {
      const d = new Date(`${expiresS}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ ok: false, error: "invalid expires" });
      }
      expires = d;
    }
    if (kind !== "perpetual" && kind !== "term") {
      return res.status(400).json({ ok: false, error: "kind must be perpetual|term" });
    }
    const tier = normalizeTier(req.body?.tier ?? "cad");
    if (!tier) {
      return res.status(400).json({ ok: false, error: "tier must be viewer|cad|re" });
    }
    const productYear = clampProductYear(
      req.body?.product_year != null && req.body?.product_year !== ""
        ? req.body.product_year
        : DEFAULT_PRODUCT_YEAR,
    );
    const qtyRaw = Number(req.body?.qty ?? req.body?.quantity ?? 1);
    const qty = Math.max(1, Math.min(50, Number.isFinite(qtyRaw) ? Math.floor(qtyRaw) : 1));
    const now = utcNowIso();
    // Format v3: Issue 마다 고유 코드. qty = 그 코드 아래 좌석 수
    const code = issueFloating(kind, expires, productYear);
    const parsed = parseCode(code);
    const seatIds = [];
    for (let i = 0; i < qty; i++) {
      const seatId = await insertSeatIssued({
        codeBody: parsed.body,
        kind: parsed.kind,
        expires: parsed.expires,
        tier,
        productYear: parsed.product_year,
        updatedAt: now,
      });
      seatIds.push(seatId);
    }
    const pool = await countSeatsForCode(parsed.body);
    await writeAudit("issue", {
      license_code: code,
      seat_ids: seatIds,
      qty,
      kind,
      expires: expires ? expires.toISOString().slice(0, 10) : null,
      tier,
      product_year: parsed.product_year,
      seats_total: pool.total,
    });
    return res.json({
      ok: true,
      qty,
      seats_created: qty,
      seats_total: pool.total,
      seats_free: pool.free,
      license_code: code,
      license_codes: [code],
      seat_ids: seatIds,
      kind,
      expires: expires ? expires.toISOString().slice(0, 10) : null,
      tier,
      product_year: parsed.product_year,
      modules: expandModules(tier),
      note:
        "발급마다 고유 플로팅 코드가 생성됩니다. 수량(qty)은 이 코드의 좌석 수입니다. " +
        `이 키는 NEXGEOM ${parsed.product_year} 및 그 이하 연도 앱에서 사용 가능합니다.`,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post("/v1/admin/force-return", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  try {
    const code = req.body?.license_code || req.body?.code || "";
    let machineId = normalizeMachineId(req.body?.machine_id);
    const now = utcNowIso();
    let body = null;
    let row = null;

    if (code) {
      const parsed = parseCode(String(code));
      body = parsed.body;
      row = await findSeat(body);
    } else if (machineId) {
      row = await findSeatByMachine(machineId);
      if (row) body = row.codeBody;
    } else {
      return res.status(400).json({ ok: false, error: "license_code or machine_id required" });
    }

    if (!row) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const mid = machineId || row.machineId || "";
    if (mid) {
      await upsertRevocation({
        codeBody: body,
        machineId: mid,
        revokedAt: now,
        reason: String(req.body?.reason || "admin_force_return"),
      });
    }
    await clearSeat(body, now, mid || undefined);
    await writeAudit("force-return", {
      license_code: formatDisplay(body),
      machine_id: mid || null,
      reason: req.body?.reason || "admin_force_return",
    });
    return res.json({
      ok: true,
      message: "forced_return",
      license_code: body ? formatDisplay(body) : null,
      machine_id: mid || null,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get("/v1/admin/seats", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  const limit = Number(req.query.limit) || 200;
  const seats = await listSeats(limit);
  return res.json({
    ok: true,
    seats: seats.map((s) => {
      let productYear = s.productYear ?? null;
      if (productYear == null && s.codeBody) {
        try {
          productYear = parseCode(formatDisplay(s.codeBody)).product_year;
        } catch {
          productYear = null;
        }
      }
      return {
        seat_id: s.seatId ?? null,
        license_code: formatDisplay(s.codeBody),
        kind: s.kind,
        tier: s.tier ?? null,
        expires: s.expires ?? null,
        product_year: productYear,
        machine_id: s.machineId ?? null,
        activated_at: s.activatedAt ?? null,
        updated_at: s.updatedAt ?? null,
        issued_at: s.issuedAt ?? null,
      };
    }),
  });
});

router.get("/v1/admin/revocations", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  const limit = Number(req.query.limit) || 100;
  const rows = await listRevocations(limit);
  return res.json({
    ok: true,
    revocations: rows.map((r) => ({
      license_code: formatDisplay(r.codeBody),
      machine_id: r.machineId,
      revoked_at: r.revokedAt,
      reason: r.reason ?? null,
    })),
  });
});

router.get("/v1/admin/audit", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  const limit = Number(req.query.limit) || 100;
  const rows = await listAudit(limit);
  return res.json({ ok: true, audit: rows });
});

router.post("/v1/activate", licenseLimiter, async (req, res) => {
  if (!requireMongo(res)) return;
  try {
    const code = req.body?.license_code || req.body?.code || "";
    const machineId = normalizeMachineId(req.body?.machine_id);
    const appYear = clampProductYear(
      req.body?.product_year != null && req.body?.product_year !== ""
        ? req.body.product_year
        : DEFAULT_PRODUCT_YEAR,
    );
    if (machineId.length !== 64) {
      return res.status(400).json({ ok: false, error: "machine_id must be 64 hex chars" });
    }
    const parsed = parseCode(String(code));
    if (!parsed.floating) {
      return res.status(400).json({ ok: false, error: "floating key required" });
    }
    if (parsed.kind === "term" && parsed.expires) {
      if (todayLocalIso() > parsed.expires) {
        return res.status(403).json({ ok: false, error: "license expired" });
      }
    }

    const licYear = parsed.product_year;
    if (!licenseCoversApp(licYear, appYear)) {
      return res.status(403).json({
        ok: false,
        error: "version_too_low",
        message:
          `License is for NEXGEOM ${licYear}; ` +
          `this app is NEXGEOM ${appYear}. ` +
          `A ${appYear}+ license is required ` +
          `(higher-year keys work on older apps).`,
        license_year: licYear,
        app_year: appYear,
      });
    }

    const body = parsed.body;
    const now = utcNowIso();
    let row;
    try {
      row = await claimSeatActivated({
        codeBody: body,
        kind: parsed.kind,
        expires: parsed.expires,
        tier: "cad",
        productYear: licYear,
        machineId,
        activatedAt: now,
        updatedAt: now,
      });
    } catch (e) {
      if (e?.code === "seat_in_use" || String(e?.message) === "seat_in_use") {
        return res.status(409).json({
          ok: false,
          error: "seat_in_use",
          message: "All seats for this key are in use. Return or force-return first.",
        });
      }
      throw e;
    }
    await deleteRevocation(body, machineId);

    const tier = entitlementTier(row);
    const lease = leaseUntilIso();
    // product_year 필수 — CAD 가 없으면 2026으로 간주해 2027 앱에서 로컬 검증 실패.
    const entitlement = {
      v: 1,
      license_code: parsed.display,
      machine_id: machineId,
      kind: parsed.kind,
      expires: parsed.expires,
      product_year: licYear,
      // 오프라인 유예 중 등급 위조를 막으려면 **서명 대상 안에** 있어야 한다.
      tier,
      modules: expandModules(tier),
      activated_at: now,
      lease_until: lease,
      offline_lease_days: OFFLINE_LEASE_DAYS,
    };
    const token = makeEntitlementToken(entitlement);
    await writeAudit("activate", {
      license_code: parsed.display,
      machine_id: machineId,
      product_year: licYear,
    });
    return res.json({
      ok: true,
      entitlement,
      token,
      lease_until: lease,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post("/v1/deactivate", licenseLimiter, async (req, res) => {
  if (!requireMongo(res)) return;
  try {
    const code = req.body?.license_code || req.body?.code || "";
    const machineId = normalizeMachineId(req.body?.machine_id);
    const parsed = parseCode(String(code));
    const body = parsed.body;
    const now = utcNowIso();
    const row = machineId
      ? await findSeatByCodeAndMachine(body, machineId)
      : await findSeat(body);
    if (!row || !row.machineId) {
      return res.json({ ok: true, message: "already_free" });
    }
    if (machineId && row.machineId !== machineId) {
      return res.status(403).json({
        ok: false,
        error: "machine_mismatch",
        message: "Only the activated PC can return this seat.",
      });
    }
    await clearSeat(body, now, row.machineId);
    await writeAudit("deactivate", {
      license_code: parsed.display,
      machine_id: machineId || row.machineId,
      seat_id: row.seatId ?? null,
    });
    return res.json({ ok: true, message: "returned" });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post("/v1/status", licenseLimiter, async (req, res) => {
  if (!requireMongo(res)) return;
  try {
    const code = req.body?.license_code || req.body?.code || "";
    const machineId = normalizeMachineId(req.body?.machine_id);
    const appYear = clampProductYear(
      req.body?.product_year != null && req.body?.product_year !== ""
        ? req.body.product_year
        : DEFAULT_PRODUCT_YEAR,
    );
    if (machineId.length !== 64) {
      return res.status(400).json({ ok: false, error: "machine_id must be 64 hex chars" });
    }
    const parsed = parseCode(String(code));
    const body = parsed.body;
    const licYear = parsed.product_year;

    const [rev, row] = await Promise.all([
      findRevocation(body, machineId),
      findSeatByCodeAndMachine(body, machineId),
    ]);

    if (rev && (!row || !row.machineId || row.machineId !== machineId)) {
      return res.json({
        ok: true,
        state: "forced_return",
        message: "License was force-returned by administrator.",
        offline_lease_days: OFFLINE_LEASE_DAYS,
      });
    }

    if (!row || !row.machineId) {
      return res.json({
        ok: true,
        state: "not_active",
        message: "Not registered on this seat.",
        offline_lease_days: OFFLINE_LEASE_DAYS,
      });
    }

    if (row.machineId !== machineId) {
      return res.json({
        ok: true,
        state: "seat_mismatch",
        message: "Seat is bound to another machine.",
        offline_lease_days: OFFLINE_LEASE_DAYS,
      });
    }

    if (parsed.kind === "term" && parsed.expires) {
      if (todayLocalIso() > parsed.expires) {
        return res.json({
          ok: true,
          state: "expired",
          message: "License term expired.",
          offline_lease_days: OFFLINE_LEASE_DAYS,
        });
      }
    }

    if (!licenseCoversApp(licYear, appYear)) {
      return res.json({
        ok: true,
        state: "version_too_low",
        message:
          `License is for NEXGEOM ${licYear}; ` +
          `this app is NEXGEOM ${appYear}. ` +
          `A ${appYear}+ license is required.`,
        license_year: licYear,
        app_year: appYear,
        product_year: licYear,
        offline_lease_days: OFFLINE_LEASE_DAYS,
      });
    }

    const lease = leaseUntilIso();
    const tier = entitlementTier(row);
    const pending = await findPendingByCode(body);
    return res.json({
      ok: true,
      state: "active",
      message: "Registered",
      lease_until: lease,
      offline_lease_days: OFFLINE_LEASE_DAYS,
      kind: parsed.kind,
      expires: parsed.expires,
      product_year: licYear,
      tier,
      modules: expandModules(tier),
      // 구 클라이언트가 모르는 필드 — state 를 바꾸지 않아 호환이 깨지지 않는다.
      return_request: pending ? { ticket: pending.ticket, state: pending.state } : null,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});


/* ──────────────────────────────────────────────────────────────
 * 업그레이드 — 코드는 그대로, 자격만 올린다.
 * 요구사항: 「업그레이드시 라이선스 코드는 변경이 아니라 권한을 확장해서 준 방식으로」
 * ────────────────────────────────────────────────────────────── */
router.post("/v1/upgrade", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  try {
    const code = req.body?.license_code || req.body?.code || "";
    if (!code) return res.status(400).json({ ok: false, error: "license_code required" });
    const parsed = parseCode(String(code));
    const row = await findSeat(parsed.body);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });

    const current = normalizeTier(row.tier) || "cad";
    const toTier = req.body?.to_tier ? normalizeTier(req.body.to_tier) : current;
    if (!toTier) {
      return res.status(400).json({ ok: false, error: "to_tier must be viewer|cad|re" });
    }
    // 다운그레이드는 결제·환불과 얽히므로 이 API 로는 막는다(관리자 수동 처리).
    if (!tierAtLeast(toTier, current)) {
      return res.status(400).json({ ok: false, error: "downgrade_not_allowed", current });
    }

    let expires = row.expires ?? null;
    if (req.body?.extend_to !== undefined && req.body.extend_to !== null) {
      const s = String(req.body.extend_to).trim();
      if (s === "") {
        expires = null; // 영구 전환
      } else {
        const d = new Date(`${s}T00:00:00.000Z`);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ ok: false, error: "invalid extend_to" });
        }
        if (row.expires && s < String(row.expires)) {
          return res.status(400).json({ ok: false, error: "extend_to_must_not_shorten" });
        }
        expires = s;
      }
    }

    const now = utcNowIso();
    await updateSeatEntitlement({ codeBody: parsed.body, tier: toTier, expires, updatedAt: now });
    await writeAudit("upgrade", {
      license_code: parsed.display,
      from_tier: current,
      to_tier: toTier,
      expires,
      by: "admin",
    });
    // 앱은 다음 /v1/status 에서 바뀐 자격을 받는다 — 고객이 코드를 다시 넣을 필요가 없다.
    return res.json({
      ok: true,
      license_code: parsed.display,
      tier: toTier,
      modules: expandModules(toTier),
      expires,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ──────────────────────────────────────────────────────────────
 * 리턴 / 강제리턴 신청 — 프로그램(NEXGEOM) 안에서 보낸다.
 *
 *  normal : 내 PC 에서 반납. 좌석이 이 PC 로 묶여 있으면 즉시 풀어 준다.
 *  forced : PC 고장·분실로 그 PC 에서 반납 불가 → 관리자 승인 후 해제.
 *           라이선스 코드·이름·연락처·업체명 + 동의가 **모두** 있어야 접수된다.
 * ────────────────────────────────────────────────────────────── */
router.post("/v1/return-request", returnLimiter, async (req, res) => {
  if (!requireMongo(res)) return;
  try {
    const code = req.body?.license_code || req.body?.code || "";
    if (!code) return res.status(400).json({ ok: false, error: "license_code required" });
    const parsed = parseCode(String(code));
    const machineId = normalizeMachineId(req.body?.machine_id);
    const kind = String(req.body?.kind || "normal").toLowerCase();
    if (kind !== "normal" && kind !== "forced") {
      return res.status(400).json({ ok: false, error: "kind must be normal|forced" });
    }
    const reason = field(req.body?.reason, { max: 300, label: "사유" });

    let contact = { name: "", phone: "", company: "", email: "" };
    if (kind === "forced") {
      // 요구사항: 강제리턴은 코드·이름·연락처·업체명이 전부 있어야 하고 동의를 받아야 한다.
      contact = {
        name: field(req.body?.contact?.name, { max: 40, min: 1, label: "이름" }),
        phone: field(req.body?.contact?.phone, { max: 24, min: 6, label: "연락처" }),
        company: field(req.body?.contact?.company, { max: 80, min: 1, label: "업체명" }),
        email: field(req.body?.contact?.email ?? "", { max: 254, label: "이메일" }),
      };
      if (!validPhone(contact.phone)) {
        return res.status(400).json({ ok: false, error: "invalid_phone" });
      }
      if (contact.email && !validEmail(contact.email)) {
        return res.status(400).json({ ok: false, error: "invalid_email" });
      }
      if (req.body?.consent !== true) {
        return res.status(400).json({ ok: false, error: "consent_required" });
      }
    }

    const dup = await findPendingByCode(parsed.body);
    if (dup) {
      return res.json({ ok: true, ticket: dup.ticket, state: dup.state, duplicate: true });
    }

    const now = utcNowIso();
    let state = kind === "forced" ? "received" : "returned";

    if (kind === "normal") {
      // 셀프 반납 — 좌석이 이 PC 로 묶여 있을 때만 푼다(남의 좌석을 풀 수 없다).
      const row = machineId
        ? await findSeatByCodeAndMachine(parsed.body, machineId)
        : null;
      if (!row || !row.machineId) {
        state = "returned"; // 이미 비어 있음
      } else if (machineId && row.machineId === machineId) {
        await clearSeat(parsed.body, now, machineId);
      } else {
        // 다른 PC 의 좌석이면 강제리턴 대상이다.
        return res.status(409).json({
          ok: false,
          error: "seat_bound_to_other_machine",
          message: "다른 PC 에 등록된 좌석입니다 — 강제리턴으로 신청하세요.",
        });
      }
    }

    // 같은 날 동시 신청이면 순번이 겹칠 수 있다 — 유니크 인덱스에 걸리면 다시 딴다.
    let ticket = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      ticket = await nextTicketId(new Date());
      try {
        await insertReturnRequest({
          ticket,
          codeBody: parsed.body,
          licenseCode: parsed.display,
          machineId: machineId || null,
          kind,
          reason,
          contact,
          consent: kind === "forced" ? true : Boolean(req.body?.consent),
          consentTextVersion: field(req.body?.consent_text_version ?? "", { max: 32, label: "동의 문구 버전" }),
          state,
          createdAt: now,
          updatedAt: now,
        });
        break;
      } catch (e) {
        const dupKey = String(e?.code) === "11000";
        if (!dupKey || attempt === 3) throw e;
      }
    }
    await writeAudit("return-request", {
      ticket,
      license_code: parsed.display,
      kind,
      state,
      company: contact.company || null,
    });
    return res.json({ ok: true, ticket, state });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get("/v1/admin/return-requests", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  const state = req.query.state ? String(req.query.state) : null;
  const full = String(req.query.full || "") === "1";
  const rows = await listReturnRequests({ state, limit: Number(req.query.limit) || 100 });
  return res.json({
    ok: true,
    requests: rows.map((r) => ({
      ticket: r.ticket,
      license_code: r.licenseCode,
      kind: r.kind,
      state: r.state,
      reason: r.reason,
      // 개인정보는 기본 마스킹 — 실제 값이 필요할 때만 full=1 (감사 로그에 남는다).
      contact: maskContact(r.contact, full),
      consent: Boolean(r.consent),
      consent_text_version: r.consentTextVersion || null,
      machine_id: r.machineId || null,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    })),
  });
});

router.post("/v1/admin/return-requests/:ticket/approve", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  try {
    const ticket = String(req.params.ticket || "").trim();
    const row = await findReturnRequest(ticket);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    if (row.state !== "received") {
      return res.status(409).json({ ok: false, error: "not_pending", state: row.state });
    }
    const now = utcNowIso();
    const seat = await findSeat(row.codeBody);
    const mid = row.machineId || seat?.machineId || "";
    if (mid) {
      await upsertRevocation({
        codeBody: row.codeBody,
        machineId: mid,
        revokedAt: now,
        reason: `return_request:${ticket}`,
      });
    }
    await clearSeat(row.codeBody, now, mid || undefined);
    await setReturnState(ticket, "forced_return", { approvedAt: now });
    await writeAudit("return-approve", {
      ticket,
      license_code: row.licenseCode,
      machine_id: mid || null,
    });
    return res.json({ ok: true, ticket, state: "forced_return", license_code: row.licenseCode });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post("/v1/admin/return-requests/:ticket/reject", adminLimiter, async (req, res) => {
  if (!requireAdmin(req, res) || !requireMongo(res)) return;
  try {
    const ticket = String(req.params.ticket || "").trim();
    const row = await findReturnRequest(ticket);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    if (row.state !== "received") {
      return res.status(409).json({ ok: false, error: "not_pending", state: row.state });
    }
    const reason = field(req.body?.reason ?? "", { max: 300, label: "반려 사유" });
    await setReturnState(ticket, "rejected", { rejectedReason: reason, rejectedAt: utcNowIso() });
    await writeAudit("return-reject", { ticket, license_code: row.licenseCode, reason });
    return res.json({ ok: true, ticket, state: "rejected" });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
