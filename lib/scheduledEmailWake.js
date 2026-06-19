/** Railway 슬립모드 대비 — 예약·반복 메일 발송 전 health ping */

export async function wakeBackendIfConfigured() {
  const base = String(
    process.env.TAB_SYNC_WAKE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || ""
  )
    .trim()
    .replace(/\/$/, "");
  if (!base) return;
  const url = base.startsWith("http") ? `${base}/health` : `https://${base}/health`;
  try {
    await fetch(url, { signal: AbortSignal.timeout(12_000) });
  } catch {
    /* ignore */
  }
}
