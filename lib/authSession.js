import jwt from "jsonwebtoken";
import { getDb, isMongoConfigured } from "./mongo.js";

export function readBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

export function normalizeUserId(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

export async function resolveAuthUser(req) {
  if (!isMongoConfigured()) {
    return { error: "mongo_unconfigured", status: 503, message: "회원 DB가 설정되지 않았습니다." };
  }

  const token = readBearerToken(req);
  if (!token) {
    return { error: "unauthorized", status: 401, message: "로그인이 필요합니다." };
  }

  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    return { error: "auth_misconfigured", status: 503, message: "AUTH_JWT_SECRET 이 설정되지 않았습니다." };
  }

  try {
    const payload = jwt.verify(token, secret);
    const userId = normalizeUserId(payload.sub);
    const db = await getDb();
    const user = await db.collection("users").findOne({ userId, status: "active" });
    if (!user) {
      return { error: "user_not_found", status: 401, message: "계정을 찾을 수 없습니다." };
    }
    return { user, db };
  } catch (e) {
    if (e?.name === "TokenExpiredError") {
      return { error: "token_expired", status: 401, message: "로그인 유효기간이 만료되었습니다." };
    }
    return { error: "invalid_token", status: 401, message: "로그인 정보가 유효하지 않습니다." };
  }
}
