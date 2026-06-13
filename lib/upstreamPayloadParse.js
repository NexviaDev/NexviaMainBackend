/** axios text 응답 → extract/cacheWarm 파싱용 객체 */

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findDataGoHeader(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.response?.header && typeof obj.response.header === "object") {
    return obj.response.header;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && v.header && typeof v.header === "object") {
      return v.header;
    }
  }
  return null;
}

/**
 * @param {unknown} raw — axios responseType:"text" 본문 또는 이미 파싱된 객체
 * @returns {{ payload: object | null, error: string | null }}
 */
export function parseUpstreamPayload(raw) {
  if (raw == null) {
    return { payload: null, error: "empty_upstream_body" };
  }

  let payload = raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { payload: null, error: "empty_upstream_body" };
    }
    if (trimmed === "Unexpected errors") {
      return { payload: null, error: "data_go_gateway_error: Unexpected errors" };
    }
    const lo = trimmed.toLowerCase();
    if (lo === "forbidden" || lo.includes("403 forbidden")) {
      return { payload: null, error: "data_go_forbidden" };
    }
    payload = tryParseJson(trimmed);
    if (payload == null) {
      return {
        payload: null,
        error: `upstream_not_json: ${trimmed.slice(0, 160)}`,
      };
    }
  } else if (typeof raw !== "object") {
    return { payload: null, error: "invalid_upstream_body" };
  }

  const header = findDataGoHeader(payload);
  if (header) {
    const code = String(header.resultCode ?? header.resultcode ?? "00");
    if (code !== "00") {
      const msg = String(header.resultMsg ?? header.resultmsg ?? "").trim();
      return {
        payload,
        error: msg ? `data_go_api_error:${code}:${msg}` : `data_go_api_error:${code}`,
      };
    }
  }

  if (payload.reqErr) {
    return { payload, error: `bizinfo_req_err:${String(payload.reqErr)}` };
  }

  return { payload, error: null };
}
