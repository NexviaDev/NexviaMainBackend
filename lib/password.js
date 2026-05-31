import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;
const MAX_PASSWORD_LEN = 128;

/** 대문자·소문자·숫자·특수문자 포함, 6자 이상 */
export function validatePassword(raw) {
  const password = String(raw ?? "");
  if (!password) return "비밀번호를 입력해 주세요.";
  if (password.length > MAX_PASSWORD_LEN) return "비밀번호가 너무 깁니다.";
  if (password.length < 6) return "비밀번호는 6자 이상이어야 합니다.";
  if (!/[A-Z]/.test(password)) return "비밀번호에 대문자를 포함해 주세요.";
  if (!/[a-z]/.test(password)) return "비밀번호에 소문자를 포함해 주세요.";
  if (!/[0-9]/.test(password)) return "비밀번호에 숫자를 포함해 주세요.";
  if (!/[^A-Za-z0-9]/.test(password)) return "비밀번호에 특수문자를 포함해 주세요.";
  return null;
}

export async function hashPassword(raw) {
  const password = String(raw ?? "");
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(raw, passwordHash) {
  if (!passwordHash) return false;
  return bcrypt.compare(String(raw ?? ""), passwordHash);
}
