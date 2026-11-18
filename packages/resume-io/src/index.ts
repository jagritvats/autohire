/// <reference path="./pdf-parse.d.ts" />
// (the reference makes the lib-subpath declaration travel with this module when other
// packages compile it from source — e.g. the worker via @jobflow/service)
import { strFromU8, unzipSync } from "fflate";
import {
  jsonResumeToDraft,
  latexResumeToText,
  linkedinToDraft,
  parseResume,
  type ResumeDraft,
  type ResumeFormat,
} from "@jobflow/core";
import { docxToText } from "./docx.js";

export { docxToText, wordXmlToLines, decodeXmlEntities, parseRels } from "./docx.js";

/**
 * Résumé file bytes → text (§ onboarding). Binary formats (PDF, DOCX, ZIP) live here so
 * `@jobflow/core` stays dependency-free and the worker never loads a PDF library. The
 * text goes to core's deterministic parser; nothing here interprets content.
 */

/** Uploads larger than this are refused before any parsing. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
/** Unzipped size cap for DOCX / LinkedIn exports (zip-bomb guard). */
const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;
/** Below this many characters a PDF is almost certainly a scan (image-only). */
export const SCANNED_PDF_MIN_CHARS = 200;
export const SCANNED_PDF_WARNING = "This PDF has almost no text — it looks scanned; paste the text instead.";

export type ResumeIoErrorCode = "too_large" | "unsupported" | "unreadable" | "empty";

/** A file we can't import, with a message fit for the upload form. */
export class ResumeIoError extends Error {
  readonly code: ResumeIoErrorCode;
  constructor(code: ResumeIoErrorCode, message: string) {
    super(message);
    this.name = "ResumeIoError";
    this.code = code;
  }
}

export interface ResumeFileInput {
  filename?: string;
  mime?: string;
  bytes: Uint8Array;
}

export interface ExtractedResume {
  format: ResumeFormat;
  /** plain text for the parser (empty for JSON Resume / LinkedIn, which are structured) */
  text: string;
  /** original .tex source */
  latex?: string;
  /** parsed JSON Resume */
  json?: unknown;
  /** LinkedIn export CSVs */
  csvs?: Array<{ name: string; text: string }>;
  warnings: string[];
}

const LINKEDIN_CSV = /(^|\/)(positions|profile|skills|email addresses|projects|education)\.csv$/i;

function ext(filename = ""): string {
  return /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? "";
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** Bytes → string: UTF-8 (BOM stripped) or UTF-16 with a BOM. */
export function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

/** Names of the entries in a zip (nothing is decompressed). */
function zipEntries(bytes: Uint8Array): string[] {
  const names: string[] = [];
  try {
    unzipSync(bytes, {
      filter: (f) => {
        names.push(f.name);
        return false;
      },
    });
  } catch {
    return [];
  }
  return names;
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function isJsonResume(text: string): unknown | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const j = JSON.parse(t) as unknown;
    return j && typeof j === "object" && ("basics" in j || "work" in j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * Sniff the format from the CONTENT first (magic bytes, structure) and only then the
 * extension — a .txt that is really a PDF, or a .pdf that is really LaTeX, imports as what
 * it is. Null when it's nothing we can read (images, legacy .doc, random zips).
 */
export function detectFormat(input: ResumeFileInput): ResumeFormat | null {
  const { bytes } = input;
  const e = ext(input.filename);
  let lead = 0;
  while (lead < 1024 && lead < bytes.length && (bytes[lead] === 0x20 || bytes[lead] === 0x0a || bytes[lead] === 0x0d || bytes[lead] === 0x09)) lead++;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46], lead)) return "pdf"; // %PDF
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const names = zipEntries(bytes);
    if (names.includes("word/document.xml")) return "docx";
    if (names.some((n) => LINKEDIN_CSV.test(n))) return "linkedin";
    return null;
  }
  if (looksBinary(bytes)) return null;
  const text = decodeText(bytes.subarray(0, Math.min(bytes.length, 2 * 1024 * 1024)));
  if (isJsonResume(text)) return "json_resume";
  if (/\\documentclass|\\begin\{document\}/.test(text)) return "latex";
  if (e === "csv" || /csv/i.test(input.mime ?? "")) {
    return /^﻿?\s*"?(Company Name|First Name|Name)"?\s*,/i.test(text) || LINKEDIN_CSV.test(input.filename ?? "") ? "linkedin" : "text";
  }
  if (e === "tex") return "latex";
  if (e === "json") return "json_resume";
  if (e === "md" || e === "markdown" || /markdown/i.test(input.mime ?? "")) return "markdown";
  // no telling extension: markdown when it has markdown headings or links
  if (/^#{1,3} \S/m.test(text) || /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(text)) return "markdown";
  return "text";
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
  // the lib path directly — the package index runs a debug shim that reads a test PDF
  const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
  // its own exact-size buffer: pdf.js 1.x can mis-read a view into a shared ArrayBuffer
  const own = bytes.slice();
  const parsed = await pdfParse(Buffer.from(own.buffer, 0, own.byteLength));
  return parsed.text ?? "";
}

