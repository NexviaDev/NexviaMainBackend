import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  identifyPlantFromImage,
  isGeminiConfigured,
  warmupGemini,
} from "../lib/plantsGemini.js";
import {
  enrichPlantResult,
  enrichSimilarCandidates,
} from "../lib/plantImageLookup.js";

const router = Router();

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const MAX_BASE64_CHARS = 5_500_000;

const plantsLimiter = rateLimit({
  windowMs: 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "rate_limited",
    message: "식물 식별 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  },
});

const warmupLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/health", (_req, res) => {
  res.json({ ok: true, gemini: isGeminiConfigured() });
});

/** 슬립·콜드스타트 완화 — 프론트가 주기적으로 호출 */
router.get("/warmup", warmupLimiter, async (_req, res) => {
  let gemini = { ok: false, reason: "not_configured" };
  if (isGeminiConfigured()) {
    try {
      gemini = await warmupGemini();
    } catch (e) {
      gemini = { ok: false, reason: e?.message || "warmup_failed" };
    }
  }
  res.json({
    ok: true,
    server: true,
    gemini,
    at: new Date().toISOString(),
  });
});

router.post("/identify", plantsLimiter, async (req, res) => {
  if (!isGeminiConfigured()) {
    return res.status(503).json({
      error: "missing_gemini_key",
      message:
        "backend/.env 에 GEMINI_API_KEY 를 설정하세요. Google AI Studio에서 Gemini API 키를 발급받을 수 있습니다.",
    });
  }

  const { imageBase64, mimeType } = req.body ?? {};

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({
      error: "missing_image",
      message: "imageBase64 필드에 사진 데이터가 필요합니다.",
    });
  }

  const raw = imageBase64.replace(/^data:image\/[a-z+]+;base64,/, "").trim();
  if (!raw || raw.length > MAX_BASE64_CHARS) {
    return res.status(400).json({
      error: "invalid_image",
      message: "이미지가 비어 있거나 용량이 너무 큽니다(약 4MB 이하 권장).",
    });
  }

  const mime = String(mimeType || "image/jpeg").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return res.status(400).json({
      error: "invalid_mime",
      message: "JPEG, PNG, WebP, GIF 형식만 지원합니다.",
    });
  }

  try {
    const result = await identifyPlantFromImage({
      mimeType: mime,
      base64: raw,
    });

    const [enriched, similarCandidates] = await Promise.all([
      enrichPlantResult(result),
      enrichSimilarCandidates(result.similarCandidates || []),
    ]);

    return res.json({
      ok: true,
      result: { ...enriched, similarCandidates },
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    });
  } catch (err) {
    console.error("[plants identify]", err?.message || err);

    if (err.code === "missing_gemini_key") {
      return res.status(503).json({
        error: "missing_gemini_key",
        message: "GEMINI_API_KEY 가 설정되지 않았습니다.",
      });
    }
    if (err.code === "content_blocked") {
      return res.status(422).json({
        error: "content_blocked",
        message: "이미지를 분석할 수 없습니다. 다른 사진을 시도해 주세요.",
      });
    }
    if (err.message === "invalid_json_from_model" || err.message === "empty_model_response") {
      return res.status(502).json({
        error: "parse_failed",
        message: "AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.",
      });
    }

    return res.status(502).json({
      error: "identify_failed",
      message:
        err.message ||
        "식물 식별에 실패했습니다. 네트워크·API 키를 확인한 뒤 다시 시도해 주세요.",
    });
  }
});

export default router;
