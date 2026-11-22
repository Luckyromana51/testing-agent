import { inflateSync } from "node:zlib";
import { strFromU8, unzipSync } from "fflate";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, Severity } from "../../types.js";
import type { SiteAgent, SiteContext } from "../types.js";

/**
 * Accessibility of the documents a site offers (PDF, Word, PowerPoint, Excel). The European
 * Accessibility Act (in force since June 2025), EN 301 549 chapter 10, India's GIGW 3.0 and IS 17802
 * all cover downloadable documents, not only web pages. PDFs are checked against what PDF/UA
 * (ISO 14289) needs; veraPDF (a tool tab) does the full PDF/UA rule set.
 */

export const DOC_LINK = /\.(pdf|docx|pptx|xlsx)(?:[?#]|$)/i;
const MAX_DOCS = 15;
const MAX_BYTES = 25_000_000;

export interface DocProblem {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
}

/** The text a PDF holds: its raw bytes plus every Flate stream unpacked (object streams hide the catalogue). */
export function pdfText(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  const parts = [raw];
  let at = 0;
  for (let i = 0; i < 4000; i++) {
    const s = raw.indexOf("stream", at);
    if (s < 0) break;
    const dict = raw.slice(Math.max(0, s - 400), s);
    let start = s + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const e = raw.indexOf("endstream", start);
    if (e < 0) break;
    at = e + 9;
    if (!/FlateDecode/.test(dict.slice(dict.lastIndexOf("<<")))) continue;
    if (/\/Subtype\s*\/Image/.test(dict.slice(dict.lastIndexOf("<<")))) continue;
    try {
      parts.push(inflateSync(bytes.subarray(start, e)).toString("latin1"));
    } catch {
      // Not a stream we can read; skip it.
    }
  }
  return parts.join("\n");
}

/** What a PDF is missing for accessibility. Pure, for tests. */
export function pdfProblems(bytes: Buffer): DocProblem[] {
  const out: DocProblem[] = [];
  if (!bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) return [{ rule: "doc:not-pdf", severity: "low", title: "The .pdf link is not a PDF", detail: "The address ends in .pdf but the file is something else (often an error page). Fix the link." }];
  const text = pdfText(bytes);
  if (/\/Encrypt\b/.test(text) && !/\/StructTreeRoot/.test(text)) {
    out.push({ rule: "doc:pdf-locked", severity: "medium", title: "PDF is locked against copying", detail: "Encryption that blocks copying text can also block screen readers. Save it without restrictions, or allow accessibility access (permission bit 10)." });
  }
  const tagged = /\/StructTreeRoot/.test(text) && /\/Marked\s+true/.test(text);
  if (!tagged) out.push({ rule: "doc:pdf-untagged", severity: "high", title: "PDF is not tagged", detail: "An untagged PDF has no headings, lists, tables or reading order for screen readers (PDF/UA, WCAG 1.3.1, EN 301 549 10.1.3.1). Export it from Word or InDesign with \"Create tagged PDF\" on, or fix it in Acrobat's Accessibility tool." });
  const fonts = /\/Font\b/.test(text);
  const images = /\/Subtype\s*\/Image/.test(bytes.toString("latin1"));
  if (!fonts && images) out.push({ rule: "doc:pdf-scanned", severity: "high", title: "PDF is a scanned image with no text", detail: "It has pictures of pages but no real text, so screen readers read nothing and search finds nothing. Publish the original document, or run OCR and tag the result." });
  if (!/\/Lang\s*\(/.test(text)) out.push({ rule: "doc:pdf-no-language", severity: "medium", title: "PDF does not say its language", detail: "Without /Lang, screen readers guess the language and may read Hindi or English with the wrong voice (WCAG 3.1.1). Set the language in the document's properties before exporting." });
  const hasTitle = /\/Title\s*\((?!\s*\))/.test(text) || /<dc:title>[\s\S]*?<rdf:li[^>]*>[^<\s][\s\S]*?<\/rdf:li>/.test(text) || /\/Title\s*<(?!\s*>)/.test(text);
  if (!hasTitle) out.push({ rule: "doc:pdf-no-title", severity: "low", title: "PDF has no title", detail: "Screen readers announce the file name instead (WCAG 2.4.2). Set a title in the document's properties." });
  else if (!/\/DisplayDocTitle\s+true/.test(text)) out.push({ rule: "doc:pdf-title-hidden", severity: "low", title: "PDF shows its file name, not its title", detail: "Set \"Show document title\" in the initial view (DisplayDocTitle), as PDF/UA asks." });
  if (tagged) {
    const figures = (text.match(/\/S\s*\/Figure\b/g) ?? []).length;
    const alts = (text.match(/\/Alt\s*[(<]/g) ?? []).length;
    if (figures > 0 && alts < figures) out.push({ rule: "doc:pdf-figure-no-alt", severity: "high", title: `${figures - alts} of ${figures} pictures in the PDF have no alt text`, detail: "Tagged figures need alternative text (WCAG 1.1.1). Add it in Word before exporting, or in Acrobat's Reading Order tool." });
    if (!/pdfuaid:part/.test(text)) out.push({ rule: "doc:pdf-not-pdfua", severity: "info", title: "PDF does not claim PDF/UA", detail: "Tagged, but it does not declare PDF/UA conformance. Run the veraPDF tab to check every PDF/UA rule." });
  }
  return out;
}

const xml = (files: Record<string, Uint8Array>, name: string) => (files[name] ? strFromU8(files[name]) : "");

/** What a Word, PowerPoint or Excel file is missing for accessibility. Pure, for tests. */
export function officeProblems(bytes: Uint8Array, ext: string): DocProblem[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => /\.xml$/.test(f.name) && f.originalSize < 20_000_000 });
  } catch {
    return [{ rule: "doc:office-broken", severity: "low", title: `The .${ext} file cannot be opened`, detail: "The file is damaged or is not really an Office file. Fix the link." }];
  }
  const out: DocProblem[] = [];
  const core = xml(files, "docProps/core.xml");
  if (!/<dc:title>\s*[^<\s]/.test(core)) out.push({ rule: "doc:office-no-title", severity: "low", title: `The ${ext.toUpperCase()} file has no title`, detail: "Set a title in File > Info > Properties, so screen readers announce it (WCAG 2.4.2)." });
  let pics = 0;
  let noAlt = 0;
  const count = (body: string) => {
    for (const m of body.matchAll(/<(?:wp:docPr|p:cNvPr|xdr:cNvPr)\b([^>]*)>/g)) {
      const attrs = m[1];
      // Shapes that only draw lines or text boxes are not pictures.
      if (/\btitle="|descr="\s*[^"\s]/.test(attrs)) {
        pics++;
        continue;
      }
      pics++;
      noAlt++;
    }
  };
  if (ext === "docx") {
    const doc = xml(files, "word/document.xml");
    count(doc);
    const styles = xml(files, "word/styles.xml");
    if (doc.length > 5000 && !/w:pStyle w:val="(Heading|heading|Title)\d*"/.test(doc)) out.push({ rule: "doc:docx-no-headings", severity: "medium", title: "The Word file uses no headings", detail: "Big bold text is not a heading for screen readers. Use the Heading 1, Heading 2 styles so people can jump between sections (WCAG 1.3.1)." });
    if (!/w:lang w:val="/.test(styles + doc)) out.push({ rule: "doc:office-no-language", severity: "low", title: "The Word file does not set its language", detail: "Set the language (Review > Language) so screen readers use the right voice (WCAG 3.1.1)." });
  } else if (ext === "pptx") {
    const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    let untitled = 0;
    for (const s of slides) {
      const body = xml(files, s);
      for (const pic of body.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)) count(pic[0]);
      if (!/<p:ph type="(title|ctrTitle)"/.test(body)) untitled++;
    }
    if (untitled) out.push({ rule: "doc:pptx-untitled-slides", severity: "medium", title: `${untitled} of ${slides.length} slides have no title`, detail: "Screen-reader users move through a deck by slide titles. Give every slide a title (it can be hidden off the slide)." });
  } else if (ext === "xlsx") {
    for (const n of Object.keys(files).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))) count(xml(files, n));
    const wb = xml(files, "xl/workbook.xml");
    if (/<sheet name="Sheet\d+"/.test(wb)) out.push({ rule: "doc:xlsx-default-sheet-names", severity: "low", title: "Sheets are still called Sheet1, Sheet2", detail: "Give each sheet a name that says what it holds, so people can find the right one." });
  }
  if (noAlt) out.push({ rule: "doc:office-image-no-alt", severity: "high", title: `${noAlt} of ${pics} pictures have no alt text`, detail: "Right-click each picture > View Alt Text and describe it, or mark it as decorative (WCAG 1.1.1). Office's Check Accessibility lists them." });
  return out;
}

