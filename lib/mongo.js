import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI || "";
let clientPromise = null;

/** Express 서버 — 클라이언트 1회 생성·재사용 (serverless 대비 lazy connect) */
export async function getMongoClient() {
  if (!uri.trim()) {
    throw new Error("MONGODB_URI is not configured");
  }
  if (!clientPromise) {
    const client = new MongoClient(uri, {
      maxPoolSize: 20,
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 10_000,
    });
    clientPromise = client.connect();
  }
  return clientPromise;
}

export async function getDb() {
  const client = await getMongoClient();
  const dbName = process.env.MONGODB_DB || "nexvia";
  return client.db(dbName);
}

export function isMongoConfigured() {
  return Boolean(uri.trim());
}
