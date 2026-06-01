import PizZip from "pizzip";

/** Word document.xml·header·footer 에서 {{필드}} 추출 */
export function extractMergeFieldsFromDocx(buffer) {
  const zip = new PizZip(buffer);
  const keys = new Set();
  const xmlParts = Object.keys(zip.files).filter(
    (n) =>
      /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(n) ||
      /^word\/(document|header\d+|footer\d+)\.xml$/i.test(n),
  );

  const imageKeys = new Set();

  for (const part of xmlParts) {
    const file = zip.file(part);
    if (!file) continue;
    const xml = file.asText();
    collectBraceFields(xml, keys);
    collectImageFields(xml, imageKeys);
    collectMergeFieldInstr(xml, keys);
  }

  return [...new Set([...keys, ...imageKeys])].sort().map((key) => ({
    key,
    label: key,
    example: "",
    type: imageKeys.has(key) ? "image" : "text",
  }));
}

function collectBraceFields(xml, keys) {
  const re = /\{\{([^{}]+)\}\}/g;
  let m;
  while ((m = re.exec(xml))) {
    const key = String(m[1] || "").trim();
    if (key) keys.add(key);
  }
}

/** docxtemplater 이미지 모듈 — Word에 {%필드명%} (단독 문단) */
function collectImageFields(xml, imageKeys) {
  const re = /\{%([^{}%]+)%\}/g;
  let m;
  while ((m = re.exec(xml))) {
    const key = String(m[1] || "").trim().replace(/^%+|%+$/g, "");
    if (key) imageKeys.add(key);
  }
}

/** LibreOffice / Word MERGEFIELD */
function collectMergeFieldInstr(xml, keys) {
  const re = /MERGEFIELD\s+([^\s\\|}]+)/gi;
  let m;
  while ((m = re.exec(xml))) {
    const key = String(m[1] || "").trim().replace(/^"|"$/g, "");
    if (key) keys.add(key);
  }
}

