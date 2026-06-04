import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import axios from "axios";
import plantsRouter from "./routes/plants.js";
import docMergeRouter from "./routes/docMerge.js";
import authRouter from "./routes/auth.js";
import listTemplatesRouter from "./routes/listTemplates.js";
import { createCacheWarmRouter } from "./routes/cacheWarm.js";
import { startCacheWarmScheduler } from "./lib/cacheWarmScheduler.js";
import { sendUpstreamCacheHit } from "./lib/proxyJsonCache.js";
import { fetchMssRssBoard } from "./lib/mssRss.js";
import {
  readUpstreamQueryCache,
  writeUpstreamQueryCache,
} from "./lib/upstreamQueryCache.js";

const PORT = Number(process.env.PORT) || 5001;
const BASE =
  process.env.BID_PUBLIC_INFO_BASE_URL?.replace(/\/$/, "") ||
  "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
const OPENG_BASE =
  process.env.OPENG_RESULT_BASE_URL?.replace(/\/$/, "") ||
  "https://apis.data.go.kr/1230000/as/ScsbidInfoService";
/** 나라장터 사전규격정보 — 참고문서 End Point(포털·버전에 따라 …/ao/… 가 다를 수 있음, PRESPEC_BASE_URL 로 덮어씀). */
const PRESPEC_BASE =
  process.env.PRESPEC_BASE_URL?.replace(/\/$/, "") ||
  "https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService";
/** 나라장터 발주계획현황 — 참고문서 End Point(ORDR_PLAN_BASE_URL 로 덮어씀). */
const ORDR_PLAN_BASE =
  process.env.ORDR_PLAN_BASE_URL?.replace(/\/$/, "") ||
  "https://apis.data.go.kr/1230000/ao/OrderPlanSttusService";
const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || "";
const BIZINFO_URL = (
  process.env.BIZINFO_API_URL || "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do"
).replace(/\/$/, "");
const BIZINFO_EVENT_URL = (
  process.env.BIZINFO_EVENT_API_URL || "https://www.bizinfo.go.kr/uss/rss/bizinfoEventApi.do"
).replace(/\/$/, "");
const BIZINFO_CRTFC_KEY = process.env.BIZINFO_CRTFC_KEY || "";
/** 낙찰 API 인증 쿼리: serviceKey(기본) | ServiceKey | both — 동시 전달 시 403 나는 환경이 있어 기본은 serviceKey 만 */
const OPENG_AUTH_QUERY = String(process.env.OPENG_AUTH_QUERY || "serviceKey").trim();
/** 사전규격·발주계획 API 인증 쿼리(기본 ServiceKey — 입찰공고와 동일). 403·Unexpected 시 serviceKey 또는 both 로 시도. */
const PRESPEC_AUTH_QUERY = String(process.env.PRESPEC_AUTH_QUERY || "ServiceKey").trim();
const ORDR_PLAN_AUTH_QUERY = String(process.env.ORDR_PLAN_AUTH_QUERY || "ServiceKey").trim();
const DATA_GO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DATA_GO_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent": DATA_GO_UA,
};

const BIZINFO_FORWARD_PARAMS = new Set([
  "dataType",
  "pageUnit",
  "pageIndex",
  "searchLclasId",
  "hashtags",
  "searchCnt",
  "schJrsdCodeTy",
]);

// Git Bash 등에서 오류가 안 보일 때도 원인 추적용으로 한 줄 남깁니다.
console.error(
  `[bid-api] boot ${new Date().toISOString()} | node ${process.version} | cwd ${process.cwd()} | PORT ${PORT}`
);

function corsOrigin() {
  const raw = process.env.FRONTEND_ORIGIN;
  if (!raw || !String(raw).trim()) return true;
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : true;
}

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin: corsOrigin(),
  })
);
app.use(express.json({ limit: "16mb" }));

const limiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", limiter);

function isAllowedOperation(name) {
  return typeof name === "string" && /^getBidPblanc[A-Za-z0-9]+$/.test(name);
}