/** Bytes → text (+ structured payloads) for the parser. Throws ResumeIoError. */
export async function extractResume(input: ResumeFileInput): Promise<ExtractedResume> {
  const { bytes } = input;
  if (bytes.byteLength > MAX_RESUME_BYTES) {
    throw new ResumeIoError("too_large", `That file is ${(bytes.byteLength / 1048576).toFixed(1)} MB — the limit is 10 MB.`);
  }
  if (bytes.byteLength === 0) throw new ResumeIoError("empty", "That file is empty.");
  const format = detectFormat(input);
  if (!format) {
    throw new ResumeIoError("unsupported", "Unsupported file. Upload a PDF, DOCX, .tex, .md, .txt, JSON Resume, or a LinkedIn export (or paste the text).");
  }
  const warnings: string[] = [];
  const e = ext(input.filename);
  const wrongExt =
    (format === "pdf" && e && e !== "pdf") ||
    (format === "docx" && e && e !== "docx") ||
    (format === "latex" && ["pdf", "docx"].includes(e));
  if (wrongExt) warnings.push(`The file is named .${e} but is really ${format === "latex" ? "LaTeX" : format.toUpperCase()} — imported it as that.`);

  try {
    switch (format) {
      case "pdf": {
        const text = (await pdfToText(bytes)).replace(/\r\n?/g, "\n").trim();
        if (text.replace(/\s+/g, "").length < SCANNED_PDF_MIN_CHARS) warnings.push(SCANNED_PDF_WARNING);
        return { format, text, warnings };
      }
      case "docx": {
        const text = docxToText(bytes);
        if (!text.trim()) warnings.push("The Word document has no text in it — paste the text instead.");
        return { format, text, warnings };
      }
      case "linkedin": {
        let csvs: Array<{ name: string; text: string }>;
        if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
          let total = 0;
          const files = unzipSync(bytes, {
            filter: (f) => {
              total += f.originalSize;
              return LINKEDIN_CSV.test(f.name) && total <= MAX_UNZIPPED_BYTES;
            },
          });
          if (total > MAX_UNZIPPED_BYTES) throw new ResumeIoError("too_large", "That export unpacks to more than 50 MB.");
          csvs = Object.entries(files).map(([name, data]) => ({ name: name.split("/").pop() ?? name, text: decodeText(data) }));
        } else {
          csvs = [{ name: input.filename || "Positions.csv", text: decodeText(bytes) }];
        }
        return { format, text: "", csvs, warnings };
      }
      case "json_resume": {
        const raw = decodeText(bytes);
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new ResumeIoError("unreadable", "That .json isn't valid JSON.");
        }
        return { format, text: "", json, warnings };
      }
      case "latex": {
        const latex = decodeText(bytes);
        return { format, text: latexResumeToText(latex), latex, warnings };
      }
      default:
        return { format, text: decodeText(bytes), warnings };
    }
  } catch (err) {
    if (err instanceof ResumeIoError) throw err;
    throw new ResumeIoError("unreadable", `Could not read the file: ${(err as Error).message}`);
  }
}

/**
 * A résumé file → a reviewable draft: `extractResume` then core's parser. Extraction
 * warnings (scanned PDF, wrong extension) lead the draft's own warnings.
 */
export async function importResumeFile(input: ResumeFileInput, opts: { now?: Date } = {}): Promise<ResumeDraft> {
  const x = await extractResume(input);
  let draft: ResumeDraft;
  if (x.format === "json_resume") draft = jsonResumeToDraft(x.json, { now: opts.now });
  else if (x.format === "linkedin") draft = linkedinToDraft(x.csvs ?? [], { now: opts.now });
  else draft = parseResume(x.latex ?? x.text, { format: x.format, latex: x.latex, now: opts.now });
  return { ...draft, warnings: [...x.warnings, ...draft.warnings] };
}

/** Pasted text → draft (format "paste"; Markdown/LaTeX/JSON pastes are recognised). */
export function importResumeText(text: string, opts: { now?: Date } = {}): ResumeDraft {
  const t = text.trim();
  if (isJsonResume(t)) return jsonResumeToDraft(JSON.parse(t), { now: opts.now });
  if (/\\documentclass|\\begin\{document\}/.test(t)) return parseResume(t, { format: "latex", latex: t, now: opts.now });
  if (/^#{1,3} \S/m.test(t) || /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(t)) {
    return { ...parseResume(t, { format: "markdown", now: opts.now }), format: "paste" };
  }
  return parseResume(t, { format: "paste", now: opts.now });
}
