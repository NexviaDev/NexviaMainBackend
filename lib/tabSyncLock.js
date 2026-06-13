/** tab-sync 전역 1회 — bootstrap·cron·admin-run 동시 실행 방지 */

let chain = Promise.resolve();
let running = false;
let currentSlot = null;

export function isTabSyncRunning() {
  return running;
}

export function getTabSyncSlot() {
  return currentSlot;
}

/**
 * @param {string} slot
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTabSyncLock(slot, fn) {
  const prev = chain;
  let release;
  chain = new Promise((resolve) => {
    release = resolve;
  });
  await prev;

  if (running) {
    const msg = `tab_sync_busy:${currentSlot || "unknown"}`;
    release();
    throw new Error(msg);
  }

  running = true;
  currentSlot = slot;
  try {
    return await fn();
  } finally {
    running = false;
    currentSlot = null;
    release();
  }
}
