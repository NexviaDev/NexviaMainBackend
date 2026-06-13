/** tab-sync 장시간 실행 중 Railway 슬립(~30초) 방지 — 20초마다 /health ping */

import axios from "axios";

const DEFAULT_INTERVAL_MS = 20_000;

function resolveWakeBases() {
  const bases = [];
  for (const key of ["TAB_SYNC_WAKE_URL", "RAILWAY_PUBLIC_DOMAIN", "PUBLIC_BASE_URL"]) {
    const raw = String(process.env[key] ?? "").trim().replace(/\/$/, "");
    if (!raw) continue;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!bases.includes(url)) bases.push(url);
  }
  const port = Number(process.env.PORT) || 5001;
  bases.push(`http://127.0.0.1:${port}`);
  return bases;
}

async function pingOnce(bases) {
  await Promise.all(
    bases.map((base) =>
      axios
        .get(`${base}/health`, {
          timeout: 15_000,
          validateStatus: () => true,
          headers: { "User-Agent": "NexviaTabSyncKeepAlive/1.0" },
        })
        .catch(() => null)
    )
  );
}

/**
 * @param {string} syncSlot
 * @param {{ intervalMs?: number }} [opts]
 * @returns {() => void} stop
 */
export function startTabSyncKeepAlive(syncSlot, opts = {}) {
  const intervalMs = Math.max(10_000, Number(opts.intervalMs) || DEFAULT_INTERVAL_MS);
  const bases = resolveWakeBases();
  void pingOnce(bases);
  const timer = setInterval(() => void pingOnce(bases), intervalMs);
  console.log(
    `[tab-sync] keep-alive on slot=${syncSlot} every ${Math.round(intervalMs / 1000)}s → ${bases.join(", ")}`
  );
  return () => {
    clearInterval(timer);
    console.log(`[tab-sync] keep-alive off slot=${syncSlot}`);
  };
}
