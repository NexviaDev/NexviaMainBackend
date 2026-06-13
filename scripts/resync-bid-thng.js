/** bid:Thng 만 빠르게 MongoDB 복구 (node scripts/resync-bid-thng.js) */
import "dotenv/config";
import axios from "axios";
import { buildBidWarmQueries } from "../lib/cacheWarmParams.js";
import { parseUpstreamPayload } from "../lib/upstreamPayloadParse.js";
import { extractBidRows, bidRowKey } from "../lib/tabSyncExtract.js";
import { extractBidListMeta } from "../lib/cacheWarmParse.js";
import { MAX_BID_WARM_PAGES } from "../lib/cacheWarmParams.js";
import { upsertTabSnapshot, getTabSnapshot } from "../lib/tabSyncStore.js";
import { findTabSnapshotTarget } from "../lib/tabSyncKeys.js";

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || "";
const BASE =
  process.env.BID_PUBLIC_INFO_BASE_URL?.replace(/\/$/, "") ||
  "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(operation, query) {
  const params = { ...query, ServiceKey: SERVICE_KEY };
  delete params.serviceKey;
  const res = await axios.get(`${BASE}/${operation}`, {
    params,
    timeout: 60_000,
    validateStatus: () => true,
    responseType: "text",
    transitional: { forcedJSONParsing: false },
  });
  const parsed = parseUpstreamPayload(res.data);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.payload;
}

async function main() {
  const target = findTabSnapshotTarget("bid:Thng");
  const item = buildBidWarmQueries().find((q) => q.label === "bid:Thng");
  if (!target || !item) throw new Error("config missing");

  const pageSize = Number(item.query.numOfRows) || 100;
  const merged = new Map();
  let totalCount = null;

  const q1 = { ...item.query, pageNo: "1" };
  const first = await fetchPage(item.operation, q1);
  const p1 = extractBidRows(first);
  totalCount = p1.totalCount;
  for (const row of p1.rows) merged.set(bidRowKey(row), row);

  const meta = extractBidListMeta(first, pageSize);
  const totalPages = Math.min(meta.totalPages ?? 1, MAX_BID_WARM_PAGES);
  console.log(`p1/${totalPages} +${p1.rows.length} total=${totalCount} merged=${merged.size}`);

  for (let p = 2; p <= totalPages; p++) {
    const data = await fetchPage(item.operation, { ...item.query, pageNo: String(p) });
    const batch = extractBidRows(data).rows;
    for (const row of batch) merged.set(bidRowKey(row), row);
    if (p % 5 === 0 || p === totalPages) {
      console.log(`p${p}/${totalPages} merged=${merged.size}`);
    }
    await sleep(350);
  }

  const rows = [...merged.values()];
  await upsertTabSnapshot("bid:Thng", {
    uiTab: target.uiTab,
    label: target.label,
    source: target.source,
    rows,
    truncated: totalCount != null && rows.length < totalCount,
    totalCount,
    syncError: null,
    meta: { naraBiz: "Thng", operation: item.operation, pages: totalPages },
  });

  const after = await getTabSnapshot("bid:Thng");
  console.log("saved", { rowCount: after?.rowCount, syncedAt: after?.syncedAt });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
