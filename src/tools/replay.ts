import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Record and replay API tests, in the way Keploy and GoReplay work: real traffic is recorded once
 * (a HAR file from the browser's Network tab, the Inspect screen's HAR download, or mitmproxy), then
 * every read request in it is sent again on each test and its answer compared with the recording:
 * status, the JSON's shape (fields removed or changed type), and speed. The recording also becomes
 * ready-made mocks (WireMock format) for the client's own tests. Only GET and HEAD are replayed, and
 * only to the API's own host.
 */

interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request: { method: string; url: string; headers?: { name: string; value: string }[] };
  response: { status: number; headers?: { name: string; value: string }[]; content?: { mimeType?: string; text?: string; encoding?: string } };
}

export interface Recorded {
  method: string;
  url: string;
  status: number;
  ms: number;
  type: string;
  body?: string;
  headers: Record<string, string>;
}

/** Reads a HAR file into the calls worth replaying. Pure, for tests. */
export function readHar(text: string, host: string): { calls: Recorded[]; skipped: { writes: number; other: number; files: number } } {
  const har = JSON.parse(text) as { log?: { entries?: HarEntry[] } };
  const skipped = { writes: 0, other: 0, files: 0 };
  const calls: Recorded[] = [];
  const seen = new Set<string>();
  for (const e of har.log?.entries ?? []) {
    let u: URL;
    try {
      u = new URL(e.request.url);
    } catch {
      continue;
    }
    if (u.host.toLowerCase() !== host.toLowerCase()) {
      skipped.other++;
      continue;
    }
    const method = e.request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      skipped.writes++;
      continue;
    }
    const type = e.response.content?.mimeType ?? "";
    if (/image|font|css|javascript|video|audio/.test(type) || /\.(png|jpe?g|gif|svg|webp|woff2?|css|js|ico|mp4)$/i.test(u.pathname)) {
      skipped.files++;
      continue;
    }
    const key = `${method} ${u.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const keep = new Set(["accept", "accept-language", "x-requested-with", "x-api-version", "content-type"]);
    const headers = Object.fromEntries((e.request.headers ?? []).filter((h) => keep.has(h.name.toLowerCase())).map((h) => [h.name.toLowerCase(), h.value]));
    const raw = e.response.content?.text;
    const body = raw && e.response.content?.encoding === "base64" ? Buffer.from(raw, "base64").toString("utf8") : raw;
    calls.push({ method, url: u.href, status: e.response.status, ms: Math.round(e.time ?? 0), type, ...(body ? { body: body.slice(0, 2_000_000) } : {}), headers });
  }
  return { calls, skipped };
}

/** The shape of a JSON value: each field's path and type ("user.id": "number"). Arrays use their first item. */
export function shapeOf(value: unknown, at = "$", out: Record<string, string> = {}, depth = 0): Record<string, string> {
  if (depth > 8) return out;
  if (value === null) out[at] = "null";
  else if (Array.isArray(value)) {
    out[at] = "array";
    if (value.length) shapeOf(value[0], `${at}[]`, out, depth + 1);
  } else if (typeof value === "object") {
    out[at] = "object";
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) shapeOf(v, `${at}.${k}`, out, depth + 1);
  } else out[at] = typeof value;
  return out;
}

/** What changed between the recorded answer and today's. Pure, for tests. */
export function compareShapes(before: Record<string, string>, after: Record<string, string>): { removed: string[]; changed: string[]; added: string[] } {
  const removed: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  for (const [k, t] of Object.entries(before)) {
    // A field that was null may now hold a value; a parent that is gone already counts.
    if (!(k in after)) {
      if (!removed.some((r) => k.startsWith(`${r}.`) || k.startsWith(`${r}[]`))) removed.push(k);
    } else if (after[k] !== t && t !== "null" && after[k] !== "null") changed.push(`${k}: ${t} → ${after[k]}`);
  }
  for (const k of Object.keys(after)) if (!(k in before)) added.push(k);
  return { removed, changed, added };
}

const parse = (s?: string) => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
};

/** The recording as WireMock stubs, so the client's own tests can run without the real API. */
export function toMocks(calls: Recorded[]): { mappings: unknown[] } {
  return {
    mappings: calls.map((c) => {
      const u = new URL(c.url);
      return { request: { method: c.method, urlPath: u.pathname, ...(u.search ? { queryParameters: Object.fromEntries([...u.searchParams].map(([k, v]) => [k, { equalTo: v }])) } : {}) }, response: { status: c.status, headers: { "Content-Type": c.type || "application/json" }, body: c.body ?? "" } };
    }),
  };
}

export const replayTool: Tool = {
  id: "replay",
  name: "Record and replay",
  maker: "GLV Infotech (built in), in the way of Keploy and GoReplay",
  description:
    "Replays the read requests of a recorded session (a HAR file) against the API on every test and compares each answer with the recording: errors that were not there, JSON fields removed or changed type (breaking changes), and calls that became much slower. It also turns the recording into ready-made mocks for the client's own tests.",
  checks: [
    "Status changes: a call that worked when recorded now fails",
    "Breaking changes: JSON fields removed or of another type",
    "Calls three times slower than when recorded",
    "Mocks (WireMock format) from the recording, as a download",
    "Only GET and HEAD to the API's own host are replayed",
  ],
  products: ["api", "webapp", "saas", "crm"],
  category: "functional",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://keploy.io",
  signedIn: "uses-login",
  options: [{ id: "har", label: "Recorded session (.har)", kind: "file", accept: ".har", required: true, hint: "Browser: Network tab > Save all as HAR. Or the HAR download on a page's Inspect screen.", choices: [], default: "" }],

  async ready() {
    return null;
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const file = ctx.options.har;
    if (!file) throw new Error("Upload the recorded session (.har) in the Record and replay tab.");
    const host = new URL(ctx.startUrl).host;
    const { calls, skipped } = readHar(await readFile(path.join(ctx.uploadsDir, file), "utf8"), host);
    if (!calls.length) throw new Error(`The recording has no GET calls to ${host} (it has ${skipped.writes} that change data, ${skipped.other} to other hosts, ${skipped.files} files).`);
    const findings: ToolFinding[] = [];
    const rows: string[][] = [];
    let same = 0;
    for (const c of calls.slice(0, 300)) {
      ctx.signal.throwIfAborted();
      const started = Date.now();
      let status = 0;
      let body = "";
      try {
        const res = await fetch(c.url, { method: c.method, headers: { ...c.headers, ...(ctx.cookie ? { cookie: ctx.cookie } : {}) }, redirect: "manual", signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) });
        status = res.status;
        body = c.method === "HEAD" ? "" : (await res.text()).slice(0, 2_000_000);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
      const ms = Date.now() - started;
      const where = new URL(c.url);
      const name = `${c.method} ${where.pathname}${where.search ? "?…" : ""}`;
      const problems: string[] = [];
      if (c.status < 400 && (status === 0 || status >= 400)) {
        problems.push(`status ${c.status} → ${status || "no answer"}`);
        findings.push({ category: "functional", rule: "replay:now-fails", severity: status >= 500 || status === 0 ? "high" : "medium", title: `${name} worked when recorded, now ${status || "does not answer"}`, detail: `The call answered ${c.status} in the recording and ${status || "nothing"} today. Something in the last release broke it (or it now needs a login the test does not have).`, pageUrl: c.url, evidence: `Recorded ${c.status}, replayed ${status || "no answer"}`, key: `replay:fails:${c.url}` });
      } else {
        const before = parse(c.body);
        const after = parse(body);
        if (before !== undefined && after !== undefined) {
          const diff = compareShapes(shapeOf(before), shapeOf(after));
          if (diff.removed.length || diff.changed.length) {
            problems.push(`${diff.removed.length} fields removed, ${diff.changed.length} changed type`);
            findings.push({
              category: "functional",
              rule: "replay:breaking-change",
              severity: "high",
              title: `${name}: the answer's fields changed`,
              detail: "Apps and integrations that read these fields will break. Add the fields back (or keep both for one release), or version the API (/v2) and tell its users.",
              pageUrl: c.url,
              evidence: [...diff.removed.slice(0, 10).map((r) => `removed ${r}`), ...diff.changed.slice(0, 10).map((x) => `changed ${x}`)].join("\n"),
              key: `replay:shape:${c.url}`,
            });
          }
        }
        if (c.ms > 0 && ms > 1000 && ms > c.ms * 3) {
          problems.push(`${c.ms} ms → ${ms} ms`);
          findings.push({ category: "performance", rule: "replay:slower", severity: "low", title: `${name} is ${Math.round(ms / c.ms)}× slower than when recorded`, detail: "Compare the release's database queries and caching for this call.", pageUrl: c.url, evidence: `Recorded ${c.ms} ms, replayed ${ms} ms`, key: `replay:slow:${c.url}` });
        }
      }
      if (!problems.length) same++;
      rows.push([name, String(c.status), String(status || "-"), problems.join("; ") || "same"]);
    }
    await writeFile(path.join(ctx.outDir, "tool-replay-mocks.json"), JSON.stringify(toMocks(calls), null, 1));
    return {
      findings,
      summary: [`${calls.length} recorded calls replayed, ${same} answered the same`, `Left out: ${skipped.writes} calls that change data, ${skipped.other} to other hosts, ${skipped.files} files`],
      reports: [{ file: "tool-replay-mocks.json", label: "Mocks from the recording (WireMock JSON)" }],
      tested: `${calls.length} recorded calls to ${host}`,
      table: { title: "Replayed calls", columns: ["Call", "Recorded", "Today", "Change"], rows: rows.slice(0, 300) },
    };
  },
};
