/** 매시 :15, :45 — MongoDB 탭 동기화 (cron-job.org 와 동일 시각) */

import { msUntilNextWarmSlot, TAB_SYNC_SCHEDULE_MINUTES } from "./tabSyncSchedule.js";

/**
 * @param {{ serviceKey: string, fetchBid: Function, fetchPrespec: Function }} deps
 * @param {{ enabled?: boolean }} [opts]
 */
export function startCacheWarmScheduler(deps, opts = {}) {
  const enabled =
    opts.enabled ??
    (String(process.env.CACHE_WARM_SCHEDULE ?? "0").trim() !== "0" &&
      String(process.env.CACHE_WARM_TOKEN ?? "").trim().length > 0);

  if (!enabled) {
    console.log(
      "[tab-sync] internal scheduler disabled (CACHE_WARM_SCHEDULE=0 — use cron-job.org :15/:45)"
    );
    return () => {};
  }

  if (!deps.serviceKey) {
    console.warn("[tab-sync] scheduler skipped — DATA_GO_KR_SERVICE_KEY missing");
    return () => {};
  }

  let timer = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    const started = new Date();
    try {
      const { runTabSync } = await import("./tabSyncRun.js");
      const result = await runTabSync(deps, { force: true, syncSlot: "scheduled" });
      const syncCount = result.results?.filter((r) => r.ok).length ?? 0;
      const syncTotal = result.results?.length ?? 0;
      console.log(
        `[tab-sync] ${started.toISOString()} synced ${syncCount}/${syncTotal} (ok=${result.ok})`
      );
    } catch (e) {
      console.error("[tab-sync] scheduler failed:", e?.message || e);
    } finally {
      running = false;
      schedule();
    }
  };

  const schedule = () => {
    const delay = msUntilNextWarmSlot(new Date(), TAB_SYNC_SCHEDULE_MINUTES);
    const next = new Date(Date.now() + delay);
    console.log(
      `[tab-sync] next internal run at ${next.toLocaleString("ko-KR", { hour12: false })} (in ${Math.round(delay / 1000)}s)`
    );
    timer = setTimeout(() => void tick(), delay);
  };

  schedule();

  return () => {
    if (timer) clearTimeout(timer);
  };
}
