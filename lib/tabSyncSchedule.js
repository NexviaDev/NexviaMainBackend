/** MongoDB 탭 동기화 — 매시 :15·:45 (30분 간격). cron-job.org 와 동일 */

export const TAB_SYNC_SCHEDULE_MINUTES = [15, 45];

/**
 * @param {Date} [now]
 * @param {number[]} [minutes]
 * @returns {number} ms until next slot (strictly after now)
 */
export function msUntilNextWarmSlot(now = new Date(), minutes = TAB_SYNC_SCHEDULE_MINUTES) {
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const h = now.getHours();
  const t = now.getTime();

  const candidates = [];
  for (let hourOffset = 0; hourOffset <= 1; hourOffset += 1) {
    for (const minute of minutes) {
      candidates.push(new Date(y, mo, d, h + hourOffset, minute, 0, 0).getTime());
    }
  }
  candidates.sort((a, b) => a - b);

  for (const slot of candidates) {
    if (slot > t) return slot - t;
  }

  const tomorrow = new Date(y, mo, d, h + 1, minutes[0], 0, 0);
  return tomorrow.getTime() - t;
}

/** cron-job.org 크론 표현식 (매시 15·45분) */
export const TAB_SYNC_CRON_EXPRESSION = "15,45 * * * *";
