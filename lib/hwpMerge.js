import { unzipSync, zipSync } from "fflate";
import sizeOf from "image-size";
import { utils as hwpxUtils } from "hwpx-js";
import {
  convertBufferWithLibreOffice,
  isLibreOfficeAvailable,
} from "./libreOffice.js";

const IMAGE_DATA_URL_RE = /^data:image\/([\w+.-]+);base64,/i;
const HWPX_XML_PARTS = /^Contents\/(section\d+\.xml|header\.xml)$/i;

const MIME_BY_FORMAT = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
};

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXmlText(str) {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXmlText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeImageKey(raw) {
  return String(raw || "")
    .trim()
    .replace(/^\{\{%?/, "")
    .replace(/^\{%/, "")
    .replace(/\}\}$/, "")
    .replace(/\%$/, "")
    .replace(/\s+/g, "");
}

function dataUrlToImage(dataUrl) {
  if (!IMAGE_DATA_URL_RE.test(String(dataUrl || ""))) return null;
  const m = String(dataUrl).match(IMAGE_DATA_URL_RE);
  const formatRaw = String(m?.[1] || "png").toLowerCase();
  const format = formatRaw === "jpeg" ? "jpg" : formatRaw === "jpg" ? "jpg" : "png";
  const base64 = String(dataUrl).replace(/^data:image\/[\w+.-]+;base64,/i, "");
  return { format, data: new Uint8Array(Buffer.from(base64, "base64")) };
}

function normalizeHwpRow(row, imageFieldKeys = []) {
  const imageKeySet = new Set(imageFieldKeys.map(normalizeImageKey).filter(Boolean));
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (key.startsWith("_")) continue;
    const normalizedKey = normalizeImageKey(key);
    if (normalizedKey && normalizedKey !== key && out[normalizedKey] == null) {
      out[normalizedKey] = value || "";
    }
    if (imageKeySet.has(key) || imageKeySet.has(normalizedKey)) {
      out[key] = value || "";
    } else {
      out[key] = String(value ?? "");
    }
  }
  return { row: out, imageKeySet };
}

function getHwpxParagraphText(paragraphXml) {
  const chunks = [
    ...paragraphXml.matchAll(/<hp:runText(?:\s[^>]*)?>([\s\S]*?)<\/hp:runText>/g),
    ...paragraphXml.matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/g),
  ].map((m) => decodeXmlText(m[1]));
  return chunks.join("");
}

function applyImageTagFixes(text, imageFieldKeys) {
  let out = text;
  for (const key of imageFieldKeys) {
    if (!key) continue;
    const esc = escapeRegex(key);
    if (!new RegExp(`\\{\\{%${esc}\\}\\}`).test(out)) {
      out = out
        .replace(new RegExp(`\\{\\{${esc}\\}\\}`, "g"), `{{%${key}}}`)
        .replace(new RegExp(`\\{%${esc}%\\}`, "g"), `{{%${key}}}`);
    }
  }
  return out;
}

function isImagePlaceholder(text, key) {
  const t = String(text || "").trim();
  const esc = escapeRegex(key);
  return (
    new RegExp(`^\\{\\{${esc}\\}\\}$`).test(t) ||
    new RegExp(`^\\{\\{%${esc}\\}\\}$`).test(t) ||
    new RegExp(`^\\{%${esc}%\\}$`).test(t)
  );
}

function collectImagePlaceholderKeys(xml, imageKeySet) {
  for (const m of String(xml).matchAll(/\{\{%([^{}]+)\}\}/g)) {
    const key = normalizeImageKey(m[1]);
    if (key) imageKeySet.add(key);
  }
  for (const m of String(xml).matchAll(/\{%([^{}%]+)%\}/g)) {
    const key = normalizeImageKey(m[1]);
    if (key) imageKeySet.add(key);
  }
}

function getDirectImagePlaceholderKey(text) {
  const t = String(text || "").trim();
  const modern = t.match(/^\{\{%(.+)\}\}$/);
  if (modern?.[1]) return normalizeImageKey(modern[1]);
  const legacy = t.match(/^\{%(.+)%\}$/);
  if (legacy?.[1]) return normalizeImageKey(legacy[1]);
  return "";
}

