/** one-off: bid:Thng 만 MongoDB 동기화 (node scripts/run-tab-sync-thng.js) */
import "dotenv/config";
import axios from "axios";
import { runTabSync } from "../lib/tabSyncRun.js";
import { getTabSnapshot } from "../lib/tabSyncStore.js";

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || "";
const BASE =
  process.env.BID_PUBLIC_INFO_BASE_URL?.replace(/\/$/, "") ||
  "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";

const DATA_GO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};

async function fetchBid(operation, query) {
  const params = { ...query };
  delete params.serviceKey;
  delete params.ServiceKey;
  params.ServiceKey = SERVICE_KEY;
  const res = await axios.get(`${BASE}/${operation}`, {
    params,
    timeout: 60_000,
    validateStatus: () => true,
    responseType: "text",
    transitional: { forcedJSONParsing: false },
    headers: DATA_GO_HEADERS,
  });
  return { status: res.status, data: res.data, contentType: res.headers["content-type"] || "" };
}

async function main() {
  if (!SERVICE_KEY) {
    console.error("DATA_GO_KR_SERVICE_KEY missing");
    process.exit(1);
  }

  const before = await getTabSnapshot("bid:Thng");
  console.log("before", { rowCount: before?.rowCount, syncError: before?.syncError });

  const out = await runTabSync(
    { serviceKey: SERVICE_KEY, fetchBid, fetchPrespec: async () => ({ status: 500, data: "" }) },
    { force: true, syncSlot: "script-thng" }
  );

  const thng = out.results.find((r) => r.tabKey === "bid:Thng");
  const after = await getTabSnapshot("bid:Thng");
  console.log("result", thng);
  console.log("after", { rowCount: after?.rowCount, syncError: after?.syncError, syncedAt: after?.syncedAt });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
