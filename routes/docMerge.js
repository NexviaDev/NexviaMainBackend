import { Router } from "express";
import multer from "multer";
import JSZip from "jszip";
import { detectTemplateFormat, getFormatMeta, isSupportedTemplateFileName } from "../lib/docMergeFormats.js";
import { extractMergeFieldsFromDocx, sanitizeFileStem } from "../lib/docMergeFields.js";
import { mergeTemplateWithOptionalPdf } from "../lib/docMergeRun.js";
import { probeLibreOffice } from "../lib/libreOffice.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

const router = Router();
const IMAGE_DATA_URL_RE = /^data:image\/[\w+.-]+;base64,/i;

router.get("/health", async (_req, res) => {
  const libreOffice = await probeLibreOffice();
  res.json({
    ok: true,
    libreOffice,
    mergeEngine: "docxtemplater + hwpx-js",
    supportedFormats: ["docx", "pptx", "hwp", "hwpx"],
    placeholderSyntax: "{{필드명}} / {{%이미지필드}}",
  });
});

/** 양식 업로드 → 치환 필드 목록 (선택) */
router.post("/analyze", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file?.buffer?.length) {
    return res.status(400).json({ error: "missing_file", message: "양식 파일을 올려 주세요." });
  }
  if (!isSupportedTemplateFileName(file.originalname)) {
    return res.status(400).json({
      error: "invalid_type",
      message: "지원 형식: Word(.docx), PowerPoint(.pptx), 한글(.hwp, .hwpx)",
    });
  }
  try {
    const format = detectTemplateFormat(file.originalname, file.buffer);
    const fields = format === "docx" || format === "pptx" ? extractMergeFieldsFromDocx(file.buffer) : [];
    return res.json({
      fileName: file.originalname,
      format,
      fields,
      fieldCount: fields.length,
    });
  } catch (err) {
    console.error("[doc-merge analyze]", err);
    return res.status(400).json({
      error: "analyze_failed",
      message: "문서를 읽지 못했습니다. 손상된 파일이 아닌지 확인해 주세요.",
    });
  }
});

function parseRows(body) {
  const rows = body?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("rows_required");
  }
  return rows.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw new Error(`invalid_row_${i}`);
    }
    return r;
  });
}

function readTemplateBuffer(body) {
  const b64 = body?.templateBase64;
  if (!b64 || typeof b64 !== "string") throw new Error("template_required");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("template_empty");
  return buf;
}

