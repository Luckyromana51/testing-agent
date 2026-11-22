import type { APIRequestContext } from "playwright";
import { finding } from "../../runner/finding.js";
import { PUBLIC_WEB_PRODUCTS, WEB_PRODUCTS } from "../../products.js";
import type { Finding, Severity } from "../../types.js";
import type { SiteAgent, SiteContext } from "../types.js";

/** Reads a small text file from the site; null when it cannot be reached. */
export async function getText(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string> = {},
  maxBytes = 512_000,
): Promise<{ status: number; type: string; text: string; url: string; headers: Record<string, string> } | null> {
  try {
    const res = await request.get(url, { timeout: 15_000, maxRedirects: 3, headers });
    const type = res.headers()["content-type"] ?? "";
    const length = Number(res.headers()["content-length"] ?? 0);
    const text = length > maxBytes ? "" : (await res.text()).slice(0, maxBytes);
    return { status: res.status(), type, text, url: res.url(), headers: res.headers() };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// security.txt (RFC 9116): how to report a security hole

export interface SecurityTxt {
  fields: Record<string, string[]>;
  signed: boolean;
}

export function parseSecurityTxt(text: string): SecurityTxt {
  const signed = /-----BEGIN PGP SIGNED MESSAGE-----/.test(text);
  const fields: Record<string, string[]> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-----") || /^Hash:/i.test(line)) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    (fields[m[1].toLowerCase()] ??= []).push(m[2].trim());
  }
  return { fields, signed };
}

/** What is wrong with a security.txt file, as [rule, severity, title, detail]. Pure, for tests. */
export function securityTxtProblems(text: string, servedOver: string, type: string, now = new Date()): [string, Severity, string, string][] {
  const out: [string, Severity, string, string][] = [];
  const { fields } = parseSecurityTxt(text);
  if (!fields.contact?.length) {
    out.push(["sec:security-txt-no-contact", "medium", "security.txt has no Contact line", "RFC 9116 needs at least one Contact: line (mailto:security@… or an https:// form) so researchers can report a hole to you."]);
  } else if (!fields.contact.some((c) => /^(mailto:|https:\/\/|tel:)/i.test(c))) {
    out.push(["sec:security-txt-bad-contact", "low", "security.txt Contact is not a link", "Each Contact must be a URI: mailto:security@example.com, https://example.com/report or tel:+91…"]);
  }
  const expires = fields.expires?.[0];
  if (!expires) {
    out.push(["sec:security-txt-no-expires", "low", "security.txt has no Expires date", "RFC 9116 needs an Expires: line (for example Expires: 2027-11-30T23:59:59Z), at most a year ahead, so stale contacts are not trusted."]);
  } else {
    const at = Date.parse(expires);
    if (Number.isNaN(at)) out.push(["sec:security-txt-bad-expires", "low", "security.txt Expires is not a date", `"${expires}" is not an ISO date like 2027-11-30T23:59:59Z.`]);
    else if (at < now.getTime()) out.push(["sec:security-txt-expired", "medium", "security.txt has expired", `It expired on ${new Date(at).toDateString()}: researchers are told not to trust it. Update the contacts and the Expires date.`]);
    else if (at - now.getTime() > 400 * 86_400_000) out.push(["sec:security-txt-far-expires", "low", "security.txt expires more than a year ahead", "RFC 9116 recommends an Expires date less than a year away, so the file is reviewed every year."]);
  }
  if (!/^https:/.test(servedOver)) out.push(["sec:security-txt-not-https", "low", "security.txt is not served over HTTPS", "RFC 9116 requires HTTPS so nobody can swap the contact details."]);
  if (type && !/text\/plain/i.test(type)) out.push(["sec:security-txt-type", "low", "security.txt is not plain text", `It is served as ${type}; serve it as text/plain; charset=utf-8.`]);
  if (!fields.policy?.length) out.push(["sec:security-txt-no-policy", "info", "security.txt has no Policy link", "A Policy: link to your vulnerability disclosure policy tells researchers what they may test and how you will respond (expected under the EU Cyber Resilience Act)."]);
  return out;
}

async function securityTxtFindings({ browser, origin }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const wellKnown = `${origin}/.well-known/security.txt`;
  let got = await getText(browser.request, wellKnown);
  let at = wellKnown;
  const usable = (g: typeof got) => g && g.status === 200 && !/html/i.test(g.type) && /contact\s*:/i.test(g.text);
  if (!usable(got)) {
    const legacy = await getText(browser.request, `${origin}/security.txt`);
    if (usable(legacy)) {
      got = legacy;
      at = `${origin}/security.txt`;
      out.push(
        finding({ category: "security", rule: "sec:security-txt-legacy", severity: "low", title: "security.txt is only at the old address", detail: "Move it (or redirect) to /.well-known/security.txt, where RFC 9116 says scanners and researchers look.", pageUrl: at }),
      );
    }
  }
  if (!usable(got)) {
    if (got === null) throw new Error("The site could not be reached to read security.txt.");
    return [
      finding({
        category: "security",
        rule: "sec:no-security-txt",
        severity: "low",
        title: "No security.txt: no way to report a security hole",
        detail:
          "There is no /.well-known/security.txt. Researchers who find a hole have no safe way to tell you, so they may post it publicly instead. The EU Cyber Resilience Act (reporting from 11 Sept 2026) and India's CERT-In expect a clear disclosure contact. Add a two-line file with Contact and Expires.",
        pageUrl: wellKnown,
      }),
    ];
  }
  for (const [rule, severity, title, detail] of securityTxtProblems(got!.text, got!.url, got!.type)) {
    out.push(finding({ category: "security", rule, severity, title, detail, pageUrl: at, evidence: got!.text.slice(0, 400) }));
  }
  return out;
}

export const securityTxtAgent: SiteAgent = {
  id: "sec.security-txt",
  name: "security.txt and disclosure",
  description: "Checks /.well-known/security.txt (RFC 9116): a contact for reporting holes, a valid Expires date, HTTPS, plain text, and a disclosure policy (EU Cyber Resilience Act).",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run: securityTxtFindings,
};

// ---------------------------------------------------------------------------------------------
// GEO: readiness for AI search (ChatGPT, Claude, Perplexity, Google AI Overviews)

/** The AI crawlers that matter, with what blocking each one costs. */
export const AI_CRAWLERS: { token: string; owner: string; use: "search" | "training" | "user" }[] = [
  { token: "OAI-SearchBot", owner: "OpenAI (ChatGPT search)", use: "search" },
  { token: "ChatGPT-User", owner: "OpenAI (links a ChatGPT user opens)", use: "user" },
  { token: "GPTBot", owner: "OpenAI (training)", use: "training" },
  { token: "Claude-SearchBot", owner: "Anthropic (Claude search)", use: "search" },
  { token: "Claude-User", owner: "Anthropic (pages a Claude user asks for)", use: "user" },
  { token: "ClaudeBot", owner: "Anthropic (training)", use: "training" },
  { token: "PerplexityBot", owner: "Perplexity (search)", use: "search" },
  { token: "Perplexity-User", owner: "Perplexity (pages a user asks for)", use: "user" },
  { token: "Google-Extended", owner: "Google (Gemini and AI training)", use: "training" },
  { token: "Applebot-Extended", owner: "Apple (Apple Intelligence)", use: "training" },
  { token: "Bingbot", owner: "Microsoft (Bing and Copilot answers)", use: "search" },
  { token: "CCBot", owner: "Common Crawl (used by many AI models)", use: "training" },
  { token: "meta-externalagent", owner: "Meta AI", use: "training" },
];

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export function robotsGroups(robots: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let inRules = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!current || inRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        inRules = false;
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && current) {
      inRules = true;
      if (field === "disallow" && !value) continue;
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  return groups;
}

/** True when robots.txt keeps this crawler away from the address path (RFC 9309: its own group, else "*"; the longest rule wins). */
export function robotsBlocks(robots: string, token: string, path = "/"): boolean {
  const groups = robotsGroups(robots);
  const t = token.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && t.includes(a)));
  const use = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | undefined;
  for (const g of use) {
    for (const r of g.rules) {
      const pattern = new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
      if (!pattern.test(path)) continue;
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
  }
  return best ? !best.allow : false;
}

