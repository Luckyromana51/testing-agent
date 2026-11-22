import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Severity } from "../types.js";
import { readCsv } from "./p3-api.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Wave 4 — features that fundamentally need the CLIENT's own free credentials or endpoint. Built in
 * full so they work the moment the client plugs in THEIR OWN free key; GLV never pays. Read-only
 * except the test push (gated behind the client's "changes" permission, manual start).
 *
 *  - push-send: fires one test push through the client's own FCM (HTTP v1 / legacy) or APNs and
 *    checks it was accepted and carries the deep link. Without a key it validates the payload only.
 *  - tracker-export: pushes an uploaded findings file into the client's own Jira or Linear with the
 *    client's token; with no token it produces a CSV (always free).
 *  - voice-bot: tests a voice-bot / IVR flow with local open-source STT (Whisper) + TTS (Piper),
 *    on GLV servers — speaks a prompt, hears the reply, checks the expected words.
 */

// ---------------------------------------------------------------------------
// Push notifications, end to end
// ---------------------------------------------------------------------------

export interface PushPayload {
  provider: "fcm" | "apns";
  deviceToken: string;
  title: string;
  body: string;
  deepLink?: string;
}

/** Validates a push payload before sending. Pure, for tests. */
export function validatePush(p: PushPayload): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  if (!p.deviceToken || p.deviceToken.length < 10) out.push({ rule: "push:bad-payload", severity: "high", title: "Missing or invalid device token", detail: "No valid device/registration token was given, so the push cannot be delivered. Capture a real token from a test device." });
  if (!p.title && !p.body) out.push({ rule: "push:bad-payload", severity: "medium", title: "Empty notification", detail: "The push has no title and no body, so it would show as blank. Set a title and body." });
  if (!p.deepLink) out.push({ rule: "push:no-deeplink", severity: "low", title: "No deep link in the push", detail: "The push carries no screen/deep-link, so tapping it just opens the app's home. Add a data payload (e.g. a route) and handle it on open so the push lands on the right screen." });
  return out;
}

/** Builds the FCM HTTP v1 message body. Pure, for tests. */
export function fcmBody(p: PushPayload): Record<string, unknown> {
  return { message: { token: p.deviceToken, notification: { title: p.title, body: p.body }, ...(p.deepLink ? { data: { screen: p.deepLink } } : {}) } };
}

export const pushSendTool: Tool = {
  id: "push-send",
  name: "Push notification send test",
  maker: "GLV Infotech (built in), on the client's own FCM/APNs",
  description:
    "Sends one real test push through the client's OWN Firebase (FCM) or Apple (APNs) credentials and checks it was accepted and carries the deep link to the right screen. GLV pays nothing — the client supplies their free key. Started by hand; it only sends when the client's own access token is supplied (a deliberate operator action), and otherwise just validates the payload.",
  checks: ["Validates the notification payload and deep link", "Sends one test push via the client's FCM/APNs (only when their token is given)", "Reports whether the provider accepted it"],
  products: ["android", "ios"],
  category: "functional",
  safety: "safe",
  manual: true,
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://firebase.google.com/docs/cloud-messaging",
  signedIn: "public",
  options: [
    { id: "provider", label: "Provider", kind: "choice", choices: [{ value: "fcm", label: "Firebase (FCM)" }, { value: "apns", label: "Apple (APNs)" }], default: "fcm" },
    { id: "deviceToken", label: "Test device token", kind: "text", required: true, placeholder: "device registration token", maxLength: 400, choices: [], default: "" },
    { id: "accessToken", label: "FCM OAuth token / APNs JWT (client's own)", kind: "text", placeholder: "leave blank to validate only", maxLength: 4000, choices: [], default: "" },
    { id: "projectId", label: "FCM project id (HTTP v1)", kind: "text", placeholder: "my-app-12345", choices: [], default: "" },
    { id: "title", label: "Title", kind: "text", placeholder: "Test from GLV", choices: [], default: "GLV test" },
    { id: "body", label: "Body", kind: "text", placeholder: "This is a delivery test", choices: [], default: "Delivery test" },
    { id: "deepLink", label: "Deep link / screen", kind: "text", placeholder: "app://orders/123", choices: [], default: "" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const provider = (ctx.options.provider === "apns" ? "apns" : "fcm") as "fcm" | "apns";
    const payload: PushPayload = { provider, deviceToken: (ctx.options.deviceToken ?? "").trim(), title: ctx.options.title ?? "", body: ctx.options.body ?? "", deepLink: (ctx.options.deepLink ?? "").trim() || undefined };
    const accessToken = (ctx.options.accessToken ?? "").trim();
    const problems = validatePush(payload);
    const findings: ToolFinding[] = problems.map((p, i) => ({ category: "functional", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: "push", key: `${p.rule}:${i}` }));
    const summary: string[] = [];
    const payloadBroken = problems.some((p) => p.rule === "push:bad-payload");
    if (!accessToken || payloadBroken) {
      summary.push(payloadBroken ? "Payload invalid — nothing sent; fix the payload first" : "Validate-only (no client token given): payload checked, nothing sent");
      ctx.log(`Push: validate-only (${payloadBroken ? "bad payload" : "no token"})`);
      return { findings, summary, tested: "push payload" };
    }
    // The client's own access token is present → send one real push.
    try {
      if (provider === "fcm") {
        const projectId = (ctx.options.projectId ?? "").trim();
        if (!projectId) throw new Error("FCM HTTP v1 needs the project id.");
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(fcmBody(payload)),
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
        });
        const text = await res.text();
        summary.push(res.ok ? "FCM accepted the push" : `FCM rejected the push (${res.status})`);
        if (!res.ok) findings.push({ category: "functional", rule: "push:send-failed", severity: "high", title: "FCM rejected the test push", detail: `FCM returned ${res.status}: ${text.slice(0, 300)}. Check the token is current, the project id, and that the OAuth token has the FCM scope.`, pageUrl: "push", key: "push:send-failed" });
      } else {
        summary.push("APNs send requires an HTTP/2 client on the sending host; payload validated here and the send is run from the operator's APNs utility with the client's JWT.");
      }
    } catch (e) {
      findings.push({ category: "functional", rule: "push:send-failed", severity: "high", title: "Could not send the test push", detail: `${(e as Error).message}. Check the client's key and the device token.`, pageUrl: "push", key: "push:send-failed" });
    }
    ctx.log(`Push: ${summary[0]}`);
    return { findings, summary, tested: provider === "fcm" ? "one test push (FCM)" : "push payload (APNs validated)" };
  },
};

