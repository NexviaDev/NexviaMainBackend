import axios from "axios";
import https from "https";

/** 입찰·사전규격과 동일 — 30분 (매시 :20·:50 갱신) */
export const MSS_RSS_TTL_MS = 30 * 60 * 1000;

const RSS_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 8,
});

const DATA_GO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const rssCache = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeRssText(raw) {
  return String(raw ?? "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRssChannelMeta(xml) {
  const s = String(xml ?? "");
  const channelBlock = s.match(/<channel>([\s\S]*?)<\/channel>/i)?.[1] ?? "";
  const pick = (tag) => {
    const cdata = channelBlock.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i"));
    const plain = channelBlock.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
    return decodeRssText(cdata?.[1] ?? plain?.[1] ?? "");
  };
  return {
    title: pick("title"),
    link: pick("link"),
    description: pick("description"),
    departCode: pick("departCode"),
  };
}

export function parseRssItems(xml, limit = 50) {
  const s = String(xml ?? "");
  const channel = parseRssChannelMeta(s);
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(s)) && items.length < limit) {
    const block = m[1];
    const pickTag = (tag) => {
      const cdata = block.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i"));
      const plain = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
      return decodeRssText(cdata?.[1] ?? plain?.[1] ?? "");
    };
    const title = pickTag("title");
    const link = pickTag("link");
    const pubDate = pickTag("pubDate");
    const boardItemId = pickTag("id");
    const cbIdx = link.match(/[?&]cbIdx=(\d+)/i)?.[1] ?? "";
    const bcIdx = link.match(/[?&]bcIdx=(\d+)/i)?.[1] ?? "";
    items.push({
      title: title || "—",
      link: link || "",
      pubDate: pubDate || "",
      boardItemId: boardItemId || "",
      cbIdx,
      bcIdx,
    });
  }
  return { channel, items };
}

/**
 * @param {"310"|"81"} board
 * @param {{ force?: boolean }} [opts]
 */
export async function fetchMssRssBoard(board, opts = {}) {
  const cacheKey = `mss:${board}`;
  const now = Date.now();
  if (!opts.force) {
    const hit = rssCache.get(cacheKey);
    if (hit && now - hit.at < MSS_RSS_TTL_MS) {
      return { ok: true, cached: true, board, channel: hit.channel ?? null, items: hit.items };
    }
  }

  const url = `https://www.mss.go.kr/rss/smba/board/${board}.do`;
  let lastErr;
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await axios.get(url, {
        timeout: 45_000,
        responseType: "text",
        validateStatus: () => true,
        httpsAgent: RSS_HTTPS_AGENT,
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          "User-Agent": DATA_GO_UA,
        },
        maxRedirects: 5,
      });
      if (r.status >= 500 && attempt < 2) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(500 * 2 ** attempt);
      else throw e;
    }
  }
  if (!r) throw lastErr || new Error("rss_fetch_failed");

  if (r.status >= 400) {
    return { ok: false, board, status: r.status, error: `rss_upstream_http_${r.status}` };
  }

  const xml = String(r.data ?? "");
  if (!/<rss[\s>]/i.test(xml) && /<html/i.test(xml)) {
    return { ok: false, board, error: "rss_not_rss" };
  }

  const { channel, items } = parseRssItems(xml, 50);
  rssCache.set(cacheKey, { at: now, items, channel });
  return { ok: true, cached: false, board, channel, items };
}
