import net from "node:net";
import tls from "node:tls";
import { WEB_PRODUCTS } from "../products.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Race conditions, in the way Burp's single-packet attack and Turbo Intruder work: the tester names
 * one action that should work once (apply a coupon, redeem a gift card, withdraw, vote, claim a
 * referral bonus), and GLV sends it many times at the same instant. Each copy goes out on its own
 * connection with everything but its last byte, then all the last bytes are sent together, so the
 * server receives them within a millisecond. If more than one copy succeeds, the limit can be beaten.
 * It changes data, so it runs only with the client's written permission that allows changes, on a
 * host the permission names (a test copy is best).
 */

export interface RaceAnswer {
  status: number;
  body: string;
  ms: number;
}

/** Builds the raw HTTP/1.1 request. Pure, for tests. */
export function rawRequest(method: string, url: URL, body: string, type: string, cookie?: string, extra: Record<string, string> = {}): string {
  const headers: Record<string, string> = {
    Host: url.host,
    "User-Agent": "GLV-Testing-Agent race test",
    Accept: "*/*",
    Connection: "close",
    ...(body ? { "Content-Type": type, "Content-Length": String(Buffer.byteLength(body)) } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
  return `${method} ${url.pathname}${url.search} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}`;
}

/** Reads status and body out of a raw HTTP/1.1 answer (chunked or not). Pure, for tests. */
export function readRaw(raw: string): { status: number; body: string } {
  const split = raw.indexOf("\r\n\r\n");
  const head = split >= 0 ? raw.slice(0, split) : raw;
  let body = split >= 0 ? raw.slice(split + 4) : "";
  const status = Number(head.match(/^HTTP\/\d(?:\.\d)? (\d{3})/)?.[1] ?? 0);
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    let out = "";
    let rest = body;
    for (;;) {
      const nl = rest.indexOf("\r\n");
      if (nl < 0) break;
      const size = parseInt(rest.slice(0, nl), 16);
      if (!size) break;
      out += rest.slice(nl + 2, nl + 2 + size);
      rest = rest.slice(nl + 4 + size);
    }
    body = out;
  }
  return { status, body };
}

/** Which answers count as a success. Pure, for tests. */
export function successes(answers: RaceAnswer[], pattern?: RegExp): RaceAnswer[] {
  return answers.filter((a) => a.status >= 200 && a.status < 400 && (!pattern || pattern.test(a.body)));
}

async function raceSend(url: URL, request: string, copies: number, signal: AbortSignal): Promise<RaceAnswer[]> {
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const head = request.slice(0, -1);
  const last = request.slice(-1);
  const sockets = await Promise.all(
    Array.from({ length: copies }, () =>
      new Promise<{ sock: net.Socket; chunks: Buffer[]; done: Promise<void> } | null>((resolve) => {
        const sock: net.Socket = url.protocol === "https:" ? tls.connect({ host: url.hostname, port, servername: url.hostname, ALPNProtocols: ["http/1.1"] }) : net.connect({ host: url.hostname, port });
        const chunks: Buffer[] = [];
        const done = new Promise<void>((ok) => {
          sock.on("data", (d: Buffer) => chunks.push(d));
          sock.on("end", () => ok());
          sock.on("close", () => ok());
          sock.on("error", () => ok());
        });
        const timer = setTimeout(() => resolve(null), 15_000);
        sock.setNoDelay(true);
        sock.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
          sock.write(head, () => {
            clearTimeout(timer);
            resolve({ sock, chunks, done });
          });
        });
        sock.once("error", () => resolve(null));
      }),
    ),
  );
  const ready = sockets.filter((s): s is NonNullable<typeof s> => s !== null);
  signal.throwIfAborted();
  await new Promise((ok) => setTimeout(ok, 100));
  const started = Date.now();
  for (const s of ready) s.sock.write(last);
  const answers = await Promise.all(
    ready.map(async (s) => {
      await Promise.race([s.done, new Promise((ok) => setTimeout(ok, 30_000))]);
      s.sock.destroy();
      const r = readRaw(Buffer.concat(s.chunks).toString("utf8"));
      return { ...r, ms: Date.now() - started };
    }),
  );
  return answers;
}