/** What is wrong with an llms.txt file (llmstxt.org): an H1 name, a short summary, and Markdown links. */
export function llmsTxtProblems(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0]?.startsWith("# ")) out.push("It does not start with a # heading naming the site or company.");
  if (!lines.some((l) => l.startsWith(">"))) out.push("There is no > summary line saying in one or two sentences what the site offers.");
  const links = text.match(/\[[^\]]+\]\((https?:\/\/|\/)[^)]+\)/g) ?? [];
  if (!links.length) out.push("There are no Markdown links ([Services](https://…)) to the pages AI assistants should read.");
  if (/<html|<body/i.test(text)) out.push("It is an HTML page, not a Markdown text file.");
  return out;
}

/** Facts read from a page's HTML for answer-readiness. Pure, for tests. */
export interface PageFacts {
  url: string;
  schemaTypes: string[];
  hasAuthor: boolean;
  hasDate: boolean;
  questionHeadings: number;
  textWords: number;
  hasOrgSameAs: boolean;
}

export function pageFacts(url: string, html: string): PageFacts {
  const types = new Set<string>();
  let sameAs = false;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const t of m[1].matchAll(/"@type"\s*:\s*(\[[^\]]*\]|"[^"]+")/g)) for (const one of t[1].matchAll(/"([^"]+)"/g)) types.add(one[1]);
    if (/"sameAs"\s*:/.test(m[1])) sameAs = true;
  }
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const headings = [...html.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi)].map((h) => h[1].replace(/<[^>]+>/g, "").trim());
  return {
    url,
    schemaTypes: [...types],
    hasAuthor: /"author"\s*:|rel=["']author|class=["'][^"']*\b(author|byline)\b|name=["']author["']/i.test(html),
    hasDate: /"date(Published|Modified)"\s*:|<time\b|article:(published|modified)_time/i.test(html),
    questionHeadings: headings.filter((h) => /\?\s*$|^(how|what|why|when|which|who|where|can|is|are|do|does|should)\b/i.test(h)).length,
    textWords: text.split(/\s+/).filter((w) => /\w/.test(w)).length,
    hasOrgSameAs: sameAs,
  };
}

