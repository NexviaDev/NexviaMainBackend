import Docxtemplater from "docxtemplater";
import ImageModule from "docxtemplater-image";
import sizeOf from "image-size";
import PizZip from "pizzip";
import { prepareTemplateForMerge } from "./docMergeFields.js";
import { getFormatMeta } from "./docMergeFormats.js";
import { mergeHwpBufferAsync } from "./hwpMerge.js";
import {
  convertBufferWithLibreOffice,
  convertDocxToPdfWithLibreOffice,
  isLibreOfficeAvailable,
} from "./libreOffice.js";

const IMAGE_DATA_URL_RE = /^data:image\/[\w+.-]+;base64,/i;

function dataUrlToBuffer(dataUrl) {
  if (!IMAGE_DATA_URL_RE.test(String(dataUrl || ""))) return null;
  const base64 = String(dataUrl).replace(/^data:image\/[\w+.-]+;base64,/i, "");
  return Buffer.from(base64, "base64");
}

function createImageModule(fileType) {
  return new ImageModule({
    centered: false,
    fileType,
    getImage(tagValue) {
      if (!tagValue) return null;
      if (IMAGE_DATA_URL_RE.test(tagValue)) {
        return dataUrlToBuffer(tagValue);
      }
      if (Buffer.isBuffer(tagValue)) return tagValue;
      return null;
    },
    getSize(img, _tagValue, tagName) {
      const maxW = fileType === "pptx" ? 480 : 420;
      if (!img?.length) return [120, 120];
      try {
        const dim = sizeOf(img);
        if (!dim.width || !dim.height) return [maxW, Math.round(maxW * 0.65)];
        if (dim.width <= maxW) return [dim.width, dim.height];
        const ratio = maxW / dim.width;
        return [maxW, Math.round(dim.height * ratio)];
      } catch {
        return [320, 240];
      }
    },
  });
}

function normalizeMergeRow(row, imageFieldKeys = []) {
  const imageKeySet = new Set(imageFieldKeys);
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (key === "fileLabel" || key.startsWith("_")) continue;
    if (value == null || value === "") {
      out[key] = "";
      continue;
    }
    if (typeof value === "string" && IMAGE_DATA_URL_RE.test(value)) {
      if (imageKeySet.has(key)) out[key] = value;
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

function mergeOfficeBuffer(templateBuffer, row, { format = "docx", imageFieldKeys = [] } = {}) {
  const prepared = prepareTemplateForMerge(templateBuffer, imageFieldKeys, format);
  const zip = new PizZip(prepared);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
    modules: [createImageModule(format === "pptx" ? "pptx" : "docx")],
  });
  doc.render(normalizeMergeRow(row, imageFieldKeys));
  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
}

/** 단일 행 데이터로 DOCX/PPTX/HWP 병합 */
export async function mergeTemplateBuffer(templateBuffer, row, { format = "docx", imageFieldKeys = [] } = {}) {
  if (format === "hwp" || format === "hwpx") {
    return mergeHwpBufferAsync(templateBuffer, row, { imageFieldKeys, format });
  }
  return mergeOfficeBuffer(templateBuffer, row, { format, imageFieldKeys });
}

/** @deprecated */
export function mergeDocxBuffer(templateBuffer, row, opts = {}) {
  return mergeOfficeBuffer(templateBuffer, row, { ...opts, format: "docx" });
}

export async function mergeTemplateWithOptionalPdf(
  templateBuffer,
  row,
  { format = "docx", wantPdf = false, imageFieldKeys = [] } = {},
) {
  let outputBuffer = await mergeTemplateBuffer(templateBuffer, row, { format, imageFieldKeys });
  let outputFormat = format;

  if (format === "hwp" && isLibreOfficeAvailable()) {
    try {
      outputBuffer = await convertBufferWithLibreOffice(outputBuffer, "hwpx", "hwp");
      outputFormat = "hwp";
    } catch {
      outputFormat = "hwpx";
    }
  } else if (format === "hwp") {
    outputFormat = "hwpx";
  }

  const meta = getFormatMeta(outputFormat);

  if (!wantPdf) {
    return {
      buffer: outputBuffer,
      outputFormat,
      mime: meta.mime,
      ext: meta.ext,
      pdf: null,
      pdfSkippedReason: null,
    };
  }

  if (!isLibreOfficeAvailable()) {
    return {
      buffer: outputBuffer,
      outputFormat,
      mime: meta.mime,
      ext: meta.ext,
      pdf: null,
      pdfSkippedReason: "libreoffice_unavailable",
    };
  }

  let pdfSource = outputBuffer;
  let pdfFromExt = outputFormat;
  if (outputFormat === "pptx") {
    pdfSource = outputBuffer;
    pdfFromExt = "pptx";
  } else if (outputFormat === "hwp" || outputFormat === "hwpx") {
    pdfSource = await convertBufferWithLibreOffice(outputBuffer, outputFormat === "hwp" ? "hwp" : "hwpx", "pdf");
    pdfFromExt = "pdf";
  }

  const pdf =
    pdfFromExt === "pdf"
      ? pdfSource
      : outputFormat === "docx"
        ? await convertDocxToPdfWithLibreOffice(pdfSource)
        : await convertBufferWithLibreOffice(pdfSource, outputFormat, "pdf");

  return {
    buffer: outputBuffer,
    outputFormat,
    mime: meta.mime,
    ext: meta.ext,
    pdf,
    pdfSkippedReason: null,
  };
}

/** @deprecated */
export async function mergeDocxWithOptionalPdf(templateBuffer, row, opts = {}) {
  const result = await mergeTemplateWithOptionalPdf(templateBuffer, row, {
    ...opts,
    format: "docx",
  });
  return { docx: result.buffer, pdf: result.pdf, pdfSkippedReason: result.pdfSkippedReason };
}
