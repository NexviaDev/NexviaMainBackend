import { Router } from "express";
import rateLimit from "express-rate-limit";
import { runCacheWarm } from "../lib/cacheWarmRun.js";

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

const warmLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "rate_limited",
    message: "캐시 워밍 요청이 너무 많습니다.",
  },
});

/**
 * @param {{ serviceKey: string, fetchBid: Function, fetchPrespec: Function }} deps
 */
export function createCacheWarmRouter(deps) {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      tokenConfigured: Boolean(WARM_TOKEN),
      serviceKeyConfigured: Boolean(deps.serviceKey),
      scheduleMinutes: [20, 50],
      cacheTtlMinutes: 30,
      warmTargets: [
        "bid:Thng",
        "bid:Cnstwk",
        "bid:Servc",
        "prespec:default",
        "bizinfo:support",
        "bizinfo:events",
        "mss:310",
        "mss:81",
      ],
    });
  });

  /**
   * GET /api/v1/cache/warm?token=...
   * 외부 cron 또는 수동 — 구매·공사·용역·사전규격 기본 1페이지 upstream 조회 → 30분 서버 캐시
   * force=1 이면 캐시 hit 여부와 관계없이 재조회
   * (서버 기동 시 :20·:50 자동 갱신 — cacheWarmScheduler.js)
   */
  router.get("/warm", warmLimiter, authWarm, async (req, res) => {
    const force = req.query.force === "1" || req.query.force === "true";
    const result = await runCacheWarm(deps, { force });

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
