import axios from "axios";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

let geminiWarmedAt = 0;
const GEMINI_WARM_TTL_MS = 4 * 60 * 1000;

const SIMILAR_CANDIDATE_SCHEMA = {
  type: "object",
  properties: {
    commonName: { type: "string", description: "한국어 이름" },
    scientificName: { type: "string", description: "학명" },
    similarityReason: {
      type: "string",
      description: "왜 비슷해 보이는지(잎형·꽃색·크기 등)",
    },
    likelihood: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "사진이 이 종일 가능성",
    },
  },
  required: ["commonName", "scientificName", "similarityReason", "likelihood"],
};

const PLANT_JSON_SCHEMA = {
  type: "object",
  properties: {
    commonName: { type: "string", description: "한국어 일반명" },
    scientificName: { type: "string", description: "학명(라틴어)" },
    plantType: {
      type: "string",
      description: "꽃/나무/풀/약초/관엽 등 분류",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "식별 신뢰도",
    },
    flowerLanguage: { type: "string", description: "꽃말·상징" },
    bloomSeason: {
      type: "string",
      description: "개화·가장 아름다운 시기(월·계절)",
    },
    habitat: { type: "string", description: "주로 자라는 환경·지역" },
    toxicity: {
      type: "object",
      properties: {
        isPoisonous: { type: "boolean" },
        level: {
          type: "string",
          description: "none | mild | moderate | severe | unknown",
        },
        notes: { type: "string", description: "독성·주의사항(한국어)" },
      },
      required: ["isPoisonous", "level", "notes"],
    },
    medicinal: {
      type: "object",
      properties: {
        isMedicinal: { type: "boolean" },
        uses: { type: "string", description: "약용·전통 활용(없으면 없음)" },
        caution: { type: "string", description: "복용·채취 주의" },
      },
      required: ["isMedicinal", "uses", "caution"],
    },
    careTips: { type: "string", description: "재배·관리 팁" },
    funFacts: { type: "string", description: "흥미로운 한 줄" },
    similarCandidates: {
      type: "array",
      description: "비슷하게 생긴 식물 후보 2~4종(1순위 추정 제외)",
      items: SIMILAR_CANDIDATE_SCHEMA,
    },
    disclaimer: {
      type: "string",
      description: "AI 추정·의료·독성 판별은 전문가 확인 권장 문구",
    },
  },
  required: [
    "commonName",
    "scientificName",
    "plantType",
    "confidence",
    "flowerLanguage",
    "bloomSeason",
    "habitat",
    "toxicity",
    "medicinal",
    "careTips",
    "funFacts",
    "similarCandidates",
    "disclaimer",
  ],
};

const SYSTEM_PROMPT = `당신은 식물·꽃·약초를 식별하는 한국어 전문가입니다.
사용자가 올린 사진을 보고 식물을 추정합니다.

규칙:
- 사진에 식물이 없거나 식별이 불가능하면 commonName을 "식별 불가"로 하고 confidence는 "low", similarCandidates는 빈 배열 [].
- 독성·약용 정보는 보수적으로 작성하고, 확실하지 않으면 level을 "unknown", notes/caution에 전문가 확인을 권합니다.
- 꽃말은 한국에서 통용되는 표현을 우선합니다.
- bloomSeason에는 "언제 가장 아름답게 피는지"를 구체적으로(예: 4~5월) 적습니다.
- similarCandidates: 1순위로 추정한 종(commonName)과 다른, 비슷하게 생긴 식물 2~4종. 잎·꽃·전체 형태가 혼동되기 쉬운 종을 골라 similarityReason에 구체적으로 적습니다. 사진이 그 종일 가능성은 likelihood로 표시합니다.
- disclaimer에는 의료·독성 판별은 전문가·공식 자료 확인이 필요함을 한 문장으로 넣습니다.
- 반드시 요청된 JSON 스키마만 따릅니다.`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isGeminiConfigured() {
  return Boolean(GEMINI_API_KEY && GEMINI_API_KEY.trim());
}

function extractJsonText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

function parsePlantJson(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error("empty_model_response");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) return JSON.parse(fence[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("invalid_json_from_model");
  }
}

function generationConfig() {
  const config = {
    temperature: 0.25,
    responseMimeType: "application/json",
    responseSchema: PLANT_JSON_SCHEMA,
    maxOutputTokens: 4096,
  };
  if (/^gemini-2\.5/i.test(GEMINI_MODEL)) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  return config;
}

async function callGemini(body) {
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`;
  const res = await axios.post(url, body, {
    params: { key: GEMINI_API_KEY },
    timeout: 65_000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });
  return res;
}

/** 슬립·콜드스타트 후 첫 Gemini 호출 지연 완화 */
export async function warmupGemini() {
  if (!isGeminiConfigured()) return { ok: false, reason: "missing_key" };
  if (Date.now() - geminiWarmedAt < GEMINI_WARM_TTL_MS) {
    return { ok: true, cached: true };
  }

  const res = await callGemini({
    contents: [{ role: "user", parts: [{ text: "ping" }] }],
    generationConfig: { maxOutputTokens: 8, thinkingConfig: { thinkingBudget: 0 } },
  });

  if (res.status === 200) {
    geminiWarmedAt = Date.now();
    return { ok: true, cached: false };
  }
  return { ok: false, reason: res.data?.error?.message || `HTTP ${res.status}` };
}

/**
 * @param {{ mimeType: string, base64: string }} image
 */
export async function identifyPlantFromImage(image) {
  if (!isGeminiConfigured()) {
    const err = new Error("missing_gemini_key");
    err.code = "missing_gemini_key";
    throw err;
  }

  await warmupGemini().catch(() => {});

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: SYSTEM_PROMPT },
          {
            inline_data: {
              mime_type: image.mimeType,
              data: image.base64,
            },
          },
          {
            text: "이 사진의 식물을 분석하고, 비슷한 후보 종도 함께 JSON으로만 출력하세요.",
          },
        ],
      },
    ],
    generationConfig: generationConfig(),
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await callGemini(body);

      if (res.status === 429 && attempt < 2) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(600 * 2 ** attempt);
        continue;
      }

      if (res.status !== 200) {
        const msg =
          res.data?.error?.message ||
          res.data?.error?.status ||
          `Gemini HTTP ${res.status}`;
        const err = new Error(msg);
        err.code = "gemini_api_error";
        err.status = res.status;
        throw err;
      }

      const blockReason = res.data?.candidates?.[0]?.finishReason;
      if (blockReason === "SAFETY" || blockReason === "RECITATION") {
        const err = new Error("content_blocked");
        err.code = "content_blocked";
        throw err;
      }

      const text = extractJsonText(res.data);
      const parsed = parsePlantJson(text);
      if (!Array.isArray(parsed.similarCandidates)) {
        parsed.similarCandidates = [];
      }
      return parsed;
    } catch (e) {
      lastErr = e;
      if (e.code === "missing_gemini_key" || e.code === "content_blocked") throw e;
      if (attempt < 2 && (e.code === "ECONNABORTED" || e.code === "ETIMEDOUT")) {
        await sleep(700 * 2 ** attempt);
        continue;
      }
      if (attempt < 2 && !e.code) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("gemini_failed");
}
