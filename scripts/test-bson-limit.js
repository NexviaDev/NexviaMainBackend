/** upsert BSON 크기 한도 테스트 */
import "dotenv/config";
import axios from "axios";
import { buildBidWarmQueries } from "../lib/cacheWarmParams.js";
import { parseUpstreamPayload } from "../lib/upstreamPayloadParse.js";
import { extractBidRows } from "../lib/tabSyncExtract.js";
import { upsertTabSnapshot, getTabSnapshot } from "../lib/tabSyncStore.js";

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || "";
const BASE =
  process.env.BID_PUBLIC_INFO_BASE_URL?.replace(/\/$/, "") ||
  "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";

async function fetchRows(operation, query, pages = 3) {
  const merged = [];
  for (let p = 1; p <= pages; p++) {
    const params = { ...query, pageNo: String(p), ServiceKey: SERVICE_KEY };
    delete params.serviceKey;
    const res = await axios.get(`${BASE}/${operation}`, {
      params,
      timeout: 60_000,
      responseType: "text",
      transitional: { forcedJSONParsing: false },
    });
    const parsed = parseUpstreamPayload(res.data);
    if (parsed.error) throw new Error(parsed.error);
    merged.push(...extractBidRows(parsed.payload).rows);
  }
  return merged;
}

async function trySave(label, rows) {
  const bytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
  console.log(`\n${label}: rows=${rows.length} json~${(bytes / 1024 / 1024).toFixed(2)}MB`);
  try {
    await upsertTabSnapshot(`test:${label}`, {
      uiTab: "T",
      label: "test",
      source: "test",
      rows,
      syncError: null,
      meta: { test: true },
    });
    const after = await getTabSnapshot(`test:${label}`);
    console.log("  saved ok rowCount=", after?.rowCount, "rows.len=", after?.rows?.length);
  } catch (e) {
    console.log("  SAVE FAILED:", e.message?.slice(0, 200));
  }
}

async function main() {
  const thng = buildBidWarmQueries().find((q) => q.label === "bid:Thng");
  const rows3 = await fetchRows(thng.operation, thng.query, 3);
  await trySave("100p", rows3.slice(0, 100));
  await trySave("500p", rows3.concat(rows3, rows3, rows3, rows3).slice(0, 500));
  await trySave("1500p", rows3.concat(rows3, rows3, rows3, rows3, rows3).slice(0, 1500));
  await trySave("3000p", rows3.concat(rows3, rows3, rows3, rows3, rows3, rows3, rows3, rows3, rows3, rows3).slice(0, 3000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
