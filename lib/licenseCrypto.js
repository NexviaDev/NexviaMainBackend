/**
 * NEXCAD license crypto — must match license-server/server.py + CAD LicenseHmac.
 * HMAC secret is derived from XOR-obfuscated constants (same as Python stub).
 */
import crypto from "node:crypto";

const _XOR = Buffer.from([
  0x5a, 0xc3, 0x91, 0x2e, 0x77, 0x0b, 0xd4, 0x68, 0x1f, 0xa9, 0x43, 0xe0, 0xb6, 0x15, 0x8c,
  0xf2, 0x3d, 0x70, 0x99, 0x04, 0xce, 0x52, 0xab, 0x36, 0xe8, 0x11, 0x6f, 0xd0, 0x27, 0x94,
  0x5b, 0xc1,
]);
const _ENC = Buffer.from([
  0x14, 0xad, 0xf8, 0x47, 0x19, 0x65, 0xb0, 0x0e, 0x71, 0xc8, 0x2a, 0x8f, 0xd9, 0x70, 0xe5,
  0x9b, 0x52, 0x1f, 0xf0, 0x6b, 0xa7, 0x39, 0xc4, 0x59, 0x87, 0x7e, 0x0a, 0xbf, 0x48, 0xf5,
  0x2c, 0xae,
]);

/** @returns {Buffer} */
export function hmacSecret() {
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    out[i] = _ENC[i] ^ _XOR[i] ^ ((0xa5 + i) & 0xff);
  }
  return out;
}

export const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const EPOCH = new Date(Date.UTC(2026, 0, 1));
export const BODY_LEN = 24;
export const PAYLOAD_LEN = 15;
export const CLAIMS_LEN = 9;
export const MAC_LEN = 6;
export const OFFLINE_LEASE_DAYS = 30;

/** @param {string} code */
export function normalizeBody(code) {
  const out = [];
  for (const ch of String(code).toUpperCase()) {
    if (ch === "-" || ch === " " || ch === "\t") continue;
    if (!ALPHABET.includes(ch)) return null;
    out.push(ch);
  }
  if (out.length !== BODY_LEN) return null;
  return out.join("");
}

/** @param {string} body */
export function formatDisplay(body) {
  const parts = [];
  for (let i = 0; i < BODY_LEN; i += 4) parts.push(body.slice(i, i + 4));
  return parts.join("-");
}

/** @param {Buffer} raw @param {number} width */
function b36Encode(raw, width) {
  let n = BigInt("0x" + raw.toString("hex"));
  const digits = [];
  for (let i = 0; i < width; i++) {
    const r = Number(n % 36n);
    n = n / 36n;
    digits.push(ALPHABET[r]);
  }
  if (n !== 0n) throw new Error("overflow");
  return digits.reverse().join("");
}

/** @param {string} body @param {number} outLen */
function b36Decode(body, outLen) {
  let n = 0n;
  for (const ch of body) {
    n = n * 36n + BigInt(ALPHABET.indexOf(ch));
  }
  const hex = n.toString(16).padStart(outLen * 2, "0");
  return Buffer.from(hex, "hex");
}

/** @param {Buffer} claims9 */
export function mac6(claims9) {
  return crypto.createHmac("sha256", hmacSecret()).update(claims9).digest().subarray(0, MAC_LEN);
}

function utcDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysBetweenEpoch(expires) {
  const exp = utcDateOnly(expires);
  const epoch = utcDateOnly(EPOCH);
  return Math.round((exp.getTime() - epoch.getTime()) / 86_400_000);
}

/**
 * @param {"perpetual"|"term"} kind
 * @param {Date|null} expires
 */
export function issueFloating(kind, expires) {
  const typeBits = kind === "perpetual" ? 1 : 0;
  let dayIndex;
  if (kind === "perpetual") {
    dayIndex = 0xffff;
  } else {
    if (!expires) throw new Error("term requires expires");
    dayIndex = daysBetweenEpoch(expires);
    if (dayIndex < 0 || dayIndex > 65534) throw new Error("expires out of range");
  }
  const claims = Buffer.alloc(CLAIMS_LEN);
  claims[0] = (1 << 4) | (typeBits & 0x03);
  claims[1] = (dayIndex >> 8) & 0xff;
  claims[2] = dayIndex & 0xff;
  const raw = Buffer.concat([claims, mac6(claims)]);
  return formatDisplay(b36Encode(raw, BODY_LEN));
}

/** @param {string} code */
export function parseCode(code) {
  const body = normalizeBody(code);
  if (!body) throw new Error("invalid code format");
  const raw = b36Decode(body, PAYLOAD_LEN);
  const claims9 = raw.subarray(0, CLAIMS_LEN);
  const mac = raw.subarray(CLAIMS_LEN);
  if (!mac6(claims9).equals(mac)) throw new Error("invalid signature");
  const ver = claims9[0] >> 4;
  if (ver !== 1) throw new Error("unsupported version");
  const typeBits = claims9[0] & 0x03;
  const dayIndex = (claims9[1] << 8) | claims9[2];
  const machinePrefix = claims9.subarray(3, 9);
  const floating = machinePrefix.equals(Buffer.alloc(6));
  let kind;
  let expires = null;
  if (typeBits === 1 || dayIndex === 0xffff) {
    kind = "perpetual";
  } else {
    kind = "term";
    const exp = new Date(EPOCH.getTime() + dayIndex * 86_400_000);
    expires = exp.toISOString().slice(0, 10);
  }
  return {
    body,
    display: formatDisplay(body),
    kind,
    expires,
    floating,
  };
}

/** @param {Record<string, unknown>} payload */
export function makeEntitlementToken(payload) {
  // Match Python: json.dumps(..., separators=(",", ":"), sort_keys=True)
  const sorted = JSON.stringify(payload, Object.keys(payload).sort());
  const rawBuf = Buffer.from(sorted, "utf8");
  const sig = crypto.createHmac("sha256", hmacSecret()).update(rawBuf).digest();
  return `${base64Url(rawBuf)}.${base64Url(sig)}`;
}

/** @param {Buffer} buf */
function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function utcNowIso() {
  return new Date().toISOString();
}

export function leaseUntilIso() {
  return new Date(Date.now() + OFFLINE_LEASE_DAYS * 86_400_000).toISOString();
}

/** @param {unknown} raw */
export function normalizeMachineId(raw) {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "");
}

/** YYYY-MM-DD today (local calendar, matching Python date.today()) */
export function todayLocalIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
