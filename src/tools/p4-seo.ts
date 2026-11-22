import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Wave 4 — keyword/rank tracking and AI-answer visibility, built so they run fully in-house on
 * free/open data or the moment the CLIENT plugs in THEIR OWN free key. GLV never pays.
 *
 *  - rank-tracking: where a domain ranks for a keyword, read from a self-hosted SearXNG meta-search
 *    (free, open-source, operator stands it up) OR the client's own Google Custom Search key (free
 *    tier). Honest limit: not identical to a paid rank tracker — no personalised/geo SERP, sampling.
 *  - ai-visibility: whether an LLM's answer mentions the client's brand/site, asked through a local
 *    Ollama model (free, GLV-hosted) OR the client's own OpenAI-compatible key. Honest limit: a
 *    local model is not the exact commercial assistant; treat it as directional.
 */

// ---------------------------------------------------------------------------
// Keyword / rank tracking
// ---------------------------------------------------------------------------

export interface SerpResult {
  url: string;
  title?: string;
}

/** Position (1-based) of the first result on the domain, else 0. Pure, for tests. */
export function findRank(results: SerpResult[], domain: string): number {
  const want = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();
  for (let i = 0; i < results.length; i++) {
    let host = "";
    try {
      host = new URL(results[i].url).host.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    if (host === want || host.endsWith("." + want)) return i + 1;
  }
  return 0;
}

/** Reads SearXNG's JSON results into a flat list. Pure, for tests. */
export function parseSearxng(json: unknown): SerpResult[] {
  const arr = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => r as { url?: string; title?: string })
    .filter((r) => typeof r.url === "string")
    .map((r) => ({ url: r.url as string, title: r.title }));
}

/** Reads Google Custom Search JSON into a flat list. Pure, for tests. */
export function parseGoogleCse(json: unknown): SerpResult[] {
  const arr = (json as { items?: unknown[] })?.items;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => r as { link?: string; title?: string })
    .filter((r) => typeof r.link === "string")
    .map((r) => ({ url: r.link as string, title: r.title }));
}

