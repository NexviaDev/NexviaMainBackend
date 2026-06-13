import { getDb, isMongoConfigured } from "./mongo.js";

export const TAB_SNAPSHOTS_COLLECTION = "bid_tab_snapshots";

let indexesReady = false;

export async function ensureTabSnapshotIndexes() {
  if (!isMongoConfigured() || indexesReady) return;
  const db = await getDb();
  await db.collection(TAB_SNAPSHOTS_COLLECTION).createIndex({ tabKey: 1 }, { unique: true });
  await db.collection(TAB_SNAPSHOTS_COLLECTION).createIndex({ syncedAt: -1 });
  indexesReady = true;
}

/**
 * @param {string} tabKey
 * @param {object} payload
 */
export async function upsertTabSnapshot(tabKey, payload) {
  if (!isMongoConfigured()) {
    throw new Error("MONGODB_URI is not configured");
  }
  await ensureTabSnapshotIndexes();
  const db = await getDb();
  const now = new Date();
  const doc = {
    tabKey,
    uiTab: payload.uiTab ?? null,
    label: payload.label ?? tabKey,
    source: payload.source ?? "unknown",
    rows: payload.rows ?? [],
    rowCount: Array.isArray(payload.rows) ? payload.rows.length : 0,
    truncated: Boolean(payload.truncated),
    totalCount: payload.totalCount ?? null,
    syncedAt: now,
    syncError: payload.syncError ?? null,
    meta: payload.meta ?? {},
  };
  await db.collection(TAB_SNAPSHOTS_COLLECTION).updateOne(
    { tabKey },
    { $set: doc },
    { upsert: true }
  );
  return { tabKey, syncedAt: now.toISOString(), rowCount: doc.rowCount };
}

/** 동기화 실패 시 기존 rows 는 유지하고 syncError 만 갱신 */
export async function markTabSnapshotSyncError(tabKey, syncError, extras = {}) {
  if (!isMongoConfigured()) {
    throw new Error("MONGODB_URI is not configured");
  }
  await ensureTabSnapshotIndexes();
  const db = await getDb();
  const now = new Date();
  const patch = {
    syncError: syncError ?? "sync_failed",
    syncedAt: now,
  };
  if (extras.label != null) patch.label = extras.label;
  if (extras.uiTab != null) patch.uiTab = extras.uiTab;
  if (extras.source != null) patch.source = extras.source;
  if (extras.meta != null) patch.meta = extras.meta;

  const updated = await db.collection(TAB_SNAPSHOTS_COLLECTION).updateOne({ tabKey }, { $set: patch });
  if (updated.matchedCount === 0) {
    await upsertTabSnapshot(tabKey, {
      uiTab: extras.uiTab ?? null,
      label: extras.label ?? tabKey,
      source: extras.source ?? "unknown",
      rows: [],
      syncError: patch.syncError,
      meta: extras.meta ?? {},
    });
  }
  return { tabKey, syncedAt: now.toISOString(), syncError: patch.syncError };
}

export async function getTabSnapshot(tabKey) {
  if (!isMongoConfigured()) return null;
  await ensureTabSnapshotIndexes();
  const db = await getDb();
  const row = await db.collection(TAB_SNAPSHOTS_COLLECTION).findOne(
    { tabKey },
    { projection: { _id: 0 } }
  );
  if (!row) return null;
  return {
    ...row,
    syncedAt: row.syncedAt instanceof Date ? row.syncedAt.toISOString() : row.syncedAt,
  };
}

export async function listTabSnapshots() {
  if (!isMongoConfigured()) return [];
  await ensureTabSnapshotIndexes();
  const db = await getDb();
  const rows = await db
    .collection(TAB_SNAPSHOTS_COLLECTION)
    .find({}, {
      projection: {
        _id: 0,
        tabKey: 1,
        uiTab: 1,
        label: 1,
        source: 1,
        rowCount: 1,
        truncated: 1,
        totalCount: 1,
        syncedAt: 1,
        syncError: 1,
      },
    })
    .sort({ tabKey: 1 })
    .toArray();
  return rows.map((row) => ({
    ...row,
    syncedAt: row.syncedAt instanceof Date ? row.syncedAt.toISOString() : row.syncedAt,
  }));
}
