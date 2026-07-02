/**
 * 로컬·내부 실행용 — 5분마다 1회 예약 + 매일 반복 메일 처리
 * cron-job.org 대신 localhost backend(npm start)만 켜 두면 동작
 *
 * SCHEDULED_EMAIL_INTERNAL=0 이면 비활성 (Railway + cron-job 운영 시)
 */

import { runDueScheduledEmails } from "./scheduledEmailRun.js";
import { runDueRecurringEmails } from "./recurringEmailRun.js";

const TICK_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 30_000;

export function startScheduledEmailScheduler() {
  const enabled = String(process.env.SCHEDULED_EMAIL_INTERNAL ?? "1").trim() !== "0";
  if (!enabled) {
    console.log(
      "[scheduled-email] internal scheduler disabled (SCHEDULED_EMAIL_INTERNAL=0 — use cron-job /run)"
    );
    return () => {};
  }

  let interval = null;
  let running = false;

  const tick = async (label) => {
    if (running) {
      console.log("[scheduled-email] tick skipped — previous run still active");
      return;
    }
    running = true;
    const started = Date.now();
    try {
      const oneShot = await runDueScheduledEmails();
      const recurring = await runDueRecurringEmails();
      const sec = Math.round((Date.now() - started) / 1000);
      const sent =
        (oneShot.processed ?? 0) + (recurring.processed ?? 0);
      if (sent > 0 || oneShot.error || recurring.error) {
        console.log(
          `[scheduled-email] ${label} ${sec}s · oneShot=${oneShot.processed ?? 0} recurring=${recurring.processed ?? 0}`
        );
      }
    } catch (e) {
      console.error("[scheduled-email] tick failed:", e?.message || e);
    } finally {
      running = false;
    }
  };

  console.log(
    `[scheduled-email] internal scheduler ON — first in ${FIRST_TICK_MS / 1000}s, then every ${TICK_MS / 60000} min`
  );
  const firstTimer = setTimeout(() => void tick("first"), FIRST_TICK_MS);
  interval = setInterval(() => void tick("interval"), TICK_MS);

  return () => {
    clearTimeout(firstTimer);
    if (interval) clearInterval(interval);
  };
}
