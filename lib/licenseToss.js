/**
 * 토스페이먼츠 단건 결제 — 승인(confirm)만 서버에서 한다.
 *
 * 키 규약은 Nexvia_CRM(구독 결제)과 같다: `TOSS_SECRET_KEY` / `TOSS_CLIENT_KEY`.
 * 시크릿 키는 **절대** 클라이언트로 내려보내지 않는다.
 */
const CONFIRM_URL = "https://api.tosspayments.com/v1/payments/confirm";

export function tossClientKey() {
  return String(process.env.TOSS_CLIENT_KEY || "").trim();
}

function tossSecretKey() {
  return String(process.env.TOSS_SECRET_KEY || "").trim();
}

export function isTossConfigured() {
  return Boolean(tossSecretKey() && tossClientKey());
}

function authHeader() {
  const secret = tossSecretKey();
  if (!secret) {
    const err = new Error("TOSS_SECRET_KEY 미설정");
    err.code = "toss_unconfigured";
    throw err;
  }
  // 토스 규약: Basic base64("<시크릿키>:")  — 중첩 템플릿을 피해 단순하게 만든다.
  const token = Buffer.from(secret + ":", "utf8").toString("base64");
  return "Basic " + token;
}

/**
 * 결제 승인. 금액은 **주문에 저장해 둔 값**을 넘긴다 — 화면에서 온 금액을 그대로
 * 넘기면 금액 바꿔치기를 막을 수 없다.
 * @param {{ paymentKey: string, orderId: string, amount: number }} p
 */
export async function tossConfirmPayment({ paymentKey, orderId, amount }) {
  const res = await fetch(CONFIRM_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      // 같은 주문으로 두 번 호출돼도 토스가 중복 승인하지 않게 한다.
      "Idempotency-Key": "nexgeom-" + String(orderId),
    },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || data?.code || "토스 승인 실패");
    err.status = res.status;
    err.toss = data;
    throw err;
  }
  return data;
}