function isAllowedOpengOperation(name) {
  return typeof name === "string" && /^getOpengResult[A-Za-z0-9]+$/.test(name);
}

function isAllowedScsbidOperation(name) {
  return typeof name === "string" && /^getScsbidListSttus[A-Za-z0-9]+$/.test(name);
}

/** 예비가 상세 — upstream 이 데이터 없을 때 HTTP 404(빈 본문)를 주는 경우가 있음 */
function isPreparPcDetailOperation(name) {
  return typeof name === "string" && /PreparPcDetail$/i.test(name);
}

function emptyOpengJson() {
  return {
    response: {
      header: { resultCode: "00", resultMsg: "정상" },
      body: { items: [], totalCount: 0 },
    },
  };
}

function isAllowedPrespecOperation(name) {
  return (
    typeof name === "string" &&
    (/^getPublicPrcure[A-Za-z0-9]+$/.test(name) ||
      /^getInsttAccto[A-Za-z0-9]+$/.test(name) ||
      /^getThngDetailMeta[A-Za-z0-9]+$/.test(name))
  );
}

function isAllowedOrdrPlanOperation(name) {
  return (
    typeof name === "string" &&
    (/^getOrdrPlanPcure[A-Za-z0-9]+$/.test(name) ||
      /^getOrdrPlanSttus[A-Za-z0-9]+$/.test(name) ||
      /^getOrderPlanSttus[A-Za-z0-9]+$/.test(name))
  );
}

const MSS_RSS_ALLOWED = new Set(["310", "81"]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 공공데이터 JSON 본문의 resultCode(00 이외) 추출 */
function parseDataGoHeaderError(rawText) {
  const raw = String(rawText ?? "").trim();
  if (!raw || raw === "Unexpected errors") return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      for (const v of Object.values(o)) {
        if (!v || typeof v !== "object" || !("header" in v)) continue;
        const h = v.header;
        if (!h || typeof h !== "object") continue;
        const code = h.resultCode ?? h.resultcode;
        const msg = h.resultMsg ?? h.resultmsg;
        if (code != null && String(code) !== "00") {
          return { code: String(code), msg: String(msg || "") };
        }
      }
      const resp = o.response;
      if (resp && typeof resp === "object" && resp.header && typeof resp.header === "object") {
        const h = resp.header;
        const code = h.resultCode ?? h.resultcode;
        const msg = h.resultMsg ?? h.resultmsg;
        if (code != null && String(code) !== "00") {
          return { code: String(code), msg: String(msg || "") };
        }
      }
    }
  } catch {
    /* plain text 등 */
  }
  return null;
}

function respondDataGoUpstream(res, { status, data, contentType }, opts) {
  const rawText = typeof data === "string" ? data : String(data ?? "");
  const trimmed = rawText.trim();
  const lo = trimmed.toLowerCase();

  if (status === 403 || lo === "forbidden" || lo.includes("403 forbidden")) {
    return res.status(502).json({
      error: "data_go_forbidden",
      message: opts.forbiddenMessage,
    });
  }
  if (status === 500 && trimmed === "Unexpected errors") {
    return res.status(502).json({
      error: "data_go_gateway_error",
      message: opts.unexpectedMessage,
    });
  }

  const apiErr = parseDataGoHeaderError(rawText);
  if (apiErr) {
    return res.status(502).json({
      error: "data_go_api_error",
      resultCode: apiErr.code,
      message:
        apiErr.msg ||
        opts.apiErrorFallback ||
        `공공데이터 API 오류(resultCode=${apiErr.code})`,
    });
  }

  res.status(status);
  if (contentType.includes("json") || trimmed.startsWith("{")) {
    try {
      return res.json(JSON.parse(rawText));
    } catch {
      return res.type("application/json").send(rawText);
    }
  }
  if (contentType.includes("xml")) {
    res.type("application/xml");
  }
  return res.send(data);
}