function normalizeImageFieldKey(raw) {
  return String(raw || "")
    .trim()
    .replace(/^\{\{%?/, "")
    .replace(/^\{%/, "")
    .replace(/\}\}$/, "")
    .replace(/\%$/, "")
    .replace(/\s+/g, "");
}

function readImageFieldKeys(body, rows = []) {
  const raw = body?.imageFields;
  const keys = new Set();

  if (Array.isArray(raw)) {
    for (const key of raw) {
      const normalized = normalizeImageFieldKey(key);
      if (normalized) keys.add(normalized);
    }
  }

  for (const row of rows) {
    for (const [key, value] of Object.entries(row || {})) {
      if (typeof value === "string" && IMAGE_DATA_URL_RE.test(value)) {
        const normalized = normalizeImageFieldKey(key);
        if (normalized) keys.add(normalized);
      }
    }
  }

  return [...keys];
}

function addNormalizedImageAliases(rows) {
  return rows.map((row) => {
    const next = { ...row };
    for (const [key, value] of Object.entries(row || {})) {
      if (typeof value !== "string" || !IMAGE_DATA_URL_RE.test(value)) continue;
      const normalized = normalizeImageFieldKey(key);
      if (normalized && normalized !== key && next[normalized] == null) {
        next[normalized] = value;
      }
    }
    return next;
  });
}

function readTemplateFormat(body, fileName, buffer) {
  const raw = String(body?.templateFormat || "").trim().toLowerCase();
  if (["docx", "pptx", "hwp", "hwpx"].includes(raw)) return raw;
  return detectTemplateFormat(fileName || "", buffer);
}

function mergeErrorMessage(err) {
  const tplErr = err?.properties?.errors?.[0];
  return (
    tplErr?.properties?.explanation ||
    tplErr?.message ||
    (err?.properties?.id === "multi_error" ? "양식의 {{ }} 태그 형식을 확인해 주세요." : null) ||
    err?.message ||
    "문서 생성에 실패했습니다."
  );
}

/** 단일 행 → DOCX/PPTX/HWP */
router.post("/run", async (req, res) => {
  try {
    const templateBuffer = readTemplateBuffer(req.body);
    const rows = addNormalizedImageAliases(parseRows(req.body));
    const imageFieldKeys = readImageFieldKeys(req.body, rows);
    if (rows.length !== 1) {
      return res.status(400).json({
        error: "single_row_only",
        message: "단일 생성은 rows 배열에 1개만 넣어 주세요.",
      });
    }
    const wantPdf = Boolean(req.body?.exportPdf);
    const row = rows[0];
    const templateFormat = readTemplateFormat(
      req.body,
      req.body?.templateFileName || req.body?.fileName,
      templateBuffer,
    );
    const stem = sanitizeFileStem(req.body?.fileName || row.fileLabel || row.companyName, "merged");
    const { buffer, outputFormat, mime, ext, pdf, pdfSkippedReason } = await mergeTemplateWithOptionalPdf(
      templateBuffer,
      row,
      { format: templateFormat, wantPdf, imageFieldKeys },
    );

    if (wantPdf && pdf?.length) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(stem)}.pdf"`);
      return res.send(pdf);
    }

    if (wantPdf && pdfSkippedReason === "libreoffice_unavailable") {
      res.setHeader("X-Merge-Pdf-Skipped", "libreoffice_unavailable");
    }

    res.setHeader("Content-Type", mime || getFormatMeta(outputFormat).mime);
    res.setHeader("X-Merge-Output-Format", outputFormat);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(stem)}.${ext}"`);
    return res.send(buffer);
  } catch (err) {
    const code = err?.message || "run_failed";
    if (code === "rows_required" || code === "template_required" || code === "template_empty") {
      return res.status(400).json({ error: code, message: "양식과 데이터 행을 확인해 주세요." });
    }
    if (String(code).startsWith("invalid_row")) {
      return res.status(400).json({ error: code, message: "데이터 행 형식이 올바르지 않습니다." });
    }
    if (code === "hwp_needs_libreoffice") {
      return res.status(400).json({
        error: code,
        message:
          ".hwp 양식은 서버에 LibreOffice가 필요합니다. .hwpx 로 저장한 양식을 사용하거나 LibreOffice를 설치해 주세요.",
      });
    }
    if (code === "hwpx_image_slot_required") {
      return res.status(400).json({
        error: code,
        message:
          "한글(HWPX) 사진은 양식에 한컴에서 직접 넣은 더미 이미지가 필요합니다. 사진 위치에 더미 이미지를 넣고 저장한 .hwpx 양식을 다시 등록해 주세요.",
      });
    }
    console.error("[doc-merge run]", err);
    return res.status(500).json({ error: "merge_failed", message: mergeErrorMessage(err) });
  }
});

/** 여러 행 → ZIP */
router.post("/run-batch", async (req, res) => {
  try {
    const templateBuffer = readTemplateBuffer(req.body);
    const rows = addNormalizedImageAliases(parseRows(req.body));
    const imageFieldKeys = readImageFieldKeys(req.body, rows);
    const wantPdf = Boolean(req.body?.exportPdf);
    const lo = wantPdf ? await probeLibreOffice() : false;
    const baseStem = sanitizeFileStem(req.body?.zipName || "documents", "documents");
    const templateFormat = readTemplateFormat(req.body, req.body?.templateFileName, templateBuffer);

    const zip = new JSZip();
    const used = new Map();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const stem = sanitizeFileStem(`document_${i + 1}`, `document_${i + 1}`);
      let fname = stem;
      const n = (used.get(stem) || 0) + 1;
      used.set(stem, n);
      if (n > 1) fname = `${stem}_${n}`;

      const { buffer, ext, pdf } = await mergeTemplateWithOptionalPdf(templateBuffer, row, {
        format: templateFormat,
        wantPdf: wantPdf && lo,
        imageFieldKeys,
      });
      if (wantPdf && lo && pdf?.length) {
        zip.file(`${fname}.pdf`, pdf);
      } else {
        zip.file(`${fname}.${ext}`, buffer);
      }
    }

    const zipBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(baseStem)}.zip"`);
    return res.send(zipBuffer);
  } catch (err) {
    const code = err?.message || "batch_failed";
    if (code === "rows_required" || code === "template_required") {
      return res.status(400).json({ error: code, message: "양식과 데이터 행을 확인해 주세요." });
    }
    if (code === "hwpx_image_slot_required") {
      return res.status(400).json({
        error: code,
        message:
          "한글(HWPX) 사진은 양식에 한컴에서 직접 넣은 더미 이미지가 필요합니다. 사진 위치에 더미 이미지를 넣고 저장한 .hwpx 양식을 다시 등록해 주세요.",
      });
    }
    console.error("[doc-merge run-batch]", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "batch_failed", message: mergeErrorMessage(err) });
    }
  }
});

export default router;