function pxToHwpUnit(px) {
  return hwpxUtils.mmToHwpunit(Math.round(Number(px || 0) * 0.26));
}

function imageDimensions(data) {
  const fallback = {
    orgWidth: hwpxUtils.mmToHwpunit(60),
    orgHeight: hwpxUtils.mmToHwpunit(40),
    width: hwpxUtils.mmToHwpunit(60),
    height: hwpxUtils.mmToHwpunit(40),
  };
  try {
    const dim = sizeOf(Buffer.from(data));
    if (!dim.width || !dim.height) return fallback;
    const orgWidth = pxToHwpUnit(dim.width);
    const orgHeight = pxToHwpUnit(dim.height);
    const maxW = hwpxUtils.mmToHwpunit(80);
    let width = orgWidth;
    let height = orgHeight;
    if (width > maxW) {
      const ratio = maxW / width;
      width = maxW;
      height = Math.round(height * ratio);
    }
    return { orgWidth, orgHeight, width, height };
  } catch {
    return fallback;
  }
}

function extractPictureTemplate(files) {
  for (const path of Object.keys(files).sort()) {
    if (!/\.xml$/i.test(path)) continue;
    const xml = new TextDecoder("utf-8").decode(files[path]);
    const match = xml.match(/<hp:pic[\s\S]*?<\/hp:pic>/);
    if (match) return match[0];
  }
  return null;
}

function getParagraphCharPrRef(paragraphXml) {
  return paragraphXml.match(/<hp:run[^>]*\scharPrIDRef="(\d+)"/)?.[1] || "0";
}