async function fetchUpstream(baseUrl, operation, query) {
  const url = `${baseUrl}/${operation}`;
  const params = { ...query };
  delete params.serviceKey;
  delete params.ServiceKey;
  // 공공데이터포털 예제는 대부분 ServiceKey(대문자 S) 쿼리명을 사용합니다.
  params.ServiceKey = SERVICE_KEY;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, {
        params,
        timeout: 60_000,
        validateStatus: () => true,
        responseType: "text",
        transitional: { forcedJSONParsing: false },
        headers: DATA_GO_HEADERS,
      });
      const ct = res.headers["content-type"] || "";
      if (res.status >= 500 && attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return { status: res.status, data: res.data, contentType: ct };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr || new Error("upstream_failed");
}

/** 사전규격·발주계획 등 — PRESPEC_AUTH_QUERY / ORDR_PLAN_AUTH_QUERY 로 serviceKey 전달 방식 선택 */
async function fetchUpstreamDataGoAuth(baseUrl, operation, query, authQuery) {
  const url = `${baseUrl}/${operation}`;
  const params = { ...query };
  delete params.serviceKey;
  delete params.ServiceKey;
  const authQ = String(authQuery || "ServiceKey").trim();
  if (/^both$/i.test(authQ)) {
    params.ServiceKey = SERVICE_KEY;
    params.serviceKey = SERVICE_KEY;
  } else if (/^serviceKey$/i.test(authQ)) {
    params.serviceKey = SERVICE_KEY;
  } else {
    params.ServiceKey = SERVICE_KEY;
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, {
        params,
        timeout: 60_000,
        validateStatus: () => true,
        responseType: "text",
        transitional: { forcedJSONParsing: false },
        headers: DATA_GO_HEADERS,
      });
      const ct = res.headers["content-type"] || "";
      if (res.status >= 500 && attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return { status: res.status, data: res.data, contentType: ct };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr || new Error("upstream_failed");
}
async function fetchUpstreamOpeng(baseUrl, operation, query) {
  const url = `${baseUrl}/${operation}`;
  const params = { ...query };
  delete params.serviceKey;
  delete params.ServiceKey;
  const authQ = OPENG_AUTH_QUERY;
  if (/^both$/i.test(authQ)) {
    params.ServiceKey = SERVICE_KEY;
    params.serviceKey = SERVICE_KEY;
  } else if (authQ === "ServiceKey") {
    params.ServiceKey = SERVICE_KEY;
  } else {
    params.serviceKey = SERVICE_KEY;
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, {
        params,
        timeout: 60_000,
        validateStatus: () => true,
        responseType: "text",
        transitional: { forcedJSONParsing: false },
        headers: DATA_GO_HEADERS,
      });
      const ct = res.headers["content-type"] || "";
      if (res.status >= 500 && attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return { status: res.status, data: res.data, contentType: ct };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr || new Error("upstream_failed");
}

async function fetchBizinfoUpstream(bizinfoUrl, query) {
  const params = { crtfcKey: BIZINFO_CRTFC_KEY };
  for (const [k, v] of Object.entries(query)) {
    if (!BIZINFO_FORWARD_PARAMS.has(k)) continue;
    if (Array.isArray(v)) {
      const joined = v.map(String).join(",").trim();
      if (joined.length && joined.length <= 2000) params[k] = joined;
    } else if (v != null && String(v).trim()) {
      const s = String(v).trim();
      if (s.length <= 2000) params[k] = s;
    }
  }
  if (!params.dataType) params.dataType = "json";

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(bizinfoUrl, {
        params,
        timeout: 60_000,
        validateStatus: () => true,
        responseType: "text",
        transitional: { forcedJSONParsing: false },
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        },
      });
      const ct = res.headers["content-type"] || "";
      if (res.status >= 500 && attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return { status: res.status, data: res.data, contentType: ct };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr || new Error("bizinfo_upstream_failed");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/v1/plants", plantsRouter);
app.use("/api/v1/doc-merge", docMergeRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/list-templates", listTemplatesRouter);

app.get("/api/v1/bid/:operation", async (req, res) => {
  const { operation } = req.params;
  if (!isAllowedOperation(operation)) {
    return res.status(400).json({
      error: "invalid_operation",
      message:
        "허용되지 않은 오퍼레이션입니다. swagger의 메서드명(getBidPblanc...)과 동일한지 확인하세요.",
    });
  }
  if (!SERVICE_KEY) {
    return res.status(503).json({
      error: "missing_service_key",
      message:
        "backend/.env 의 DATA_GO_KR_SERVICE_KEY 가 비어 있습니다. 공공데이터포털 인증키를 설정하세요.",
    });
  }

  try {
    const q = { ...req.query };
    if (!q.type) q.type = "json";
    delete q.nxRefresh;
    delete q.nx_refresh;

    const cacheProbe = readUpstreamQueryCache("bid", operation, req.query);
    if (cacheProbe.hit) {
      res.setHeader("X-Nexvia-Cache", "hit");
      const rawText = typeof cacheProbe.data === "string" ? cacheProbe.data : String(cacheProbe.data ?? "");
      res.status(cacheProbe.status);
      if (cacheProbe.contentType.includes("json") || rawText.trim().startsWith("{")) {
        try {
          return res.json(JSON.parse(rawText));
        } catch {
          return res.type("application/json").send(rawText);
        }
      }
      if (cacheProbe.contentType.includes("xml")) {
        res.type("application/xml");
      }
      return res.send(cacheProbe.data);
    }

    const { status, data, contentType } = await fetchUpstream(BASE, operation, q);
    if (cacheProbe.cacheKey && !cacheProbe.bypass && status < 400) {
      writeUpstreamQueryCache(cacheProbe.cacheKey, { status, data, contentType });
    }
    res.status(status);
    if (contentType.includes("json")) {
      try {
        return res.json(JSON.parse(data));
      } catch {
        return res.type("application/json").send(data);
      }
    }
    if (contentType.includes("xml")) {
      res.type("application/xml");
    }
    return res.send(data);
  } catch (err) {
    console.error("[bid proxy]", err?.message || err);
    return res.status(502).json({
      error: "upstream_unreachable",
      message:
        "공공데이터 API 호출에 실패했습니다. 네트워크·슬립·키 활성화 여부를 확인하세요.",
    });
  }
});

app.get("/api/v1/openg/:operation", async (req, res) => {
  const { operation } = req.params;
  if (!isAllowedOpengOperation(operation)) {
    return res.status(400).json({
      error: "invalid_operation",
      message:
        "허용되지 않은 오퍼레이션입니다. 낙찰정보서비스 참고문서의 메서드명(getOpengResult...)과 동일한지 확인하세요.",
    });
  }
  if (!SERVICE_KEY) {
    return res.status(503).json({
      error: "missing_service_key",
      message:
        "backend/.env 의 DATA_GO_KR_SERVICE_KEY 가 비어 있습니다. 공공데이터포털 인증키를 설정하세요.",
    });
  }

  try {
    const q = { ...req.query };
    if (!q.type) q.type = "json";
    const { status, data, contentType } = await fetchUpstreamOpeng(OPENG_BASE, operation, q);
    const rawText = typeof data === "string" ? data : String(data ?? "");
    const rawLo = rawText.trim().toLowerCase();
    if (
      status === 404 &&
      isPreparPcDetailOperation(operation) &&
      !rawText.trim()
    ) {
      return res.status(200).json(emptyOpengJson());
    }
    if (status === 403 || rawLo === "forbidden" || rawLo.includes("403 forbidden")) {
      return res.status(502).json({
        error: "openg_forbidden",
        message:
          "공공데이터가 이 요청을 거부했습니다(403 Forbidden). (1) 포털에서 「조달청_나라장터 낙찰정보서비스」를 입찰공고와 별도로 활용신청했는지 (2) 일일 트래픽 한도 (3) 인코딩 키를 쓰는 경우 URL 인코딩·미리보기와 동일한지 확인하세요. 여전히 403이면 backend/.env 에 OPENG_AUTH_QUERY=ServiceKey 또는 both 로 바꿔 재시도해 보세요.",
      });
    }
    if (status === 401) {
      return res.status(502).json({
        error: "openg_unauthorized",
        message:
          "인증키가 거부되었습니다(401). DATA_GO_KR_SERVICE_KEY 가 포털의 일반·인코딩 키 중 어떤 것인지, 값에 공백·따옴표가 섞이지 않았는지, 낙찰정보 활용신청과 연결된 키인지 확인하세요.",
      });
    }
    if (status === 500 && rawText.trim() === "Unexpected errors") {
      return res.status(502).json({
        error: "openg_gateway_error",
        message:
          "공공데이터 게이트웨이가 낙찰·개찰 API를 거절했습니다(Unexpected errors). 「조달청_나라장터 낙찰정보서비스」 활용신청·인증키를 확인하세요. 참고문서(1.1)의 End Point는 …/as/ScsbidInfoService 이며, OPENG_RESULT_BASE_URL 에 인증키를 넣으면 안 됩니다. 구버전 OpengResultInfoService URL 을 쓰면 동작하지 않을 수 있습니다.",
      });
    }
    res.status(status);
    if (contentType.includes("json")) {
      try {
        return res.json(JSON.parse(data));
      } catch {
        return res.type("application/json").send(data);
      }
    }
    if (contentType.includes("xml")) {
      res.type("application/xml");
    }
    return res.send(data);
  } catch (err) {
    console.error("[openg proxy]", err?.message || err);
    return res.status(502).json({
      error: "upstream_unreachable",
      message:
        "공공데이터 API 호출에 실패했습니다. 네트워크·슬립·키·OPENG_RESULT_BASE_URL 을 확인하세요.",
    });
  }
});

app.get("/api/v1/scsbid/:operation", async (req, res) => {
  const { operation } = req.params;
  if (!isAllowedScsbidOperation(operation)) {
    return res.status(400).json({
      error: "invalid_operation",
      message:
        "허용되지 않은 오퍼레이션입니다. 낙찰정보서비스의 getScsbidListSttus... 메서드명과 동일한지 확인하세요.",
    });
  }
  if (!SERVICE_KEY) {
    return res.status(503).json({
      error: "missing_service_key",
      message:
        "backend/.env 의 DATA_GO_KR_SERVICE_KEY 가 비어 있습니다. 공공데이터포털 인증키를 설정하세요.",
    });
  }

  try {
    const q = { ...req.query };
    if (!q.type) q.type = "json";
    const { status, data, contentType } = await fetchUpstreamOpeng(OPENG_BASE, operation, q);
    const rawText = typeof data === "string" ? data : String(data ?? "");
    const rawLo = rawText.trim().toLowerCase();
    if (status === 403 || rawLo === "forbidden" || rawLo.includes("403 forbidden")) {
      return res.status(502).json({
        error: "scsbid_forbidden",
        message:
          "공공데이터가 이 요청을 거부했습니다(403). 낙찰정보서비스 활용신청·일일 한도·인증키를 확인하세요.",
      });
    }
    if (status === 401) {
      return res.status(502).json({
        error: "scsbid_unauthorized",
        message: "인증키가 거부되었습니다(401). DATA_GO_KR_SERVICE_KEY 와 활용신청을 확인하세요.",
      });
    }
    if (status === 500 && rawText.trim() === "Unexpected errors") {
      return res.status(502).json({
        error: "scsbid_gateway_error",
        message:
          "공공데이터 게이트웨이가 낙찰 API를 거절했습니다(Unexpected errors). OPENG_RESULT_BASE_URL·활용신청을 확인하세요.",
      });
    }
    res.status(status);
    if (contentType.includes("json")) {
      try {
        return res.json(JSON.parse(data));
      } catch {
        return res.type("application/json").send(data);
      }
    }
    if (contentType.includes("xml")) {
      res.type("application/xml");
    }
    return res.send(data);
  } catch (err) {
    console.error("[scsbid proxy]", err?.message || err);
    return res.status(502).json({
      error: "upstream_unreachable",
      message: "공공데이터 API 호출에 실패했습니다. 네트워크·슬립·키를 확인하세요.",
    });
  }
});

app.get("/api/v1/bizinfo/support", async (req, res) => {
  if (!BIZINFO_CRTFC_KEY) {
    return res.status(503).json({
      error: "missing_bizinfo_key",
      message:
        "backend/.env 에 BIZINFO_CRTFC_KEY 를 설정하세요. 기업마당(www.bizinfo.go.kr) 정책정보 개방에서 인증키를 발급·등록합니다.",
    });
  }
  try {
    const cacheProbe = readUpstreamQueryCache("bizinfo", "support", req.query);
    if (sendUpstreamCacheHit(res, cacheProbe)) return;

    const { status, data, contentType } = await fetchBizinfoUpstream(BIZINFO_URL, req.query);
    if (cacheProbe.cacheKey && !cacheProbe.bypass && status < 400) {
      writeUpstreamQueryCache(cacheProbe.cacheKey, { status, data, contentType });
    }
    res.status(status);
    const raw = typeof data === "string" ? data : JSON.stringify(data ?? "");
    if (contentType.includes("json") || raw.trim().startsWith("{")) {
      try {
        return res.json(JSON.parse(raw));
      } catch {
        return res.type("application/json").send(raw);
      }
    }
    res.type(contentType || "text/plain");
    return res.send(data);
  } catch (err) {
    console.error("[bizinfo proxy]", err?.message || err);
    return res.status(502).json({
      error: "bizinfo_unreachable",
      message:
        "기업마당 API 호출에 실패했습니다. 네트워크·슬립·인증키·허용 IP(또는 URL) 등록을 확인하세요.",
    });
  }
});

app.get("/api/v1/bizinfo/events", async (req, res) => {
  if (!BIZINFO_CRTFC_KEY) {
    return res.status(503).json({
      error: "missing_bizinfo_key",
      message:
        "backend/.env 에 BIZINFO_CRTFC_KEY 를 설정하세요. 기업마당 정책정보 개방에서 발급한 키로 행사 API도 호출합니다.",
    });
  }
  try {
    const cacheProbe = readUpstreamQueryCache("bizinfo", "events", req.query);
    if (sendUpstreamCacheHit(res, cacheProbe)) return;

    const { status, data, contentType } = await fetchBizinfoUpstream(BIZINFO_EVENT_URL, req.query);
    if (cacheProbe.cacheKey && !cacheProbe.bypass && status < 400) {
      writeUpstreamQueryCache(cacheProbe.cacheKey, { status, data, contentType });
    }
    res.status(status);
    const raw = typeof data === "string" ? data : JSON.stringify(data ?? "");
    if (contentType.includes("json") || raw.trim().startsWith("{")) {
      try {
        return res.json(JSON.parse(raw));
      } catch {
        return res.type("application/json").send(raw);
      }
    }
    res.type(contentType || "text/plain");
    return res.send(data);
  } catch (err) {
    console.error("[bizinfo events]", err?.message || err);
    return res.status(502).json({
      error: "bizinfo_events_unreachable",
      message: "기업마당 행사 API 호출에 실패했습니다. 네트워크·인증키·허용 IP를 확인하세요.",
    });
  }
});

app.get("/api/v1/prespec/:operation", async (req, res) => {
  const { operation } = req.params;
  if (!isAllowedPrespecOperation(operation)) {
    return res.status(400).json({
      error: "invalid_operation",
      message:
        "허용되지 않은 오퍼레이션입니다. 조달청 나라장터 사전규격정보 참고문서의 메서드명(getPublicPrcure...)과 동일한지 확인하세요.",
    });
  }
  if (!SERVICE_KEY) {
    return res.status(503).json({
      error: "missing_service_key",
      message:
        "backend/.env 의 DATA_GO_KR_SERVICE_KEY 가 비어 있습니다. 공공데이터포털에서 「나라장터 사전규격정보」 등 해당 서비스를 활용신청했는지 확인하세요.",
    });
  }
  try {
    const q = { ...req.query };
    if (!q.type) q.type = "json";
    delete q.nxRefresh;
    delete q.nx_refresh;

    const cacheProbe = readUpstreamQueryCache("prespec", operation, req.query);
    if (cacheProbe.hit) {
      res.setHeader("X-Nexvia-Cache", "hit");
      return respondDataGoUpstream(
        res,
        {
          status: cacheProbe.status,
          data: cacheProbe.data,
          contentType: cacheProbe.contentType,
        },
        {
          unexpectedMessage:
            "공공데이터 게이트웨이가 사전규격 API를 거절했습니다(Unexpected errors). data.go.kr 활용신청 상태와 PRESPEC_BASE_URL 을 확인하세요. 현재 사전규격 서비스는 보통 https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService 경로에서 정상 응답합니다. inqryBgnDt/inqryEndDt 는 YYYYMMDDHHmm 입니다.",
          forbiddenMessage:
            "사전규격 API 접근이 거부되었습니다(403). 활용신청·인증키·일일 트래픽을 확인하세요.",
          apiErrorFallback:
            "사전규격 API가 오류를 반환했습니다. 조회 기간·inqryDiv·파라미터를 참고문서와 맞춰 주세요.",
        }
      );
    }

    const upstream = await fetchUpstreamDataGoAuth(PRESPEC_BASE, operation, q, PRESPEC_AUTH_QUERY);
    if (cacheProbe.cacheKey && !cacheProbe.bypass && upstream.status < 400) {
      writeUpstreamQueryCache(cacheProbe.cacheKey, upstream);
    }
    return respondDataGoUpstream(res, upstream, {
      unexpectedMessage:
        "공공데이터 게이트웨이가 사전규격 API를 거절했습니다(Unexpected errors). data.go.kr 활용신청 상태와 PRESPEC_BASE_URL 을 확인하세요. 현재 사전규격 서비스는 보통 https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService 경로에서 정상 응답합니다. inqryBgnDt/inqryEndDt 는 YYYYMMDDHHmm 입니다.",
      forbiddenMessage:
        "사전규격 API 접근이 거부되었습니다(403). 활용신청·인증키·일일 트래픽을 확인하세요.",
      apiErrorFallback: "사전규격 API가 오류를 반환했습니다. 조회 기간·inqryDiv·파라미터를 참고문서와 맞춰 주세요.",
    });
  } catch (err) {
    console.error("[prespec proxy]", err?.message || err);
    return res.status(502).json({
      error: "upstream_unreachable",
      message:
        "사전규격 API 호출에 실패했습니다. PRESPEC_BASE_URL·활용신청·일일 한도·슬립을 확인하세요.",
    });
  }
});

app.get("/api/v1/ordrplan/:operation", async (req, res) => {
  const { operation } = req.params;
  if (!isAllowedOrdrPlanOperation(operation)) {
    return res.status(400).json({
      error: "invalid_operation",
      message:
        "허용되지 않은 오퍼레이션입니다. 조달청 나라장터 발주계획현황 참고문서의 메서드명(getOrdrPlanPcure...)과 동일한지 확인하세요.",
    });
  }
  if (!SERVICE_KEY) {
    return res.status(503).json({
      error: "missing_service_key",
      message:
        "backend/.env 의 DATA_GO_KR_SERVICE_KEY 가 비어 있습니다. 공공데이터포털에서 「나라장터 발주계획현황」 서비스를 활용신청했는지 확인하세요.",
    });
  }
  try {
    const q = { ...req.query };
    if (!q.type) q.type = "json";
    const upstream = await fetchUpstreamDataGoAuth(ORDR_PLAN_BASE, operation, q, ORDR_PLAN_AUTH_QUERY);
    return respondDataGoUpstream(res, upstream, {
      unexpectedMessage:
        "공공데이터 게이트웨이가 발주계획 API를 거절했습니다(Unexpected errors). 발주계획현황 End Point 는 보통 https://apis.data.go.kr/1230000/ao/OrderPlanSttusService 입니다. 활용신청 상태, orderBgnYm/orderEndYm(YYYYMM), inqryBgnDt/inqryEndDt(YYYYMMDDHHmm)를 확인하세요.",
      forbiddenMessage:
        "발주계획 API 접근이 거부되었습니다(403). 활용신청·인증키·일일 트래픽을 확인하세요.",
      apiErrorFallback: "발주계획 API가 오류를 반환했습니다. 조회 기간·inqryDiv·파라미터를 참고문서와 맞춰 주세요.",
    });
  } catch (err) {
    console.error("[ordrplan proxy]", err?.message || err);
    return res.status(502).json({
      error: "upstream_unreachable",
      message:
        "발주계획 API 호출에 실패했습니다. ORDR_PLAN_BASE_URL·활용신청·일일 한도·슬립을 확인하세요.",
    });
  }
});

app.get("/api/v1/feeds/mss", async (req, res) => {
  const board = String(req.query.smba_board ?? "310").trim();
  if (!MSS_RSS_ALLOWED.has(board)) {
    return res.status(400).json({
      error: "invalid_board",
      message: "smba_board 는 310(사업공고) 또는 81(공지사항) 만 허용됩니다.",
    });
  }
  const force = req.query.nxRefresh === "1" || req.query.nx_refresh === "1" || req.query.refresh === "1";
  try {
    const out = await fetchMssRssBoard(board, { force });
    if (!out.ok) {
      if (out.error === "rss_not_rss") {
        return res.status(502).json({
          error: "rss_not_rss",
          message: "RSS 대신 HTML이 반환되었습니다. 기관 사이트 정책·차단일 수 있습니다.",
        });
      }
      return res.status(502).json({
        error: out.error || "rss_upstream_http",
        message: `중소벤처기업부 RSS HTTP ${out.status ?? "?"}. 잠시 후 다시 시도하세요.`,
      });
    }
    return res.json({
      board: out.board,
      cached: Boolean(out.cached),
      channel: out.channel ?? null,
      items: out.items ?? [],
    });
  } catch (err) {
    console.error("[mss rss]", err?.message || err);
    return res.status(502).json({
      error: "rss_unreachable",
      message:
        "RSS 를 불러오지 못했습니다(네트워크 끊김·방화벽·기관 부하 가능). 몇 초 뒤 다시 「불러오기」를 누르거나, 브라우저에서 https://www.mss.go.kr/rss/smba/board/310.do 가 열리는지 확인하세요.",
    });
  }
});

const cacheWarmDeps = {
  serviceKey: SERVICE_KEY,
  fetchBid: (operation, query) => fetchUpstream(BASE, operation, query),
  fetchPrespec: (operation, query) =>
    fetchUpstreamDataGoAuth(PRESPEC_BASE, operation, query, PRESPEC_AUTH_QUERY),
  fetchBizinfoSupport: BIZINFO_CRTFC_KEY
    ? (query) => fetchBizinfoUpstream(BIZINFO_URL, query)
    : undefined,
  fetchBizinfoEvents: BIZINFO_CRTFC_KEY
    ? (query) => fetchBizinfoUpstream(BIZINFO_EVENT_URL, query)
    : undefined,
  warmMssBoard: (board, opts) => fetchMssRssBoard(board, opts),
};

app.use("/api/v1/cache", createCacheWarmRouter(cacheWarmDeps));

export default app;

/** Vercel Serverless 에서는 listen 하지 않음 */
if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`bid proxy listening on http://localhost:${PORT}`);
    startCacheWarmScheduler(cacheWarmDeps);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[오류] 포트 ${PORT} 를 이미 다른 프로그램이 사용 중입니다. (listen EADDRINUSE)\n` +
          `→ 다른 터미널에서 돌아가는 node/nodemon 을 종료하거나, backend/.env 에서 PORT 를 다른 번호(예: 5002)로 바꾼 뒤 다시 실행하세요.`,
      );
    } else {
      console.error("[오류] 서버를 띄우지 못했습니다:", err.message || err);
    }
    process.exit(1);
  });
}