export const raceTool: Tool = {
  id: "race",
  name: "Race conditions",
  maker: "GLV Infotech (built in), in the way of Burp's single-packet attack",
  description:
    "Sends one action that should work once (apply a coupon, redeem a gift card or wallet balance, vote, claim a bonus, withdraw) many times at the same instant, timed to the millisecond. If more than one copy succeeds, customers can beat the limit and the business loses money. Changes data: only with the client's permission that allows changes, best on a test copy.",
  checks: ["Last-byte sync: every copy reaches the server within about a millisecond", "Counts the copies that succeeded (by status, or by the words of a success message)", "Uses the signed-in session; only on hosts the permission names"],
  products: [...WEB_PRODUCTS, "api"],
  category: "security",
  safety: "permission",
  permission: "attack",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://portswigger.net/research/smashing-the-state-machine",
  signedIn: "uses-login",
  options: [
    { id: "method", label: "Method", choices: ["POST", "PUT", "PATCH", "GET"].map((v) => ({ value: v, label: v })), default: "POST" },
    { id: "url", label: "Action address", kind: "text", required: true, pattern: "^https?://", placeholder: "https://staging.example.com/cart/apply-coupon", hint: "Copy it from the browser's Network tab while doing the action once.", choices: [], default: "" },
    { id: "body", label: "Body", kind: "text", maxLength: 4000, placeholder: "coupon=WELCOME100", choices: [], default: "" },
    { id: "type", label: "Body type", choices: [{ value: "application/x-www-form-urlencoded", label: "Form" }, { value: "application/json", label: "JSON" }], default: "application/x-www-form-urlencoded" },
    { id: "success", label: "Words of a success (optional)", kind: "text", placeholder: "Coupon applied", hint: "When set, only answers with these words count as a success.", choices: [], default: "" },
    { id: "copies", label: "Copies at once", choices: ["5", "10", "20", "30"].map((v) => ({ value: v, label: v })), default: "20" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const permit = ctx.permit;
    if (!permit) throw new Error("The race test runs only with the client's written permission.");
    if (!permit.writes) throw new Error("The race test changes data (it repeats an action), so the client's permission must allow changes. Ask for it on the Permission page, ideally for a test copy.");
    const url = new URL(ctx.options.url ?? "");
    if (!permit.hosts.map((h) => h.toLowerCase()).includes(url.hostname.toLowerCase())) throw new Error(`${url.hostname} is not in the client's written permission.`);
    const method = (ctx.options.method || "POST").toUpperCase();
    const copies = Math.min(Number(ctx.options.copies) || 20, 30);
    const pattern = ctx.options.success ? new RegExp(ctx.options.success.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : undefined;
    const request = rawRequest(method, url, ctx.options.body ?? "", ctx.options.type || "application/x-www-form-urlencoded", ctx.cookie);
    ctx.log(`Race: sending ${copies} copies of ${method} ${url.pathname} at the same instant`);
    const answers = await raceSend(url, request, copies, ctx.signal);
    const won = successes(answers, pattern);
    const findings: ToolFinding[] = [];
    const statuses = answers.reduce<Record<string, number>>((m, a) => ((m[a.status || "none"] = (m[a.status || "none"] ?? 0) + 1), m), {});
    if (won.length > 1)
      findings.push({
        category: "security",
        rule: "race:limit-beaten",
        severity: "high",
        title: `${won.length} of ${answers.length} copies of ${method} ${url.pathname} succeeded at once`,
        detail: `The action was sent ${answers.length} times within a millisecond and ${won.length} copies succeeded. If it should work once (a coupon, gift card, wallet withdrawal, vote, bonus), a customer can use it ${won.length} times. Check the limit and record the use in one database transaction with a row lock (SELECT … FOR UPDATE) or a unique constraint, or use an atomic update (UPDATE … SET used = 1 WHERE id = ? AND used = 0) and check that it changed one row.`,
        pageUrl: url.href,
        evidence: `${method} ${url.href}\nAnswers: ${Object.entries(statuses).map(([s, n]) => `${n}× ${s}`).join(", ")}${pattern ? `\nSuccess words "${ctx.options.success}" in ${won.length}` : ""}`,
        key: `race:${method}:${url.pathname}`,
      });
    return {
      findings,
      summary: [`${answers.length} copies sent together: ${won.length} succeeded (${Object.entries(statuses).map(([s, n]) => `${n}× ${s}`).join(", ")})`, "Undo what the copies did in the test copy (coupons, balances), if any succeeded"],
      tested: `${answers.length} copies of ${method} ${url.pathname}`,
      table: { title: "Answers", columns: ["Copy", "Status", "Time", "Start of answer"], rows: answers.map((a, i) => [String(i + 1), String(a.status || "-"), `${a.ms} ms`, a.body.slice(0, 80).replace(/\s+/g, " ")]) },
    };
  },
};
