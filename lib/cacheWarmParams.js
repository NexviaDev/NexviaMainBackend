/** 프론트 bidSearchConfig · SupplementaryPanel · biddingDefaultFullFetch 와 동일한 기본 조회 조건 */

/** useBidSearch.loadAllPagesIntoCache · biddingDefaultFullFetch 와 동일 상한 */
export const MAX_BID_WARM_PAGES = 300;
export const MAX_PRESPEC_WARM_PAGES = 250;
export const MAX_BIZINFO_WARM_PAGES = 50;
export const MAX_EVENTS_WARM_PAGES = 250;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function toNaraDateTime(dateStr, hour, minute) {
  const d = String(dateStr).replaceAll("-", "");
  if (d.length !== 8) return "";
  const h = pad2(Math.min(23, Math.max(0, Number(hour) || 0)));
  const m = pad2(Math.min(59, Math.max(0, Number(minute) || 0)));
  return `${d}${h}${m}`;
}

function toYearMonth(dateStr) {
  return String(dateStr).replaceAll("-", "").slice(0, 6);
}

export function defaultBidDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  return { start: isoDate(start), end: isoDate(end) };
}

export function defaultPrespecDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start: isoDate(start), end: isoDate(end) };
}

/** 구매·공사·용역 1페이지 기본 목록 */
export function buildBidWarmQueries() {
  const { start, end } = defaultBidDateRange();
  const inqryBgnDt = toNaraDateTime(start, 0, 0);
  const inqryEndDt = toNaraDateTime(end, 23, 59);
  const base = {
    inqryDiv: "2",
    inqryBgnDt,
    inqryEndDt,
    pageNo: "1",
    numOfRows: "50",
    type: "json",
  };
  return [
    {
      namespace: "bid",
      operation: "getBidPblancListInfoThngPPSSrch",
      query: { ...base },
      label: "bid:Thng",
    },
    {
      namespace: "bid",
      operation: "getBidPblancListInfoCnstwkPPSSrch",
      query: { ...base },
      label: "bid:Cnstwk",
    },
    {
      namespace: "bid",
      operation: "getBidPblancListInfoServcPPSSrch",
      query: { ...base },
      label: "bid:Servc",
    },
  ];
}

/** 나라장터 사전규격 1페이지 — SupplementaryPanel 기본 operation */
export function buildPrespecWarmQuery() {
  const { start, end } = defaultPrespecDateRange();
  return {
    operation: "getPublicPrcureThngInfoThng",
    query: {
      inqryDiv: "1",
      orderBgnYm: toYearMonth(start),
      orderEndYm: toYearMonth(end),
      inqryBgnDt: toNaraDateTime(start, 0, 0),
      inqryEndDt: toNaraDateTime(end, 23, 59),
      pageNo: "1",
      numOfRows: "20",
      type: "json",
    },
  };
}

/** 기업마당 지원사업 — useBidSearch 기본 1페이지 */
export function buildBizinfoWarmQuery() {
  return {
    namespace: "bizinfo",
    operation: "support",
    query: {
      dataType: "json",
      pageUnit: "15",
      pageIndex: "1",
      searchCnt: "100",
    },
    label: "bizinfo:support",
  };
}

/** 기업마당 행사·교육 — SupplementaryPanel 기본 1페이지 */
export function buildEventsWarmQuery() {
  return {
    namespace: "bizinfo",
    operation: "events",
    query: {
      dataType: "json",
      pageUnit: "20",
      pageIndex: "1",
    },
    label: "bizinfo:events",
  };
}

/** 중소벤처 RSS — 사업공고·공지 */
export function buildMssWarmBoards() {
  return [
    { board: "310", label: "mss:310" },
    { board: "81", label: "mss:81" },
  ];
}
