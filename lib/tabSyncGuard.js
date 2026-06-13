/**
 * 동기화 결과가 비었을 때 — API 오류·파싱 실패 vs 진짜 0건 구분
 * @param {{ allowEmpty?: boolean }} [opts] — RSS 등 0건이 정상일 수 있는 탭
 * @returns {string|null} 오류 메시지 (저장 스킵)
 */
export function emptySyncFailureReason(rowCount, totalCount, opts = {}) {
  const n = Number(rowCount) || 0;
  if (n > 0) return null;
  if (opts.allowEmpty && totalCount === 0) return null;
  if (totalCount != null && Number(totalCount) > 0) {
    return `empty_sync_but_api_total_${totalCount}`;
  }
  return "empty_sync_no_rows";
}
