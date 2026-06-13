/** tab-sync 실시간 콘솔 — 탭·페이지별 upstream 수신·MongoDB 저장 */

function formatCount(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("ko-KR");
}

/**
 * @param {{ tabKey: string, label?: string }} target
 */
export function createTabSyncProgressLog(target) {
  const tag = target.label || target.tabKey;
  const p = `[tab-sync][${tag}]`;

  return {
    start(extra = "") {
      console.log(`${p} ▶ 시작${extra ? ` ${extra}` : ""}`);
    },
    page(pageNo, totalPages, pageRows, mergedCount, totalCount = null) {
      const apiTotal = totalCount != null ? ` · API전체 ${formatCount(totalCount)}건` : "";
      console.log(
        `${p} p.${pageNo}/${totalPages} +${formatCount(pageRows)}건 → 누적 ${formatCount(mergedCount)}건${apiTotal}`
      );
    },
    milestone(pageNo, totalPages, mergedCount) {
      console.log(`${p} … ${pageNo}/${totalPages}페이지 · 누적 ${formatCount(mergedCount)}건`);
    },
    fail(reason) {
      console.log(`${p} ✗ 실패 — ${reason}`);
    },
    saved(rowCount, { truncated = false, totalCount = null, pages = null } = {}) {
      const parts = [`${formatCount(rowCount)}건`];
      if (totalCount != null) parts.push(`API ${formatCount(totalCount)}건`);
      if (pages != null) parts.push(`${pages}페이지`);
      if (truncated) parts.push("일부 잘림");
      console.log(`${p} ✓ MongoDB 저장 — ${parts.join(" · ")}`);
    },
    skip(reason) {
      console.log(`${p} ⊘ 건너뜀 — ${reason}`);
    },
  };
}

export function logTabSyncRunHeader(syncSlot, parallelLabels, sequentialLabels) {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━ tab-sync ━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[tab-sync] slot=${syncSlot} 시작 ${new Date().toLocaleString("ko-KR", { hour12: false })}`);
  if (parallelLabels.length) {
    console.log(`[tab-sync] 병렬(4탭): ${parallelLabels.join(", ")}`);
  }
  if (sequentialLabels.length) {
    console.log(`[tab-sync] 순차: ${sequentialLabels.join(", ")}`);
  }
}

export function logTabSyncRunFooter(syncSlot, sec, ok, results) {
  const okCount = results.filter((r) => r.ok && !r.skipped).length;
  const rowSum = results.reduce((s, r) => s + (Number(r.rowCount) || 0), 0);
  console.log(
    `[tab-sync] slot=${syncSlot} 완료 ${ok ? "OK" : "일부실패"} · ${sec}s · 탭 ${okCount}/${results.length} · 합계 ${formatCount(rowSum)}건`
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
}