async function geoFindings({ browser, origin, pages, log }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (rule: string, severity: Severity, title: string, detail: string, pageUrl: string, evidence?: string) =>
    out.push(finding({ category: "seo", rule, severity, title, detail, pageUrl, evidence }));

  // 1. Which AI crawlers robots.txt lets in.
  const robots = await getText(browser.request, `${origin}/robots.txt`);
  if (robots === null) throw new Error("The site could not be reached to read robots.txt.");
  const robotsText = robots.status === 200 && !/html/i.test(robots.type) ? robots.text : "";
  const blocked = AI_CRAWLERS.filter((c) => robotsText && robotsBlocks(robotsText, c.token));
  const blockedSearch = blocked.filter((c) => c.use !== "training");
  if (blockedSearch.length) {
    add(
      "geo:ai-search-blocked",
      "high",
      `robots.txt blocks ${blockedSearch.length} AI search crawler${blockedSearch.length === 1 ? "" : "s"}`,
      "These bots fetch pages to answer people's questions in ChatGPT search, Claude, Perplexity and Copilot, with a link to you. Blocked, the site cannot be cited in AI answers. Allow them unless this is on purpose (blocking training bots such as GPTBot or CCBot is a separate choice and does not stop AI search).",
      `${origin}/robots.txt`,
      blockedSearch.map((c) => `${c.token}: ${c.owner}`).join("\n"),
    );
  }
  const blockedTraining = blocked.filter((c) => c.use === "training");
  if (blockedTraining.length) {
    add(
      "geo:ai-training-blocked",
      "info",
      `robots.txt keeps ${blockedTraining.length} AI training crawler${blockedTraining.length === 1 ? "" : "s"} out`,
      "This is a business choice: it keeps your content out of future AI models, but those models will then know less about your brand. Make sure it is on purpose.",
      `${origin}/robots.txt`,
      blockedTraining.map((c) => `${c.token}: ${c.owner}`).join("\n"),
    );
  }

  // 2. The firewall may block AI bots even when robots.txt allows them (Cloudflare's "block AI bots").
  const home = await getText(browser.request, `${origin}/`);
  const asBot = await getText(browser.request, `${origin}/`, { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)" });
  if (home && asBot && home.status < 400 && asBot.status >= 400 && !blocked.some((c) => c.token === "OAI-SearchBot")) {
    add(
      "geo:ai-bot-firewall",
      "high",
      "The firewall turns AI search crawlers away",
      `The home page answers ${home.status} to a browser but ${asBot.status} to OpenAI's search crawler, although robots.txt allows it. A firewall or CDN setting ("block AI bots", bot fight mode) is stopping AI assistants from reading the site. Allow the verified AI search bots in the firewall.`,
      `${origin}/`,
      `Browser: ${home.status}\nOAI-SearchBot: ${asBot.status}`,
    );
  }

  // 3. llms.txt: a short Markdown guide for AI assistants.
  const llms = await getText(browser.request, `${origin}/llms.txt`);
  if (!llms || llms.status !== 200 || /html/i.test(llms.type)) {
    add(
      "geo:no-llms-txt",
      "low",
      "No llms.txt for AI assistants",
      "llms.txt (llmstxt.org) is a short Markdown file at the site's root that tells AI assistants what the business does and which pages to read. It is cheap to add and is read by AI coding and answer tools. Add a # name, a > one-line summary, and links to the key pages.",
      `${origin}/llms.txt`,
    );
  } else {
    const problems = llmsTxtProblems(llms.text);
    if (problems.length) add("geo:llms-txt-format", "low", "llms.txt does not follow the format", problems.join(" "), `${origin}/llms.txt`, llms.text.slice(0, 300));
  }

  // 4. Answer-ready content on the pages: schema, author, dates, question headings.
  const sample = pages.filter((p) => p.status !== null && p.status < 400).slice(0, 8);
  const facts: PageFacts[] = [];
  for (const p of sample) {
    const got = await getText(browser.request, p.url);
    if (got && got.status < 400 && /html/i.test(got.type)) facts.push(pageFacts(p.url, got.text));
  }
  if (!facts.length) {
    log("GEO: no page could be read for content checks");
    return out;
  }
  const first = facts[0];
  if (!facts.some((f) => f.schemaTypes.some((t) => /Organization|LocalBusiness|Corporation|Store|ProfessionalService/.test(t)))) {
    add(
      "geo:no-organization-schema",
      "medium",
      "No Organization schema: AI cannot be sure who you are",
      "AI answers name businesses they can identify. Add Organization (or LocalBusiness) JSON-LD on the home page with name, logo, address, phone and sameAs links to your Google Business, LinkedIn and social profiles.",
      first.url,
    );
  } else if (!facts.some((f) => f.hasOrgSameAs)) {
    add("geo:no-same-as", "low", "Organization schema has no sameAs links", "sameAs links (LinkedIn, Google Business Profile, Facebook, Wikipedia, Crunchbase) let AI models tie your site to the same business elsewhere, which builds trust as an entity.", first.url);
  }
  const content = facts.filter((f) => f.textWords >= 300);
  const noAuthor = content.filter((f) => !f.hasAuthor);
  if (content.length && noAuthor.length === content.length) {
    add(
      "geo:no-author",
      "low",
      "Content pages name no author",
      "AI search and Google weigh who wrote a page (experience and expertise). Add a visible byline and author in the Article schema, linking to an author page.",
      noAuthor[0].url,
      noAuthor.slice(0, 5).map((f) => f.url).join("\n"),
    );
  }
  const noDate = content.filter((f) => !f.hasDate);
  if (content.length && noDate.length === content.length) {
    add("geo:no-dates", "low", "Content pages show no published or updated date", "AI answers prefer fresh sources. Show the date and add datePublished and dateModified to the page's schema.", noDate[0].url, noDate.slice(0, 5).map((f) => f.url).join("\n"));
  }
  if (content.length >= 2 && !content.some((f) => f.questionHeadings > 0) && !facts.some((f) => f.schemaTypes.includes("FAQPage"))) {
    add(
      "geo:no-answer-headings",
      "low",
      "No question-style headings or FAQ",
      "AI assistants lift short answers that sit right under a question heading (\"How much does a website cost?\"). Add question headings with a 40 to 60 word direct answer below each, and an FAQ section with FAQPage schema where it fits.",
      content[0].url,
    );
  }
  return out;
}

export const geoAgent: SiteAgent = {
  id: "seo.geo",
  name: "AI search readiness (GEO)",
  description:
    "Checks the site can be found and cited by AI answers (ChatGPT, Claude, Perplexity, Copilot, Google AI): AI crawlers allowed in robots.txt and by the firewall, llms.txt, Organization schema with sameAs, authors, dates and question-style answers.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "site",
  run: geoFindings,
};
