/** 구매·공사·용역·사전규격 — Promise.all 병렬 동기화 대상 */

export const NARA_PARALLEL_TAB_KEYS = new Set([
  "bid:Thng",
  "bid:Cnstwk",
  "bid:Servc",
  "prespec",
]);

export function isNaraParallelTab(tabKey) {
  return NARA_PARALLEL_TAB_KEYS.has(tabKey);
}
