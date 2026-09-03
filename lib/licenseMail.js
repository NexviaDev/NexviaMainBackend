/**
 * 라이선스 발급 · 발주서 접수 메일.
 *
 * 메일 설정(EMAIL_USER/EMAIL_PASS)이 없으면 조용히 건너뛴다 — 결제·발급 자체가
 * 메일 때문에 실패하면 안 된다(코드는 주문 조회로도 받을 수 있다).
 */
import nodemailer from "nodemailer";

const SALES_TO = String(process.env.NEXGEOM_SALES_EMAIL || process.env.EMAIL_USER || "").trim();

function configured() {
  return Boolean(process.env.EMAIL_USER?.trim() && process.env.EMAIL_PASS?.trim());
}

let cached = null;
function transporter() {
  if (!cached) {
    cached = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER.trim(), pass: process.env.EMAIL_PASS.trim() },
    });
  }
  return cached;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );
}

function won(n) {
  return `${Number(n || 0).toLocaleString("ko-KR")}원`;
}

/** 구매자에게 라이선스 코드 전달. */
export async function sendLicenseCodesEmail({ order, codes }) {
  if (!configured() || !order?.buyer?.email) return false;
  const rows = codes
    .map((c) => `<tr><td style="padding:6px 10px;border:1px solid #dfe5ec;font-family:Consolas,monospace">${esc(c)}</td></tr>`)
    .join("");
  const html = `<!DOCTYPE html><html lang="ko"><body style="margin:0;padding:24px;background:#eef1f6;font-family:Segoe UI,Malgun Gothic,sans-serif;color:#1b2430">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dce4ef;border-radius:12px">
    <tr><td style="padding:24px 24px 8px">
      <p style="margin:0;font-size:18px;font-weight:700">NEXGEOM 라이선스</p>
      <p style="margin:6px 0 0;font-size:13px;color:#5b6675">주문번호 ${esc(order.orderId)}</p>
    </td></tr>
    <tr><td style="padding:8px 24px 0;font-size:14px;line-height:1.7">
      <p style="margin:0">${esc(order.buyer.company)} ${esc(order.buyer.name)}님, 결제가 확인되었습니다.</p>
      <p style="margin:10px 0 0">모듈 <b>${esc(order.tierLabel)}</b> · ${order.kind === "term" ? `기간제 ${order.months}개월` : "영구"} · 수량 ${order.qty}</p>
      ${order.amount ? `<p style="margin:4px 0 0;color:#5b6675">공급가 ${won(order.amount.supply)} + 부가세 ${won(order.amount.vat)} = <b>${won(order.amount.total)}</b></p>` : ""}
    </td></tr>
    <tr><td style="padding:16px 24px">
      <table role="presentation" style="border-collapse:collapse">${rows}</table>
    </td></tr>
    <tr><td style="padding:0 24px 24px;font-size:13px;line-height:1.7;color:#5b6675">
      NEXGEOM 을 실행하고 <b>도구 → 라이선스</b> 에서 코드를 등록하세요.<br>
      PC 를 바꿀 때는 먼저 「이 PC에서 반납」 을 해주세요. PC 고장으로 반납할 수 없으면
      프로그램에서 <b>강제리턴</b> 을 신청하시면 됩니다.
    </td></tr>
  </table></body></html>`;
  await transporter().sendMail({
    from: process.env.EMAIL_USER,
    to: order.buyer.email,
    subject: `[NEXGEOM] 라이선스 코드 ${codes.length}건 (${order.orderId})`,
    html,
  });
  return true;
}

/** 영업 담당에게 발주서 접수 알림 + 첨부 전달. */
export async function sendPurchaseOrderNotice({ order, file }) {
  if (!configured() || !SALES_TO) return false;
  const b = order.buyer || {};
  const html = `<!DOCTYPE html><html lang="ko"><body style="font-family:Segoe UI,Malgun Gothic,sans-serif;color:#1b2430">
  <h2 style="margin:0 0 12px;font-size:17px">발주서 접수 — ${esc(order.orderId)}</h2>
  <table style="border-collapse:collapse;font-size:14px">
    <tr><td style="padding:4px 10px;color:#5b6675">업체</td><td style="padding:4px 10px">${esc(b.company)} (${esc(b.bizNo || "-")})</td></tr>
    <tr><td style="padding:4px 10px;color:#5b6675">담당</td><td style="padding:4px 10px">${esc(b.name)} · ${esc(b.phone)} · ${esc(b.email)}</td></tr>
    <tr><td style="padding:4px 10px;color:#5b6675">상품</td><td style="padding:4px 10px">${esc(order.tierLabel)} · ${order.kind === "term" ? `기간제 ${order.months}개월` : "영구"} · ${order.qty}석</td></tr>
    <tr><td style="padding:4px 10px;color:#5b6675">금액</td><td style="padding:4px 10px">${order.amount ? won(order.amount.total) : "가격 문의"}</td></tr>
    <tr><td style="padding:4px 10px;color:#5b6675">요청</td><td style="padding:4px 10px">${esc(b.memo || "-")}</td></tr>
  </table>
  <p style="margin:14px 0 0;font-size:13px;color:#5b6675">관리자 화면에서 승인하면 코드가 발급되고 구매자에게 메일이 나갑니다.</p>
  </body></html>`;
  await transporter().sendMail({
    from: process.env.EMAIL_USER,
    to: SALES_TO,
    subject: `[NEXGEOM] 발주서 접수 ${esc(b.company)} (${order.orderId})`,
    html,
    attachments: file
      ? [{ filename: file.originalname, content: file.buffer, contentType: file.mimetype }]
      : [],
  });
  return true;
}
