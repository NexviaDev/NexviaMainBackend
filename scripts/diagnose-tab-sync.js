/** one-off: tab-sync upstream 진단 (node scripts/diagnose-tab-sync.js) */
import "dotenv/config";
import axios from "axios";
import { buildBidWarmQueries, buildPrespecWarmQuery } from "../lib/cacheWarmParams.js";
import { parseUpstreamPayload } from "../lib/upstreamPayloadParse.js";
import { extractBidRows, extractSupplementaryRows } from "../lib/tabSyncExtract.js";

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || "";
const BID_BASE =
  process.env.BID_PUBLIC_INFO_BASE_URL?.replace(/\/$/, "") ||
  "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
const PRESPEC_BASE =
  process.env.PRESPEC_BASE_URL?.replace(/\/$/, "") ||
  "https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService";
const PRESPEC_AUTH = String(process.env.PRESPEC_AUTH_QUERY || "ServiceKey").trim();

async function fetchText(baseUrl, operation, query, auth = "ServiceKey") {
  const params = { ...query };
  delete params.serviceKey;
  delete params.ServiceKey;
  if (/^serviceKey$/i.test(auth)) params.serviceKey = SERVICE_KEY;
  else params.ServiceKey = SERVICE_KEY;

  const url = `${baseUrl}/${operation}`;
  const res = await axios.get(url, {
    params,
    timeout: 60_000,
    validateStatus: () => true,
    responseType: "text",
    transitional: { forcedJSONParsing: false },
  });
  return { status: res.status, data: res.data, ct: res.headers["content-type"] || "" };
}

function summarize(label, raw, status) {
  const { payload, error } = parseUpstreamPayload(raw);
  const bid = payload ? extractBidRows(payload) : { rows: [], totalCount: null };
  const sup = payload ? extractSupplementaryRows(payload) : { rows: [], totalCount: null };
  const header = payload?.response?.header;
  console.log(`\n=== ${label} ===`);
  console.log("http", status);
  console.log("parseError", error);
  console.log("resultCode", header?.resultCode, header?.resultMsg);
  console.log("bidRows", bid.rows.length, "totalCount", bid.totalCount);
  console.log("supRows", sup.rows.length, "totalCount", sup.totalCount);
  if (!payload && typeof raw === "string") {
    console.log("rawPreview", raw.slice(0, 200));
  }
}

async function main() {
  if (!SERVICE_KEY) {
    console.error("DATA_GO_KR_SERVICE_KEY missing");
    process.exit(1);
  }

  const thng = buildBidWarmQueries().find((q) => q.label === "bid:Thng");
  for (const numOfRows of ["50", "100", "999"]) {
    const q1 = { ...thng.query, pageNo: "1", numOfRows };
    const bidOut = await fetchText(BID_BASE, thng.operation, q1, "ServiceKey");
    summarize(`bid:Thng numOfRows=${numOfRows}`, bidOut.data, bidOut.status);
  }

  const prespec = buildPrespecWarmQuery();
  const pq1 = { ...prespec.query, pageNo: "1" };
  const preOut = await fetchText(PRESPEC_BASE, prespec.operation, pq1, PRESPEC_AUTH);
  summarize("prespec", preOut.data, preOut.status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