export function sanitizeFileStem(name, fallback = "document") {
  const stem = String(name || fallback)
    .replace(/\.[^.]+$/, "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .trim();
  return stem || fallback;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXmlText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeXmlText(str) {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function getWordParagraphPlainText(paragraphXml) {
  return [...paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((m) => decodeXmlText(m[1]))
    .join("");
}

function getPptParagraphPlainText(paragraphXml) {
  return [...paragraphXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
    .map((m) => decodeXmlText(m[1]))
    .join("");
}

function applyImageTagFixes(text, imageFieldKeys) {
  let out = text;
  for (const key of imageFieldKeys) {
    if (!key) continue;
    const esc = escapeRegex(key);
    const alreadyImage = new RegExp(`\\{\\{%${esc}\\}\\}`);
    if (!alreadyImage.test(out)) {
      out = out
        .replace(new RegExp(`\\{\\{${esc}\\}\\}`, "g"), `{{%${key}}}`)
        .replace(new RegExp(`\\{%${esc}%\\}`, "g"), `{{%${key}}}`);
    }
  }
  return out;
}

/** Word가 {{태그}} 를 여러 w:t 로 쪼개면 docxtemplater Unclosed tag 오류 → 한 run 으로 합침 */
function normalizeWordParagraph(paragraphXml, imageFieldKeys = []) {
  const joined = getWordParagraphPlainText(paragraphXml);
  if (!joined.includes("{{")) return paragraphXml;

  const normalized = applyImageTagFixes(joined, imageFieldKeys);
  const runCount = (paragraphXml.match(/<w:t[\s>]/g) || []).length;
  const needsRewrite = runCount > 1 || normalized !== joined;
  if (!needsRewrite) return paragraphXml;

  const pOpen = paragraphXml.match(/^<w:p[^>]*>/)?.[0] || "<w:p>";
  const pPr = paragraphXml.match(/<w:pPr[\s\S]*?<\/w:pPr>/)?.[0] || "";
  return `${pOpen}${pPr}<w:r><w:t xml:space="preserve">${escapeXmlText(normalized)}</w:t></w:r></w:p>`;
}

/** PowerPoint a:p 문단 — a:t 분할 병합 */
function normalizePptParagraph(paragraphXml, imageFieldKeys = []) {
  const joined = getPptParagraphPlainText(paragraphXml);
  if (!joined.includes("{{")) return paragraphXml;

  const normalized = applyImageTagFixes(joined, imageFieldKeys);
  const runCount = (paragraphXml.match(/<a:t[\s>]/g) || []).length;
  const needsRewrite = runCount > 1 || normalized !== joined;
  if (!needsRewrite) return paragraphXml;

  const pOpen = paragraphXml.match(/^<a:p[^>]*>/)?.[0] || "<a:p>";
  const pPr = paragraphXml.match(/<a:pPr[\s\S]*?<\/a:pPr>/)?.[0] || "";
  return `${pOpen}${pPr}<a:r><a:rPr lang="ko-KR" dirty="0"/><a:t xml:space="preserve">${escapeXmlText(normalized)}</a:t></a:r></a:p>`;
}

function prepareDocxTemplate(buffer, imageFieldKeys) {
  const zip = new PizZip(buffer);
  const xmlParts = Object.keys(zip.files).filter((n) =>
    /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(n),
  );
  for (const part of xmlParts) {
    const file = zip.file(part);
    if (!file) continue;
    let xml = file.asText();
    xml = xml.replace(/<w:p[\s\S]*?<\/w:p>/g, (paragraph) =>
      normalizeWordParagraph(paragraph, imageFieldKeys),
    );
    zip.file(part, xml);
  }
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

function preparePptxTemplate(buffer, imageFieldKeys) {
  const zip = new PizZip(buffer);
  const xmlParts = Object.keys(zip.files).filter((n) =>
    /^ppt\/(slides|notesSlides|slideMasters|slideLayouts)\/.*\.xml$/i.test(n),
  );
  for (const part of xmlParts) {
    const file = zip.file(part);
    if (!file) continue;
    let xml = file.asText();
    xml = xml.replace(/<a:p[\s\S]*?<\/a:p>/g, (paragraph) =>
      normalizePptParagraph(paragraph, imageFieldKeys),
    );
    zip.file(part, xml);
  }
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Office XML 전처리: 쪼개진 {{태그}} 병합 + 사진 {{키}} → {{%키}} */
export function prepareTemplateForMerge(buffer, imageFieldKeys = [], format = "docx") {
  if (!buffer?.length) return buffer;
  if (format === "pptx") return preparePptxTemplate(buffer, imageFieldKeys);
  return prepareDocxTemplate(buffer, imageFieldKeys);
}

/** @deprecated prepareTemplateForMerge 사용 */
export function prepareTemplateForImageFields(buffer, imageFieldKeys = []) {
  return prepareTemplateForMerge(buffer, imageFieldKeys);
}

/** 사진 필드가 Word에서 {{키}} 로만 들어가 있으면 base64 글자가 그대로 출력됨 */
export function validateImageFieldTags(buffer, imageFieldKeys = []) {
  if (!imageFieldKeys?.length) return [];
  const zip = new PizZip(buffer);
  const xmlParts = Object.keys(zip.files).filter((n) =>
    /^word\/(document|header\d+|footer\d+)\.xml$/i.test(n),
  );
  const xml = xmlParts
    .map((part) => zip.file(part)?.asText() || "")
    .join("\n");
  const warnings = [];
  for (const key of imageFieldKeys) {
    if (!key) continue;
    const wrong = new RegExp(`\\{\\{${escapeRegex(key)}\\}\\}`);
    const right = new RegExp(`\\{\\{%${escapeRegex(key)}\\}\\}`);
    if (wrong.test(xml) && !right.test(xml)) {
      warnings.push(
        `사진 «${key}»: Word에 {{%${key}}} 를 넣어 주세요. {{${key}}} 로 넣으면 사진이 아니라 코드 글자가 나옵니다.`,
      );
    }
  }
  return warnings;
}
