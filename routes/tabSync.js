import { Router } from "express";
import rateLimit from "express-rate-limit";
import { isMongoConfigured } from "../lib/mongo.js";
import { findTabSnapshotTarget, TAB_SNAPSHOT_TARGETS } from "../lib/tabSyncKeys.js";
import { getTabSnapshot, listTabSnapshots } from "../lib/tabSyncStore.js";
import { runTabSync } from "../lib/tabSyncRun.js";

const WARM_TOKEN = String(process.env.CACHE_WARM_TOKEN ?? "").trim();

function authWarm(req, res, next) {
  if (!WARM_TOKEN) {
    return res.status(503).json({
      error: "warm_unconfigured",
      message: "CACHE_WARM_TOKEN 이 backend/.env 에 설정되지 않았습니다.",
    });
  }
  const token = String(req.query.token ?? req.headers["x-cache-warm-token"] ?? "").trim();
  if (!token || token !== WARM_TOKEN) {
    return res.status(401).json({
      error: "unauthorized",
      message: "유효하지 않은 token 입니다.",
    });
  }
  next();
}

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const syncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @param {{ serviceKey: string, fetchBid: Function, fetchPrespec: Function, fetchBizinfoSupport?: Function, fetchBizinfoEvents?: Function, warmMssBoard?: Function }} deps
 */
export function createTabSyncRouter(deps) {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      mongoConfigured: isMongoConfigured(),
      targets: TAB_SNAPSHOT_TARGETS.map((t) => t.tabKey),
      scheduleMinutes: [20, 50],
    });
  });

  /** GET /api/v1/tab-sync/status — 탭별 동기화 시각·건수 요약 */
  router.get("/status", readLimiter, async (_req, res) => {
    if (!isMongoConfigured()) {
      return res.status(503).json({
        error: "mongodb_not_configured",
        message: "MONGODB_URI 가 설정되지 않았습니다.",
      });
    }
    try {
      const snapshots = await listTabSnapshots();
      return res.json({ ok: true, snapshots });
    } catch (e) {
      return res.status(502).json({
        error: "tab_sync_read_failed",
        message: e?.message || "조회 실패",
      });
    }
  });

  /** GET /api/v1/tab-sync/snapshot/:tabKey — BidSearchHero 탭 기본 목록 */
  router.get("/snapshot/:tabKey", readLimiter, async (req, res) => {
    const tabKey = String(req.params.tabKey ?? "").trim();
    const target = findTabSnapshotTarget(tabKey);
    if (!target) {
      return res.status(404).json({
        error: "unknown_tab",
        message: "지원하지 않는 tabKey 입니다.",
        allowed: TAB_SNAPSHOT_TARGETS.map((t) => t.tabKey),
      });
    }
    if (!isMongoConfigured()) {
      return res.status(503).json({
        error: "mongodb_not_configured",
        message: "MONGODB_URI 가 설정되지 않았습니다.",
      });
    }
    try {
      const snap = await getTabSnapshot(tabKey);
      if (!snap) {
        return res.status(404).json({
          error: "snapshot_not_found",
          message: "아직 동기화된 스냅샷이 없습니다. :20·:50 동기화를 기다리거나 수동 sync 를 실행하세요.",
          tabKey,
        });
      }
      return res.json({ ok: true, snapshot: snap });
    } catch (e) {
      return res.status(502).json({
        error: "tab_sync_read_failed",
        message: e?.message || "조회 실패",
      });
    }
  });

  /**
   * GET /api/v1/tab-sync/run?token=...
   * 수동 동기화 — upstream + MongoDB (force=1)
   */
  router.get("/run", syncLimiter, authWarm, async (req, res) => {
    const force = req.query.force !== "0" && req.query.force !== "false";
    const result = await runTabSync(deps, { force, syncSlot: "manual" });
    if (result.error === "mongodb_not_configured") {
      return res.status(503).json({
        error: "mongodb_not_configured",
        message: "MONGODB_URI 가 설정되지 않았습니다.",
      });
    }
    if (result.error === "missing_service_key") {
      return res.status(503).json({
        error: "missing_service_key",
        message: "DATA_GO_KR_SERVICE_KEY 가 설정되지 않았습니다.",
      });
    }
    return res.status(result.ok ? 200 : 502).json(result);
  });

  return router;
}
