/**
 * 동기화 결과가 비었을 때 — API 오류·파싱 실패 vs 진짜 0건 구분
 * @returns {string|null} 오류 메시지 (저장 스킵)
 */
export function emptySyncFailureReason(rowCount, totalCount) {
  const n = Number(rowCount) || 0;
  if (n > 0) return null;
  if (totalCount === 0) return null;
  if (totalCount != null && Number(totalCount) > 0) {
    return `empty_sync_but_api_total_${totalCount}`;
  }
  return "empty_sync_no_rows";
}