async function documentFindings({ browser, linkSources, origin, log, site }: SiteContext): Promise<Finding[]> {
  const host = new URL(origin).hostname.replace(/^www\./, "");
  const docs = [...linkSources.keys()].filter((u) => {
    try {
      return DOC_LINK.test(new URL(u).pathname) && new URL(u).hostname.replace(/^www\./, "") === host;
    } catch {
      return false;
    }
  });
  if (!docs.length) return [];
  const out: Finding[] = [];
  let read = 0;
  for (const url of docs.slice(0, MAX_DOCS)) {
    site.signal?.throwIfAborted();
    const ext = new URL(url).pathname.match(DOC_LINK)![1].toLowerCase();
    let bytes: Buffer;
    try {
      const res = await browser.request.get(url, { timeout: 60_000, maxRedirects: 3 });
      if (res.status() >= 400 || Number(res.headers()["content-length"] ?? 0) > MAX_BYTES) continue;
      bytes = await res.body();
    } catch {
      continue;
    }
    read++;
    const problems = ext === "pdf" ? pdfProblems(bytes) : officeProblems(bytes, ext);
    for (const p of problems) {
      out.push(finding({ category: "accessibility", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: url, evidence: `Linked from ${linkSources.get(url)}` }));
    }
  }
  log(`Documents: checked ${read} of ${docs.length} PDF and Office files`);
  if (docs.length > MAX_DOCS) {
    out.push(finding({ category: "accessibility", rule: "doc:more-not-checked", severity: "info", title: `${docs.length - MAX_DOCS} more documents were not checked`, detail: `The first ${MAX_DOCS} documents were checked. Run veraPDF from its tab for the rest, or test the document library as its own project.`, pageUrl: origin }));
  }
  return out;
}

export const documentsAgent: SiteAgent = {
  id: "a11y.documents",
  name: "PDF and document accessibility",
  description:
    "Downloads the PDF, Word, PowerPoint and Excel files the site links to and checks they are accessible: tagged PDF, real text not a scan, language, title, alt text on pictures, headings and slide titles (European Accessibility Act, EN 301 549, GIGW 3.0, IS 17802).",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run: documentFindings,
};
