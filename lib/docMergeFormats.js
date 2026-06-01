import { utils as hwpxUtils } from "hwpx-js";

/** @typedef {'docx'|'pptx'|'hwp'|'hwpx'} TemplateFormat */

export const TEMPLATE_FORMATS = {
  docx: {
    ext: "docx",
    label: "Word",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  pptx: {
    ext: "pptx",
    label: "PowerPoint",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  hwp: {
    ext: "hwp",
    label: "한글",
    mime: "application/x-hwp",
  },
  hwpx: {
    ext: "hwpx",
    label: "한글(HWPX)",
    mime: "application/hwp+zip",
  },
};

export function detectTemplateFormat(fileName, buffer) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".pptx")) return "pptx";
  if (lower.endsWith(".hwpx")) return "hwpx";
  if (lower.endsWith(".hwp")) return "hwp";
  if (lower.endsWith(".docx")) return "docx";

  if (buffer?.length >= 4) {
    const head = buffer.subarray(0, 4);
    if (head[0] === 0x50 && head[1] === 0x4b) {
      const ct = buffer.toString("utf8", 0, Math.min(buffer.length, 4096));
      if (ct.includes("presentationml")) return "pptx";
      if (ct.includes("wordprocessingml")) return "docx";
      if (ct.includes("hwpx") || ct.includes("Contents/content.hpf")) return "hwpx";
    }
    if (head[0] === 0xd0 && head[1] === 0xcf) return "hwp";
  }

  try {
    const fmt = hwpxUtils.detectFormat(new Uint8Array(buffer));
    if (fmt === "hwp5") return "hwp";
    if (fmt === "hwpx") return "hwpx";
  } catch {
    /* ignore */
  }

  return "docx";
}

export function getFormatMeta(format) {
  return TEMPLATE_FORMATS[format] || TEMPLATE_FORMATS.docx;
}

export function isSupportedTemplateFileName(fileName) {
  const lower = String(fileName || "").toLowerCase();
  return [".docx", ".pptx", ".hwp", ".hwpx"].some((ext) => lower.endsWith(ext));
}
