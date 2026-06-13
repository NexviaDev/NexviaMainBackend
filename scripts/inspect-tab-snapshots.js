/** MongoDB bid_tab_snapshots 상태·문서 크기 확인 */
import "dotenv/config";
import { getDb } from "../lib/mongo.js";
import { TAB_SNAPSHOTS_COLLECTION } from "../lib/tabSyncStore.js";

const dbName = process.env.MONGODB_DB || "nexvia";

async function main() {
  const db = await getDb();
  console.log("database:", dbName, "collection:", TAB_SNAPSHOTS_COLLECTION);

  const docs = await db
    .collection(TAB_SNAPSHOTS_COLLECTION)
    .find({})
    .project({ tabKey: 1, rowCount: 1, syncError: 1, syncedAt: 1 })
    .sort({ tabKey: 1 })
    .toArray();

  if (!docs.length) {
    console.log("no documents");
    return;
  }

  for (const meta of docs) {
    const full = await db.collection(TAB_SNAPSHOTS_COLLECTION).findOne({ tabKey: meta.tabKey });
    const rowsLen = Array.isArray(full?.rows) ? full.rows.length : -1;
    const approxBytes = Buffer.byteLength(JSON.stringify(full ?? {}), "utf8");
    const mb = (approxBytes / (1024 * 1024)).toFixed(2);
    console.log(
      [
        meta.tabKey,
        `rowCount=${meta.rowCount}`,
        `rows.len=${rowsLen}`,
        `~${mb}MB`,
        `syncError=${meta.syncError ?? "null"}`,
        `syncedAt=${meta.syncedAt?.toISOString?.() ?? meta.syncedAt}`,
      ].join(" | ")
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