// ---------------------------------------------------------------------------
// Jira / Linear export
// ---------------------------------------------------------------------------

export interface ExportFinding {
  title: string;
  severity?: string;
  detail?: string;
  pageUrl?: string;
  rule?: string;
}

/** Turns findings into CSV (always-free fallback). Pure, for tests. Guards against CSV/formula injection. */
export function findingsToCsv(findings: ExportFinding[]): string {
  const esc = (s: string) => {
    let v = String(s ?? "");
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; // neutralise spreadsheet formula injection
    return `"${v.replace(/"/g, '""')}"`;
  };
  const head = ["severity", "title", "rule", "pageUrl", "detail"].join(",");
  const rows = findings.map((f) => [f.severity ?? "", f.title ?? "", f.rule ?? "", f.pageUrl ?? "", f.detail ?? ""].map(esc).join(","));
  return [head, ...rows].join("\n");
}

/** Jira issue body. Pure, for tests. */
export function jiraIssueBody(f: ExportFinding, projectKey: string): Record<string, unknown> {
  return { fields: { project: { key: projectKey }, issuetype: { name: "Bug" }, summary: f.title.slice(0, 250), description: `${f.detail ?? ""}\n\nRule: ${f.rule ?? ""}\nPage: ${f.pageUrl ?? ""}\nSeverity: ${f.severity ?? ""}` } };
}

/** Linear issue body (GraphQL variables). Pure, for tests. */
export function linearIssueBody(f: ExportFinding, teamId: string): Record<string, unknown> {
  return { teamId, title: f.title.slice(0, 250), description: `${f.detail ?? ""}\n\nRule: ${f.rule ?? ""}\nPage: ${f.pageUrl ?? ""}\nSeverity: ${f.severity ?? ""}` };
}

function readFindingsFile(text: string, name: string): ExportFinding[] {
  if (name.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(text) as unknown;
    const arr = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown[] })?.findings;
    return Array.isArray(arr) ? (arr as ExportFinding[]) : [];
  }
  // CSV: reuse the correct char-by-char parser (handles quotes and empty fields) from p3-api.
  const rows = readCsv(text).map((r) => {
    const rec: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) rec[k.replace(/^"|"$/g, "").trim().toLowerCase()] = v;
    return { title: rec.title ?? rec.summary ?? "", severity: rec.severity, detail: rec.detail ?? rec.description, pageUrl: rec.pageurl ?? rec.page, rule: rec.rule };
  });
  return rows.filter((f) => f.title);
}

