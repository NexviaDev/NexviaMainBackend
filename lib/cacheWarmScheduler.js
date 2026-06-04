/** 매시 :20, :50 — 서버 upstream 캐시 자동 갱신 (30분 주기) */

const WARM_MINUTES = [20, 50];

/**
 * @param {Date} [now]
 * @returns {number} ms until next :20 or :50 slot (strictly after now)
 */
export function msUntilNextWarmSlot(now = new Date()) {
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const h = now.getHours();
  const t = now.getTime();

  const candidates = [];
  for (let hourOffset = 0; hourOffset <= 1; hourOffset += 1) {
    for (const minute of WARM_MINUTES) {
      candidates.push(new Date(y, mo, d, h + hourOffset, minute, 0, 0).getTime());
    }
  }
  candidates.sort((a, b) => a - b);

  for (const slot of candidates) {
    if (slot > t) return slot - t;
  }

  const tomorrow = new Date(y, mo, d, h + 1, WARM_MINUTES[0], 0, 0);
  return tomorrow.getTime() - t;
}

/**
 * @param {{ serviceKey: string, fetchBid: Function, fetchPrespec: Function }} deps
 * @param {{ enabled?: boolean }} [opts]
 */
export function startCacheWarmScheduler(deps, opts = {}) {
  const enabled =
    opts.enabled ??
    (String(process.env.CACHE_WARM_SCHEDULE ?? "1").trim() !== "0" &&
      String(process.env.CACHE_WARM_TOKEN ?? "").trim().length > 0);

  if (!enabled) {
    console.log("[tab-sync] scheduler disabled (CACHE_WARM_SCHEDULE=0 or no token)");
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
    const delay = msUntilNextWarmSlot();
    const next = new Date(Date.now() + delay);
    console.log(
      `[tab-sync] next run at ${next.toLocaleString("ko-KR", { hour12: false })} (in ${Math.round(delay / 1000)}s)`
    );
    timer = setTimeout(() => void tick(), delay);
  };

  schedule();

  return () => {
    if (timer) clearTimeout(timer);
  };
}
