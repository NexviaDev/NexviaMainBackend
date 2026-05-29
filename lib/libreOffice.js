import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LO_BIN =
  process.env.LIBREOFFICE_PATH ||
  process.env.SOFFICE_PATH ||
  (process.platform === "win32" ? "soffice.exe" : "soffice");

let loChecked = false;
let loAvailable = false;

/** 서버에 LibreOffice(soffice) 설치 여부 — PDF 변환·고급 머지용 */
export function isLibreOfficeAvailable() {
  return loAvailable;
}

export async function probeLibreOffice() {
  if (loChecked) return loAvailable;
  loChecked = true;
  try {
    await execFileAsync(LO_BIN, ["--version"], { timeout: 8000 });
    loAvailable = true;
  } catch {
    loAvailable = false;
  }
  return loAvailable;
}

export async function convertBufferWithLibreOffice(inputBuffer, inputExt, outputExt) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nx-merge-"));
  const safeIn = `input.${inputExt.replace(/^\./, "")}`;
  const inPath = path.join(tmp, safeIn);
  const outDir = path.join(tmp, "out");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(inPath, inputBuffer);

  try {
    await execFileAsync(
      LO_BIN,
      [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to",
        outputExt.replace(/^\./, ""),
        "--outdir",
        outDir,
        inPath,
      ],
      { timeout: 120_000 },
    );
    const base = path.basename(inPath, path.extname(inPath));
    const outPath = path.join(outDir, `${base}.${outputExt.replace(/^\./, "")}`);
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function convertDocxToPdfWithLibreOffice(docxBuffer) {
  return convertBufferWithLibreOffice(docxBuffer, "docx", "pdf");
}