function patchPictureTemplate(templateXml, { binRef, width, height, orgWidth, orgHeight }) {
  let xml = templateXml;
  const scaX = orgWidth > 0 ? (width / orgWidth).toFixed(6) : "1.000000";
  const scaY = orgHeight > 0 ? (height / orgHeight).toFixed(6) : "1.000000";
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);

  if (/binaryItemIDRef="/i.test(xml)) {
    xml = xml.replace(/binaryItemIDRef="[^"]*"/, `binaryItemIDRef="${binRef}"`);
  }
  if (/binDataIDRef="/i.test(xml)) {
    xml = xml.replace(/binDataIDRef="[^"]*"/, `binDataIDRef="${String(binRef).replace(/^image/i, "")}"`);
  }

  xml = xml
    .replace(/(<hp:orgSz[^>]*\swidth=")[^"]*(")/, `$1${orgWidth}$2`)
    .replace(/(<hp:orgSz[^>]*\sheight=")[^"]*(")/, `$1${orgHeight}$2`)
    .replace(/(<hp:curSz[^>]*\swidth=")[^"]*(")/, `$1${width}$2`)
    .replace(/(<hp:curSz[^>]*\sheight=")[^"]*(")/, `$1${height}$2`)
    .replace(/(<hp:sz[^>]*\swidth=")[^"]*(")/, `$1${width}$2`)
    .replace(/(<hp:sz[^>]*\sheight=")[^"]*(")/, `$1${height}$2`)
    .replace(/(<hp:imgDim[^>]*\sdimwidth=")[^"]*(")/, `$1${orgWidth}$2`)
    .replace(/(<hp:imgDim[^>]*\sdimheight=")[^"]*(")/, `$1${orgHeight}$2`)
    .replace(/(<hp:rotationInfo[^>]*\scenterX=")[^"]*(")/, `$1${cx}$2`)
    .replace(/(<hp:rotationInfo[^>]*\scenterY=")[^"]*(")/, `$1${cy}$2`)
    .replace(
      /(<hc:scaMatrix[^>]*\se1=")[^"]*(")/,
      `$1${scaX}$2`,
    )
    .replace(
      /(<hc:scaMatrix[^>]*\se5=")[^"]*(")/,
      `$1${scaY}$2`,
    );

  if (/<hp:imgRect[\s\S]*?<\/hp:imgRect>/.test(xml)) {
    xml = xml.replace(
      /<hp:imgRect[\s\S]*?<\/hp:imgRect>/,
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${orgWidth}" y="0"/><hc:pt2 x="${orgWidth}" y="${orgHeight}"/><hc:pt3 x="0" y="${orgHeight}"/></hp:imgRect>`,
    );
  }
  if (/<hp:imgClip[^>]*\/>/.test(xml)) {
    xml = xml.replace(
      /<hp:imgClip[^>]*\/>/,
      `<hp:imgClip left="0" right="0" top="0" bottom="0"/>`,
    );
  }

  return xml;
}

function buildHancomPictureXml({ binRef, width, height, orgWidth, orgHeight, templateXml }) {
  if (templateXml?.includes("</hp:pic>")) {
    return patchPictureTemplate(templateXml, { binRef, width, height, orgWidth, orgHeight });
  }

  const instanceId = String(1_000_000 + Math.floor(Math.random() * 8_000_000));
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const scaX = orgWidth > 0 ? (width / orgWidth).toFixed(6) : "1.000000";
  const scaY = orgHeight > 0 ? (height / orgHeight).toFixed(6) : "1.000000";

  return (
    `<hp:pic id="${instanceId}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${instanceId}" reverse="0">` +
    `<hp:offset x="0" y="0"/>` +
    `<hp:orgSz width="${orgWidth}" height="${orgHeight}"/>` +
    `<hp:curSz width="${width}" height="${height}"/>` +
    `<hp:flip horizontal="0" vertical="0"/>` +
    `<hp:rotationInfo angle="0" centerX="${cx}" centerY="${cy}" rotateimage="1"/>` +
    `<hp:renderingInfo>` +
    `<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
    `<hc:scaMatrix e1="${scaX}" e2="0" e3="0" e4="0" e5="${scaY}" e6="0"/>` +
    `<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
    `</hp:renderingInfo>` +
    `<hp:imgRect>` +
    `<hc:pt0 x="0" y="0"/><hc:pt1 x="${orgWidth}" y="0"/><hc:pt2 x="${orgWidth}" y="${orgHeight}"/><hc:pt3 x="0" y="${orgHeight}"/>` +
    `</hp:imgRect>` +
    `<hp:imgClip left="0" right="0" top="0" bottom="0"/>` +
    `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
    `<hp:imgDim dimwidth="${orgWidth}" dimheight="${orgHeight}"/>` +
    `<hc:img binaryItemIDRef="${binRef}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
    `<hp:effects/>` +
    `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
    `</hp:pic>`
  );
}

function detectBinHrefPrefix(contentHpfXml) {
  const m = String(contentHpfXml).match(/href="([^"]*?)BinData\//);
  return m ? `${m[1]}BinData/` : "../BinData/";
}

function scanNextBinId(contentHpfXml, manifestXml, files) {
  let nextId = 0;
  for (const m of String(contentHpfXml).matchAll(/id="(?:bindata|image)(\d+)"/g)) {
    nextId = Math.max(nextId, Number(m[1]));
  }
  for (const m of String(manifestXml).matchAll(/BinData\/(?:image|bin)(\d+)\./gi)) {
    nextId = Math.max(nextId, Number(m[1]));
  }
  for (const path of Object.keys(files)) {
    const m = path.match(/^BinData\/(?:image|bin)(\d+)\./i);
    if (m) nextId = Math.max(nextId, Number(m[1]));
  }
  return nextId + 1;
}

function createImageState(contentHpfXml, manifestXml, files) {
  return {
    nextId: scanNextBinId(contentHpfXml, manifestXml, files),
    bins: [],
    replacedKeys: new Set(),
    pictureTemplate: extractPictureTemplate(files),
    binHrefPrefix: detectBinHrefPrefix(contentHpfXml),
  };
}

function registerImage(imageState, img) {
  const id = imageState.nextId++;
  const name = `image${id}.${img.format}`;
  const itemId = `image${id}`;
  imageState.bins.push({ id, name, itemId, format: img.format, data: img.data });
  const dims = imageDimensions(img.data);
  return { id, name, binRef: itemId, ...dims };
}

function normalizeBinPath(href) {
  const clean = String(href || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const idx = clean.lastIndexOf("BinData/");
  return idx >= 0 ? clean.slice(idx) : clean;
}

function parseContentHpfItems(xml) {
  const items = new Map();
  for (const m of String(xml).matchAll(/<opf:item\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/\sid="([^"]+)"/)?.[1];
    const href = tag.match(/\shref="([^"]+)"/)?.[1];
    if (id && href && href.includes("BinData/")) {
      items.set(id, normalizeBinPath(href));
    }
  }
  return items;
}

function collectExistingPictureRefs(files, contentHpfXml) {
  const items = parseContentHpfItems(contentHpfXml);
  const refs = [];
  const seen = new Set();
  for (const path of Object.keys(files)) {
    if (!HWPX_XML_PARTS.test(path)) continue;
    const xml = new TextDecoder("utf-8").decode(files[path]);
    for (const m of xml.matchAll(/<hc:img\b[^>]*\sbinaryItemIDRef="([^"]+)"/g)) {
      const binRef = m[1];
      const binPath = items.get(binRef);
      if (!binPath || seen.has(binRef)) continue;
      seen.add(binRef);
      refs.push({ binRef, binPath });
    }
  }
  return refs;
}

function replacePathText(xml, oldPath, newPath) {
  if (oldPath === newPath) return xml;
  return String(xml).replace(new RegExp(escapeRegex(oldPath), "g"), newPath);
}

function replaceExistingImageSlots(files, row, imageKeySet, imageState) {
  const contentPath = "Contents/content.hpf";
  if (!files[contentPath]) return;

  let contentHpfXml = new TextDecoder("utf-8").decode(files[contentPath]);
  let manifestXml = files["META-INF/manifest.xml"]
    ? new TextDecoder("utf-8").decode(files["META-INF/manifest.xml"])
    : "";
  const refs = collectExistingPictureRefs(files, contentHpfXml);
  if (!refs.length) return;

  let refIndex = 0;
  for (const key of imageKeySet) {
    const dataUrl = row[key] ?? row[normalizeImageKey(key)];
    const img = dataUrlToImage(dataUrl);
    if (!img) continue;

    const ref = refs[refIndex++];
    if (!ref) break;

    const nextPath = ref.binPath.replace(/\.[^.\/]+$/i, `.${img.format}`);
    if (nextPath !== ref.binPath) {
      delete files[ref.binPath];
      contentHpfXml = replacePathText(contentHpfXml, ref.binPath, nextPath);
      manifestXml = replacePathText(manifestXml, ref.binPath, nextPath);
    }
    files[nextPath] = img.data;
    imageState.replacedKeys.add(normalizeImageKey(key));
  }

  files[contentPath] = new TextEncoder().encode(contentHpfXml);
  if (files["META-INF/manifest.xml"]) {
    files["META-INF/manifest.xml"] = new TextEncoder().encode(manifestXml);
  }
}

function hasImageData(row, key) {
  const value = row[key] ?? row[normalizeImageKey(key)];
  return typeof value === "string" && IMAGE_DATA_URL_RE.test(value);
}

function assertHwpxImageSlots(row, imageKeySet, imageState) {
  for (const key of imageKeySet) {
    const normalized = normalizeImageKey(key);
    if (!hasImageData(row, key)) continue;
    if (!imageState.replacedKeys.has(normalized)) {
      throw new Error("hwpx_image_slot_required");
    }
  }
}

function buildPictureParagraph(paragraphXml, picMeta, pictureTemplate) {
  const pOpen = paragraphXml.match(/^<hp:p[^>]*>/)?.[0] || "<hp:p>";
  const pPr = paragraphXml.match(/<hp:pPr[\s\S]*?<\/hp:pPr>/)?.[0] || "";
  const lineSeg = paragraphXml.match(/<hp:linesegarray[\s\S]*?<\/hp:linesegarray>/)?.[0] || "";
  const charPrIDRef = getParagraphCharPrRef(paragraphXml);
  const picRun = buildPictureRun(charPrIDRef, picMeta, pictureTemplate);
  return `${pOpen}${pPr}${picRun}${lineSeg}</hp:p>`;
}

function buildStandalonePictureParagraph(charPrIDRef, picMeta, pictureTemplate) {
  const picRun = buildPictureRun(charPrIDRef || "0", picMeta, pictureTemplate);
  return `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${picRun}</hp:p>`;
}

function buildPictureRun(charPrIDRef, picMeta, pictureTemplate) {
  const picXml = buildHancomPictureXml({
    binRef: picMeta.binRef,
    width: picMeta.width,
    height: picMeta.height,
    orgWidth: picMeta.orgWidth,
    orgHeight: picMeta.orgHeight,
    templateXml: pictureTemplate,
  });
  return `<hp:run charPrIDRef="${charPrIDRef || "0"}">${picXml}</hp:run>`;
}

function replaceImageRunInParagraph(paragraphXml, key, picMeta, pictureTemplate, imageFieldKeys) {
  let replaced = false;
  const next = paragraphXml.replace(/<hp:run\b[\s\S]*?<\/hp:run>/g, (runXml) => {
    let runText = getHwpxParagraphText(runXml);
    runText = applyImageTagFixes(runText, imageFieldKeys);
    if (!isImagePlaceholder(runText, key)) return runXml;

    replaced = true;
    const charPrIDRef = runXml.match(/^<hp:run[^>]*\scharPrIDRef="(\d+)"/)?.[1] || "0";
    return buildPictureRun(charPrIDRef, picMeta, pictureTemplate);
  });
  return replaced ? next : null;
}

function removeImageRunAndAppendPictureParagraph(paragraphXml, key, picMeta, pictureTemplate, imageFieldKeys) {
  let removed = false;
  let charPrIDRef = "0";
  const withoutPlaceholder = paragraphXml.replace(/<hp:run\b[\s\S]*?<\/hp:run>/g, (runXml) => {
    let runText = getHwpxParagraphText(runXml);
    runText = applyImageTagFixes(runText, imageFieldKeys);
    if (!isImagePlaceholder(runText, key)) return runXml;

    removed = true;
    charPrIDRef = runXml.match(/^<hp:run[^>]*\scharPrIDRef="(\d+)"/)?.[1] || "0";
    return "";
  });

  if (!removed) return null;
  return `${withoutPlaceholder}${buildStandalonePictureParagraph(charPrIDRef, picMeta, pictureTemplate)}`;
}

function removeImageRunFromParagraph(paragraphXml, key, imageFieldKeys) {
  let removed = false;
  const withoutPlaceholder = paragraphXml.replace(/<hp:run\b[\s\S]*?<\/hp:run>/g, (runXml) => {
    let runText = getHwpxParagraphText(runXml);
    runText = applyImageTagFixes(runText, imageFieldKeys);
    if (!isImagePlaceholder(runText, key)) return runXml;

    removed = true;
    return "";
  });
  if (removed) return withoutPlaceholder;
  return buildEmptyParagraph(paragraphXml);
}

function buildEmptyParagraph(paragraphXml) {
  const pOpen = paragraphXml.match(/^<hp:p[^>]*>/)?.[0] || "<hp:p>";
  const pPr = paragraphXml.match(/<hp:pPr[\s\S]*?<\/hp:pPr>/)?.[0] || "";
  return `${pOpen}${pPr}<hp:run charPrIDRef="0"><hp:runText></hp:runText></hp:run></hp:p>`;
}

function tryReplaceImageParagraph(paragraphXml, row, imageKeySet, imageState, imageFieldKeys) {
  let joined = getHwpxParagraphText(paragraphXml);
  joined = applyImageTagFixes(joined, imageFieldKeys);

  const directImageKey = getDirectImagePlaceholderKey(joined);
  if (directImageKey) {
    imageKeySet.add(directImageKey);
  }

  for (const key of imageKeySet) {
    if (!isImagePlaceholder(joined, key)) continue;
    if (imageState.replacedKeys.has(normalizeImageKey(key))) {
      return removeImageRunFromParagraph(paragraphXml, key, imageFieldKeys);
    }
    const dataUrl = row[key] ?? row[normalizeImageKey(key)];
    if (!dataUrl) return buildEmptyParagraph(paragraphXml);
    const img = dataUrlToImage(dataUrl);
    if (!img) return buildEmptyParagraph(paragraphXml);
    const pic = registerImage(imageState, img);

    if (/<hp:secPr[\s>]/.test(paragraphXml) || /<hp:colPr[\s>]/.test(paragraphXml)) {
      const splitParagraph = removeImageRunAndAppendPictureParagraph(
        paragraphXml,
        key,
        pic,
        imageState.pictureTemplate,
        imageFieldKeys,
      );
      if (splitParagraph) return splitParagraph;
    }

    const runReplaced = replaceImageRunInParagraph(
      paragraphXml,
      key,
      pic,
      imageState.pictureTemplate,
      imageFieldKeys,
    );
    if (runReplaced) return runReplaced;
    return buildPictureParagraph(paragraphXml, pic, imageState.pictureTemplate);
  }
  return null;
}

/** hp:p 안 runText 조각 병합 */
function normalizeHwpxParagraph(paragraphXml, imageFieldKeys = []) {
  const joined = getHwpxParagraphText(paragraphXml);
  if (!joined.includes("{{")) return paragraphXml;

  const normalized = applyImageTagFixes(joined, imageFieldKeys);
  const runCount =
    (paragraphXml.match(/<hp:runText[\s>]/g) || []).length +
    (paragraphXml.match(/<hp:t[\s>]/g) || []).length;
  const needsRewrite = runCount > 1 || normalized !== joined;
  if (!needsRewrite) return paragraphXml;

  const pOpen = paragraphXml.match(/^<hp:p[^>]*>/)?.[0] || "<hp:p>";
  const pPr = paragraphXml.match(/<hp:pPr[\s\S]*?<\/hp:pPr>/)?.[0] || "";
  return `${pOpen}${pPr}<hp:run charPrIDRef="0"><hp:runText>${escapeXmlText(normalized)}</hp:runText></hp:run></hp:p>`;
}

/** 표 래퍼 문단(hp:tbl 포함)은 건너뛰고, 셀·본문의 leaf 문단만 처리 */
const LEAF_PARAGRAPH_RE = /<hp:p(?:\s[^>]*)?>((?:(?!<hp:p(?:\s|>)|<hp:tbl(?:\s|>))[\s\S])*?)<\/hp:p>/g;

function mergeHwpxXml(xml, row, imageKeySet, imageFieldKeys, imageState) {
  let out = xml.replace(LEAF_PARAGRAPH_RE, (paragraph) => {
    const directImageKey = getDirectImagePlaceholderKey(getHwpxParagraphText(paragraph));
    if (directImageKey) imageKeySet.add(directImageKey);

    const imagePara = tryReplaceImageParagraph(paragraph, row, imageKeySet, imageState, imageFieldKeys);
    if (imagePara) return imagePara;
    return normalizeHwpxParagraph(paragraph, imageFieldKeys);
  });

  for (const [key, value] of Object.entries(row)) {
    if (imageKeySet.has(key)) continue;
    out = out.replace(
      new RegExp(`\\{\\{${escapeRegex(key)}\\}\\}`, "g"),
      escapeXmlText(String(value ?? "")),
    );
  }

  return out;
}

function appendBinToContentHpf(xml, bins, hrefPrefix = "BinData/") {
  if (!bins.length) return xml;
  const items = bins
    .map(
      (b) =>
        `<opf:item id="${b.itemId}" href="${hrefPrefix}${b.name}" media-type="${MIME_BY_FORMAT[b.format] || "image/png"}"/>`,
    )
    .join("\n");
  if (xml.includes("</opf:manifest>")) {
    return xml.replace("</opf:manifest>", `${items}\n</opf:manifest>`);
  }
  return xml;
}

function appendBinToManifest(xml, bins) {
  if (!bins.length) return xml;
  const root = String(xml).match(/<([A-Za-z_][\w.-]*):manifest\b([^>]*?)(\/?)>/);
  const prefix = root?.[1] || "manifest";
  const items = bins
    .map(
      (b) =>
        `<${prefix}:file-entry ${prefix}:full-path="BinData/${b.name}" ${prefix}:media-type="${MIME_BY_FORMAT[b.format] || "image/png"}"/>`,
    )
    .join("\n");
  const closing = new RegExp(`</${escapeRegex(prefix)}:manifest>`);
  if (closing.test(xml)) {
    return xml.replace(closing, `${items}\n</${prefix}:manifest>`);
  }
  if (root?.[3] === "/") {
    return xml.replace(
      root[0],
      `<${prefix}:manifest${root[2]}>\n${items}\n</${prefix}:manifest>`,
    );
  }
  return xml;
}

function zipHwpxEntries(files) {
  const zipData = {};
  const paths = Object.keys(files).sort((a, b) => {
    if (a === "mimetype") return -1;
    if (b === "mimetype") return 1;
    return a.localeCompare(b);
  });
  for (const path of paths) {
    const data = files[path];
    zipData[path] = path === "mimetype" ? [data, { level: 0 }] : data;
  }
  return Buffer.from(zipSync(zipData));
}

/** HWPX ZIP 내부 XML 치환 + BinData 사진 삽입 */
export function mergeHwpxInPlace(templateBuffer, row, { imageFieldKeys = [] } = {}) {
  const { row: data, imageKeySet } = normalizeHwpRow(row, imageFieldKeys);
  const files = unzipSync(new Uint8Array(templateBuffer));

  const contentHpf = files["Contents/content.hpf"]
    ? new TextDecoder("utf-8").decode(files["Contents/content.hpf"])
    : "";
  const manifest = files["META-INF/manifest.xml"]
    ? new TextDecoder("utf-8").decode(files["META-INF/manifest.xml"])
    : "";
  const imageState = createImageState(contentHpf, manifest, files);

  for (const path of Object.keys(files)) {
    if (!HWPX_XML_PARTS.test(path)) continue;
    const xml = new TextDecoder("utf-8").decode(files[path]);
    collectImagePlaceholderKeys(xml, imageKeySet);
  }

  replaceExistingImageSlots(files, data, imageKeySet, imageState);
  assertHwpxImageSlots(data, imageKeySet, imageState);

  for (const path of Object.keys(files)) {
    if (!HWPX_XML_PARTS.test(path)) continue;
    const xml = new TextDecoder("utf-8").decode(files[path]);
    files[path] = new TextEncoder().encode(
      mergeHwpxXml(xml, data, imageKeySet, imageFieldKeys, imageState),
    );
  }

  for (const bin of imageState.bins) {
    files[`BinData/${bin.name}`] = bin.data;
  }

  if (imageState.bins.length && files["Contents/content.hpf"]) {
    const updated = appendBinToContentHpf(
      new TextDecoder("utf-8").decode(files["Contents/content.hpf"]),
      imageState.bins,
      imageState.binHrefPrefix,
    );
    files["Contents/content.hpf"] = new TextEncoder().encode(updated);
  }

  if (imageState.bins.length && files["META-INF/manifest.xml"]) {
    const updated = appendBinToManifest(
      new TextDecoder("utf-8").decode(files["META-INF/manifest.xml"]),
      imageState.bins,
    );
    files["META-INF/manifest.xml"] = new TextEncoder().encode(updated);
  }

  return zipHwpxEntries(files);
}

export function detectHwpBinaryFormat(buffer) {
  return hwpxUtils.detectFormat(new Uint8Array(buffer));
}

export async function prepareHwpTemplateBuffer(templateBuffer, format) {
  const detected = detectHwpBinaryFormat(templateBuffer);
  if (format === "hwp" || detected === "hwp5") {
    if (!isLibreOfficeAvailable()) {
      throw new Error("hwp_needs_libreoffice");
    }
    return convertBufferWithLibreOffice(templateBuffer, "hwp", "hwpx");
  }
  return templateBuffer;
}

export async function mergeHwpBufferAsync(templateBuffer, row, { imageFieldKeys = [], format = "hwpx" } = {}) {
  const prepared = await prepareHwpTemplateBuffer(templateBuffer, format);
  return mergeHwpxInPlace(prepared, row, { imageFieldKeys });
}

export function mergeHwpBuffer(templateBuffer, row, opts = {}) {
  return mergeHwpxInPlace(templateBuffer, row, opts);
}
