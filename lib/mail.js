import nodemailer from "nodemailer";

let transporterPromise = null;

function isEmailConfigured() {
  return Boolean(process.env.EMAIL_USER?.trim() && process.env.EMAIL_PASS?.trim());
}

function getTransporter() {
  if (!isEmailConfigured()) {
    throw new Error("EMAIL_USER / EMAIL_PASS not configured");
  }
  if (!transporterPromise) {
    transporterPromise = Promise.resolve(
      nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER.trim(),
          pass: process.env.EMAIL_PASS.trim(),
        },
      })
    );
  }
  return transporterPromise;
}

function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return "등록 이메일";
  const head = local.length <= 2 ? local[0] || "*" : `${local.slice(0, 2)}***`;
  return `${head}@${domain}`;
}

function buildOtpHtml({ title, code, minutes }) {
  return `<!DOCTYPE html>
<html lang="ko">
<body style="margin:0;padding:24px;background:#eef1f6;font-family:Inter,Segoe UI,sans-serif;color:#2c3437;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #dce4ef;border-radius:16px;">
    <tr><td style="padding:28px 24px 8px;text-align:center;">
      <p style="margin:0;font-size:18px;font-weight:700;color:#2a2438;">Nexvia</p>
      <p style="margin:8px 0 0;font-size:14px;color:#6b7280;">${title}</p>
    </td></tr>
    <tr><td style="padding:16px 24px;text-align:center;">
      <p style="margin:0;font-size:32px;font-weight:700;letter-spacing:0.25em;color:#4a8fc9;">${code}</p>
      <p style="margin:12px 0 0;font-size:13px;color:#6b7280;">${minutes}분 이내에 입력해 주세요.</p>
    </td></tr>
    <tr><td style="padding:8px 24px 24px;font-size:12px;line-height:1.6;color:#9ca3af;text-align:center;">
      본인이 요청하지 않았다면 이 메일을 무시하세요.
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * @param {{ to: string, code: string, purpose: 'login' | 'register' }} opts
 */
export async function sendOtpEmail({ to, code, purpose }) {
  const title = purpose === "register" ? "회원가입 이메일 인증번호" : "로그인 인증번호";
  const minutes = 5;
  const subject = `[Nexvia] ${title}: ${code}`;
  const html = buildOtpHtml({ title, code, minutes });
  const text = `[Nexvia] ${title}\n\n인증번호: ${code}\n\n${minutes}분 이내에 입력해 주세요.`;

  const transporter = await getTransporter();
  await transporter.sendMail({
    from: `"Nexvia" <${process.env.EMAIL_USER.trim()}>`,
    to,
    subject,
    text,
    html,
  });

  return { masked: maskEmail(to) };
}

export { isEmailConfigured, maskEmail, getTransporter };