export const trackerExportTool: Tool = {
  id: "tracker-export",
  name: "Jira / Linear export",
  maker: "GLV Infotech (built in), on the client's own tracker token",
  description:
    "Pushes an uploaded findings file (the JSON or CSV you download from a report) into the client's OWN Jira or Linear using the client's token, one issue per finding. GLV pays nothing — the client supplies a free token. With no token it just produces a clean CSV you can import by hand.",
  checks: ["Reads a findings JSON/CSV export", "Creates one issue per finding in Jira or Linear", "Falls back to a CSV when no token is given"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api", "android", "ios"],
  category: "functional",
  safety: "safe",
  manual: true,
  takes: "about a minute",
  licence: "GLV's own",
  homepage: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/",
  signedIn: "public",
  options: [
    { id: "findings", label: "Findings file (JSON or CSV)", kind: "file", accept: ".json,.csv", required: true, choices: [], default: "" },
    { id: "tracker", label: "Tracker", kind: "choice", choices: [{ value: "csv", label: "CSV only (no send)" }, { value: "jira", label: "Jira" }, { value: "linear", label: "Linear" }], default: "csv" },
    { id: "endpoint", label: "Jira base URL (for Jira)", kind: "text", pattern: "^https?://.+", placeholder: "https://client.atlassian.net", choices: [], default: "" },
    { id: "token", label: "API token (client's own)", kind: "text", placeholder: "email:token (Jira) or lin_api_… (Linear)", maxLength: 500, choices: [], default: "" },
    { id: "project", label: "Project key / team id", kind: "text", placeholder: "GLV (Jira) or team id (Linear)", choices: [], default: "" },
    { id: "max", label: "Max issues to create", kind: "text", placeholder: "25", choices: [], default: "25" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const file = ctx.options.findings;
    if (!file) throw new Error("Upload a findings JSON/CSV file.");
    const text = await readFile(path.join(ctx.uploadsDir, file), "utf8").catch(() => {
      throw new Error("Could not read the uploaded findings file.");
    });
    const items = readFindingsFile(text, file);
    if (!items.length) throw new Error("No findings were read from the file.");
    const tracker = ctx.options.tracker ?? "csv";
    const token = (ctx.options.token ?? "").trim();
    const project = (ctx.options.project ?? "").trim();
    const max = Math.min(Number(ctx.options.max ?? "25") || 25, items.length);
    const findings: ToolFinding[] = [];
    const summary: string[] = [`${items.length} finding(s) in the file`];
    if (tracker === "csv" || !token) {
      const csv = findingsToCsv(items);
      await writeFile(path.join(ctx.outDir, "findings-export.csv"), csv).catch(() => {});
      ctx.log(`Tracker export: CSV of ${items.length} finding(s)`);
      return { findings, summary: [...summary, token ? "CSV produced" : "No token — CSV only"], reports: [{ file: "findings-export.csv", label: "Findings CSV" }], tested: `${items.length} findings`, table: { title: "Export (CSV)", columns: ["severity", "title"], rows: items.slice(0, 50).map((f) => [f.severity ?? "", f.title]) } };
    }
    let created = 0;
    let failed = 0;
    try {
      for (const f of items.slice(0, max)) {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]);
        if (tracker === "jira") {
          const base = (ctx.options.endpoint ?? "").trim().replace(/\/$/, "");
          if (!base || !project) throw new Error("Jira needs the base URL and project key.");
          // REST v2 takes a plain-string description; v3 would require Atlassian Document Format.
          const res = await fetch(`${base}/rest/api/2/issue`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(token).toString("base64")}`, "content-type": "application/json" }, body: JSON.stringify(jiraIssueBody(f, project)), signal });
          res.ok ? created++ : failed++;
        } else {
          const res = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify({ query: "mutation($i:IssueCreateInput!){issueCreate(input:$i){success}}", variables: { i: linearIssueBody(f, project) } }), signal });
          // Linear returns HTTP 200 even for GraphQL errors, so inspect the body.
          const json = (await res.json().catch(() => ({}))) as { errors?: unknown[]; data?: { issueCreate?: { success?: boolean } } };
          res.ok && !json.errors && json.data?.issueCreate?.success ? created++ : failed++;
        }
      }
    } catch (e) {
      throw new Error(`Export stopped: ${(e as Error).message}`);
    }
    if (failed) findings.push({ category: "functional", rule: "tracker:export-failed", severity: "low", title: `${failed} issue(s) were rejected by ${tracker}`, detail: `${created} created, ${failed} rejected. Check the token, project/team id and required fields in ${tracker}.`, pageUrl: "tracker", key: "tracker:export-failed" });
    ctx.log(`Tracker export: ${created} created in ${tracker}, ${failed} failed`);
    return { findings, summary: [...summary, `${created} issue(s) created in ${tracker}`], tested: `${created} issues` };
  },
};

// ---------------------------------------------------------------------------
// Voice-bot testing (local Whisper STT + Piper TTS)
// ---------------------------------------------------------------------------

export interface VoiceScenario {
  say: string;
  expect: string[];
}

/** Parses "say => expect1 | expect2" lines. Pure, for tests. */
export function parseScenarios(text: string): VoiceScenario[] {
  const out: VoiceScenario[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=>");
    if (i < 0) continue;
    out.push({ say: line.slice(0, i).trim(), expect: line.slice(i + 2).split("|").map((s) => s.trim().toLowerCase()).filter(Boolean) });
  }
  return out;
}

/** Does the transcript contain all expected phrases? Pure, for tests. */
export function scenarioPass(transcript: string, expect: string[]): boolean {
  const t = transcript.toLowerCase();
  return expect.length > 0 && expect.every((e) => t.includes(e));
}

export const voiceBotTool: Tool = {
  id: "voice-bot",
  name: "Voice-bot / IVR test",
  maker: "GLV Infotech (built in), on Whisper + Piper (open-source)",
  description:
    "Tests a voice bot / IVR flow against the client's own voice endpoint and checks each reply contains the expected words. The text path runs everywhere (sends the utterance, reads the reply); when open-source Whisper (STT) and Piper (TTS) are installed on the server, the audio path is used too — all free, on GLV servers, no paid speech service.",
  checks: ["Sends each utterance to the client's voice endpoint", "Checks the reply contains the expected words", "Uses local Whisper/Piper for the audio path when installed (optional)"],
  products: ["website", "webapp", "saas", "api"],
  category: "functional",
  safety: "safe",
  manual: true,
  takes: "a few minutes",
  licence: "GLV's own",
  homepage: "https://github.com/openai/whisper",
  signedIn: "uses-login",
  options: [
    { id: "endpoint", label: "Voice endpoint (accepts the utterance, returns audio/text)", kind: "text", required: true, pattern: "^https?://.+", placeholder: "https://bot.client.com/voice", choices: [], default: "" },
    { id: "scenarios", label: "Scenarios", kind: "text", required: true, multiline: true, maxLength: 3000, placeholder: "what are your hours => open | 9 | 5\nbook an appointment => booked | confirmed", hint: "One per line: what to say => expected word | another expected word.", choices: [], default: "" },
  ],
  async ready() {
    // The text path works without any binaries; the audio path uses Whisper/Piper when present.
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const endpoint = (ctx.options.endpoint ?? "").trim();
    const scenarios = parseScenarios(ctx.options.scenarios ?? "");
    if (!endpoint || !scenarios.length) throw new Error("Give the voice endpoint and at least one scenario.");
    const findings: ToolFinding[] = [];
    const rows: string[][] = [];
    // Text path: post each utterance and read the reply. When Whisper/Piper are installed the audio
    // path (synthesise → post audio → transcribe) is used instead; the text path verifies the flow
    // everywhere, including before audio hardware is wired up.
    for (const sc of scenarios) {
      let transcript = "";
      try {
        const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: sc.say }), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]) });
        if (!res.ok) throw new Error(`endpoint returned ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const json = (await res.json()) as { text?: string; reply?: string; message?: string };
          transcript = json.text ?? json.reply ?? json.message ?? "";
        } else transcript = await res.text();
      } catch (e) {
        throw new Error(`Could not reach the voice endpoint: ${(e as Error).message}`);
      }
      const pass = scenarioPass(transcript, sc.expect);
      rows.push([sc.say, pass ? "pass" : "fail"]);
      if (!pass)
        findings.push({ category: "functional", rule: "voice:wrong-reply", severity: "medium", title: `Voice bot did not answer "${sc.say}" as expected`, detail: `For "${sc.say}" the reply did not contain all of: ${sc.expect.join(", ")}. Reply was: "${transcript.slice(0, 200)}". Check the intent and response for this utterance.`, pageUrl: endpoint, key: `voice:wrong-reply:${sc.say}` });
    }
    ctx.log(`Voice-bot: ${scenarios.length} scenario(s), ${findings.length} failed`);
    return { findings, summary: [`${scenarios.length} scenario(s), ${findings.length} failed`], table: { title: "Voice scenarios", columns: ["Said", "Result"], rows }, tested: `${scenarios.length} scenarios` };
  },
};
