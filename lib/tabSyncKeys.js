/** BidSearchHero 탭 ↔ MongoDB 스냅샷 키 (템플릿 M·매각 S 제외) */

export const TAB_SNAPSHOT_TARGETS = [
  { tabKey: "bid:Thng", uiTab: "I", label: "구매입찰", source: "nara_bid", naraBiz: "Thng" },
  { tabKey: "bid:Cnstwk", uiTab: "C", label: "공사입찰", source: "nara_bid", naraBiz: "Cnstwk" },
  { tabKey: "bid:Servc", uiTab: "Y", label: "용역입찰", source: "nara_bid", naraBiz: "Servc" },
  { tabKey: "prespec", uiTab: "P", label: "나라장터 사전규격", source: "prespec" },
  { tabKey: "bizinfo", uiTab: "B", label: "기업마당 지원사업", source: "bizinfo_support" },
  { tabKey: "events", uiTab: "H", label: "기업마당 행사·교육", source: "bizinfo_events" },
  { tabKey: "mss:310", uiTab: "R", label: "중소벤처 RSS 사업공고", source: "mss_rss", board: "310" },
  { tabKey: "mss:81", uiTab: "R", label: "중소벤처 RSS 공지", source: "mss_rss", board: "81" },
];

export function findTabSnapshotTarget(tabKey) {
  return TAB_SNAPSHOT_TARGETS.find((t) => t.tabKey === tabKey) ?? null;
}