export const rankTrackingTool: Tool = {
  id: "rank-tracking",
  name: "Keyword & rank tracking",
  maker: "GLV Infotech (built in), on SearXNG / Google Custom Search",
  description:
    "Checks where the client's domain ranks for keywords. Runs on a self-hosted SearXNG meta-search (free, open-source, on GLV servers) or on the client's own Google Custom Search key (free tier) — GLV pays for nothing. Honest limit: this is a sampled, non-personalised SERP, so it is directional, not identical to a paid rank tracker.",
  checks: [
    "Finds the domain's position for each keyword",
    "Flags keywords where the domain is not in the top results",
    "Uses free SearXNG or the client's own free Google key",
  ],
  products: ["website", "ecommerce", "webapp", "saas"],
  category: "seo",
  safety: "safe",
  manual: true,
  takes: "about a minute",
  licence: "GLV's own",
  homepage: "https://github.com/searxng/searxng",
  signedIn: "public",
  options: [
    { id: "keywords", label: "Keywords (one per line)", kind: "text", required: true, maxLength: 2000, placeholder: "website testing company\nAI testing agent India", hint: "One keyword per line.", choices: [], default: "" },
    { id: "domain", label: "Domain to find", kind: "text", required: true, placeholder: "glvinfotechsolutions.com", choices: [], default: "" },
    { id: "searxng", label: "SearXNG endpoint (free, self-hosted)", kind: "text", pattern: "^https?://.+", placeholder: "https://searxng.glv.internal", hint: "Leave blank to use a Google Custom Search key instead.", choices: [], default: "" },
    { id: "googleKey", label: "Google Custom Search key (client's own free key)", kind: "text", placeholder: "AIza…", choices: [], default: "" },
    { id: "googleCx", label: "Google Custom Search engine id (cx)", kind: "text", placeholder: "0123:abcd", choices: [], default: "" },
    { id: "target", label: "Target position", kind: "text", placeholder: "10", choices: [], default: "10" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const keywords = (ctx.options.keywords ?? "").split(/\r?\n/).map((k) => k.trim()).filter(Boolean).slice(0, 25);
    const domain = (ctx.options.domain ?? "").trim();
    const searxng = (ctx.options.searxng ?? "").trim();
    const key = (ctx.options.googleKey ?? "").trim();
    const cx = (ctx.options.googleCx ?? "").trim();
    const target = Number(ctx.options.target ?? "10") || 10;
    if (!keywords.length || !domain) throw new Error("Give at least one keyword and the domain.");
    if (!searxng && !(key && cx)) throw new Error("Set a SearXNG endpoint, or the client's Google key and cx. Both are free.");
    const findings: ToolFinding[] = [];
    const rows: string[][] = [];
    for (const kw of keywords) {
      let results: SerpResult[] = [];
      try {
        if (searxng) {
          const u = `${searxng.replace(/\/$/, "")}/search?q=${encodeURIComponent(kw)}&format=json`;
          const res = await fetch(u, { signal: ctx.signal, headers: { accept: "application/json" } });
          results = parseSearxng(await res.json());
        } else {
          const u = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(kw)}`;
          const res = await fetch(u, { signal: ctx.signal });
          results = parseGoogleCse(await res.json());
        }
      } catch {
        throw new Error("Could not reach the search source. Check the SearXNG endpoint or the Google key/cx.");
      }
      const pos = findRank(results, domain);
      rows.push([kw, pos ? `#${pos}` : "not in top results"]);
      if (!pos)
        findings.push({ category: "seo", rule: "rank:not-found", severity: "medium", title: `Not ranking for "${kw}"`, detail: `The domain did not appear in the sampled results for "${kw}". Strengthen the page targeting this keyword (title, headings, content depth, internal links) and earn links to it.`, pageUrl: `https://${domain}`, key: `rank:not-found:${kw}` });
      else if (pos > target)
        findings.push({ category: "seo", rule: "rank:low", severity: "low", title: `"${kw}" ranks below target (#${pos})`, detail: `The domain ranks at about position ${pos} for "${kw}", below the target of ${target}. Improve the matching page and its links to climb.`, pageUrl: `https://${domain}`, key: `rank:low:${kw}` });
    }
    ctx.log(`Rank: ${keywords.length} keyword(s), ${findings.length} below target`);
    return {
      findings,
      summary: [`${keywords.length} keyword(s) checked`, searxng ? "via self-hosted SearXNG (free)" : "via the client's Google key (free tier)", "Directional: sampled, non-personalised SERP"],
      table: { title: "Keyword positions", columns: ["Keyword", "Position"], rows },
      tested: `${keywords.length} keywords`,
    };
  },
};

// ---------------------------------------------------------------------------
// AI-answer visibility
// ---------------------------------------------------------------------------

/** True if the answer mentions the brand or domain. Pure, for tests. */
export function mentionsBrand(answer: string, brand: string, domain: string): boolean {
  const a = answer.toLowerCase();
  const b = brand.trim().toLowerCase();
  const d = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();
  const dRoot = d.split(".")[0];
  return (b.length > 1 && a.includes(b)) || (d.length > 1 && a.includes(d)) || (dRoot.length > 2 && new RegExp(`\\b${dRoot.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}\\b`).test(a));
}

/** Coverage = share of prompts whose answer mentions the brand. Pure, for tests. */
export function visibilityScore(hits: boolean[]): number {
  if (!hits.length) return 0;
  return Math.round((hits.filter(Boolean).length / hits.length) * 100);
}

export const aiVisibilityTool: Tool = {
  id: "ai-visibility",
  name: "AI answer visibility",
  maker: "GLV Infotech (built in), on a local LLM or the client's own key",
  description:
    "Asks an LLM a set of buyer-style questions and checks whether its answer mentions the client's brand or site — the 'are we visible in AI answers' question. Runs on a local Ollama model (free, on GLV servers) or on the client's own OpenAI-compatible key, so GLV pays nothing. Honest limit: a local model is not the exact commercial assistant, so treat the score as directional AI-readiness, not a guaranteed match of ChatGPT/Gemini.",
  checks: [
    "Asks buyer-style prompts and looks for the brand/domain in the answer",
    "Reports a visibility score across the prompts",
    "Uses a free local model or the client's own key",
  ],
  products: ["website", "ecommerce", "webapp", "saas"],
  category: "seo",
  safety: "safe",
  manual: true,
  takes: "a few minutes",
  licence: "GLV's own",
  homepage: "https://ollama.com",
  signedIn: "public",
  options: [
    { id: "endpoint", label: "LLM endpoint (OpenAI-compatible)", kind: "text", required: true, pattern: "^https?://.+", placeholder: "http://ollama.glv.internal:11434/v1", hint: "A local Ollama server (free) or any OpenAI-compatible URL.", choices: [], default: "" },
    { id: "model", label: "Model", kind: "text", placeholder: "llama3.1", choices: [], default: "llama3.1" },
    { id: "apiKey", label: "API key (only if the endpoint needs one — client's own)", kind: "text", placeholder: "sk-… (optional)", choices: [], default: "" },
    { id: "brand", label: "Brand name", kind: "text", required: true, placeholder: "GLV Infotech", choices: [], default: "" },
    { id: "domain", label: "Domain", kind: "text", required: true, placeholder: "glvinfotechsolutions.com", choices: [], default: "" },
    { id: "prompts", label: "Questions (one per line)", kind: "text", required: true, maxLength: 3000, placeholder: "Best AI software testing companies in India?\nWho offers in-house security testing for SaaS?", hint: "Buyer-style questions a prospect might ask an AI.", choices: [], default: "" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const endpoint = (ctx.options.endpoint ?? "").trim().replace(/\/$/, "");
    const model = (ctx.options.model ?? "llama3.1").trim();
    const apiKey = (ctx.options.apiKey ?? "").trim();
    const brand = (ctx.options.brand ?? "").trim();
    const domain = (ctx.options.domain ?? "").trim();
    const prompts = (ctx.options.prompts ?? "").split(/\r?\n/).map((p) => p.trim()).filter(Boolean).slice(0, 15);
    if (!endpoint || !brand || !domain || !prompts.length) throw new Error("Give the endpoint, brand, domain and at least one question.");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const hits: boolean[] = [];
    const missed: string[] = [];
    for (const prompt of prompts) {
      let answer = "";
      try {
        const res = await fetch(`${endpoint}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
          signal: ctx.signal,
        });
        const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        answer = json.choices?.[0]?.message?.content ?? "";
      } catch {
        throw new Error("Could not reach the LLM endpoint. For a free setup, run Ollama on a GLV server and point here.");
      }
      const hit = mentionsBrand(answer, brand, domain);
      hits.push(hit);
      if (!hit) missed.push(prompt);
    }
    const score = visibilityScore(hits);
    const findings: ToolFinding[] = [];
    if (score === 0)
      findings.push({ category: "seo", rule: "aivis:absent", severity: "medium", title: "Not mentioned in any AI answer", detail: `The model named the brand in 0 of ${prompts.length} buyer questions. Publish clear, factual, well-structured pages (who you are, what you do, for whom), add Organization schema, and earn mentions on sites the model trusts. First missed: "${missed[0]}".`, pageUrl: `https://${domain}`, key: "aivis:absent" });
    else if (score < 50)
      findings.push({ category: "seo", rule: "aivis:low-coverage", severity: "low", title: `Low AI visibility (${score}%)`, detail: `The model mentioned the brand in only ${score}% of the questions. Strengthen the pages behind the missed questions and your off-site presence. Missed: ${missed.slice(0, 3).map((m) => `"${m}"`).join(", ")}.`, pageUrl: `https://${domain}`, key: "aivis:low-coverage" });
    ctx.log(`AI visibility: ${score}% across ${prompts.length} prompt(s)`);
    return {
      findings,
      summary: [`Visibility ${score}% across ${prompts.length} question(s)`, "Directional (local/own model, not the exact commercial assistant)"],
      tested: `${prompts.length} questions`,
    };
  },
};
