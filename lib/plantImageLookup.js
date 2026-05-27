import axios from "axios";

const IMAGE_CACHE = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WIKI_HEADERS = {
  Accept: "application/json",
  "User-Agent": "NexviaPlants/1.0 (https://nexvia.co.kr; contact@nexvia.co.kr)",
};

const MAX_REFERENCE_IMAGES = 6;
/** 파일 제목만 검사(URL의 wikipedia 경로는 제외) */
function shouldSkipFileTitle(title) {
  const name = String(title ?? "");
  if (!name.startsWith("File:")) return true;
  if (/\.(svg|gif)$/i.test(name)) return true;
  return /\b(icon|logo|flag|symbol|edit-ltr|edit\.svg|button|stub)\b/i.test(name);
}

function cacheGet(key) {
  const hit = IMAGE_CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    IMAGE_CACHE.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  IMAGE_CACHE.set(key, { at: Date.now(), value });
}

async function wikiGet(lang, params) {
  const { data } = await axios.get(`https://${lang}.wikipedia.org/w/api.php`, {
    params: { format: "json", ...params },
    headers: WIKI_HEADERS,
    timeout: 12_000,
    validateStatus: (s) => s < 500,
  });
  return data;
}

/** 검색어 → 위키 문서 제목 */
async function resolveWikiPage(lang, searchTerm) {
  const term = String(searchTerm ?? "").trim();
  if (!term) return null;

  const cacheKey = `page:${lang}:${term.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const data = await wikiGet(lang, {
      action: "query",
      generator: "search",
      gsrsearch: term,
      gsrlimit: 1,
      prop: "info",
    });
    const page = data?.query?.pages ? Object.values(data.query.pages)[0] : null;
    const title = page?.title && page.missing === undefined ? page.title : null;
    cacheSet(cacheKey, title);
    return title;
  } catch {
    cacheSet(cacheKey, null);
    return null;
  }
}

/** 문서에 포함된 이미지 여러 장 */
async function fetchImagesFromPage(lang, title, limit = MAX_REFERENCE_IMAGES) {
  if (!title) return [];

  const cacheKey = `imgs:${lang}:${title}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const data = await wikiGet(lang, {
      action: "query",
      titles: title,
      generator: "images",
      gimlimit: Math.min(limit + 8, 20),
      prop: "imageinfo",
      iiprop: "url|thumburl",
      iiurlwidth: 480,
    });

    const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
    const out = [];

    for (const p of pages) {
      if (out.length >= limit) break;
      const name = String(p.title ?? "");
      if (shouldSkipFileTitle(name)) continue;

      const info = p.imageinfo?.[0];
      const imageUrl = info?.thumburl || info?.url;
      if (!imageUrl) continue;
      if (out.some((x) => x.imageUrl === imageUrl)) continue;

      out.push({
        imageUrl,
        imageSource: `Wikipedia (${lang})`,
        caption: name.replace(/^File:/, "").replace(/_/g, " "),
      });
    }

    cacheSet(cacheKey, out);
    return out;
  } catch {
    cacheSet(cacheKey, []);
    return [];
  }
}

/**
 * 학명·한국어명으로 위키 참고 이미지 여러 장 조회
 * @param {{ scientificName?: string, commonName?: string }} names
 * @param {number} [limit]
 */
export async function fetchPlantReferenceImages(names, limit = MAX_REFERENCE_IMAGES) {
  const scientific = String(names.scientificName ?? "").trim();
  const common = String(names.commonName ?? "").trim();
  const merged = [];
  const seen = new Set();

  const push = (items) => {
    for (const item of items) {
      if (!item?.imageUrl || seen.has(item.imageUrl)) continue;
      seen.add(item.imageUrl);
      merged.push(item);
      if (merged.length >= limit) return true;
    }
    return merged.length >= limit;
  };

  if (scientific) {
    const titleEn = await resolveWikiPage("en", scientific);
    if (titleEn) push(await fetchImagesFromPage("en", titleEn, limit));
  }

  if (merged.length < limit && common && common !== "식별 불가") {
    const titleKo = await resolveWikiPage("ko", common);
    if (titleKo) push(await fetchImagesFromPage("ko", titleKo, limit - merged.length));

    if (merged.length < limit) {
      const titleEn = await resolveWikiPage("en", common);
      if (titleEn) push(await fetchImagesFromPage("en", titleEn, limit - merged.length));
    }
  }

  return merged.slice(0, limit);
}

/** Gemini 1순위 식별 결과에 referenceImages 추가 */
export async function enrichPlantResult(result) {
  if (!result || result.commonName === "식별 불가") {
    return { ...result, referenceImages: [] };
  }

  const referenceImages = await fetchPlantReferenceImages(
    {
      scientificName: result.scientificName,
      commonName: result.commonName,
    },
    MAX_REFERENCE_IMAGES,
  );

  return {
    ...result,
    referenceImages,
    primaryImageUrl: referenceImages[0]?.imageUrl || null,
    primaryImageSource: referenceImages[0]?.imageSource || null,
  };
}

/**
 * @param {Array<{ commonName?: string, scientificName?: string }>} candidates
 */
export async function enrichSimilarCandidates(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return [];

  const enriched = await Promise.all(
    candidates.slice(0, 5).map(async (item) => {
      const refs = await fetchPlantReferenceImages(
        {
          scientificName: item.scientificName,
          commonName: item.commonName,
        },
        2,
      );
      const first = refs[0];
      return {
        ...item,
        imageUrl: first?.imageUrl || null,
        imageSource: first?.imageSource || null,
        referenceImages: refs,
      };
    }),
  );

  return enriched;
}
