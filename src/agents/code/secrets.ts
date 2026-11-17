import { finding } from "../../runner/finding.js";
import type { Finding, Severity } from "../../types.js";
import type { EngineAgent } from "../types.js";
import { TEST_PATH, type CodeContext, type SourceFile } from "./context.js";

interface SecretPattern {
  id: string;
  re: RegExp;
  severity: Severity;
  what: string;
  /** Which capture group holds the secret itself (0 = whole match). */
  group?: number;
  fix: string;
}

const ROTATE = "Treat it as leaked: revoke it and make a new one now, then load it from an environment variable or a secrets store.";

/** Each pattern is specific to one provider, so a match is very likely real. The last one is the general catch. */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: "private-key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
    severity: "critical",
    what: "a private key",
    fix: "Anyone with this file can pose as your server or sign in to it. Make a new key pair, remove the old public key everywhere, and keep keys out of the repository.",
  },
  { id: "aws-key", re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/, group: 1, severity: "critical", what: "an AWS access key", fix: ROTATE },
  {
    id: "github-token",
    re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/,
    group: 1,
    severity: "critical",
    what: "a GitHub token",
    fix: ROTATE,
  },
  { id: "stripe-live", re: /\b((?:sk|rk)_live_[0-9a-zA-Z]{20,})\b/, group: 1, severity: "critical", what: "a live Stripe secret key", fix: ROTATE },
  { id: "anthropic-key", re: /\b(sk-ant-[A-Za-z0-9_-]{20,})/, group: 1, severity: "critical", what: "an Anthropic API key", fix: ROTATE },
  {
    id: "openai-key",
    re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{40,})/,
    group: 1,
    severity: "critical",
    what: "an OpenAI API key",
    fix: ROTATE,
  },
  { id: "slack-token", re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/, group: 1, severity: "high", what: "a Slack token", fix: ROTATE },
  {
    id: "slack-webhook",
    re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+)/,
    group: 1,
    severity: "medium",
    what: "a Slack webhook address",
    fix: "Anyone can post to your Slack channel with it. Make a new webhook and keep it in an environment variable.",
  },
  { id: "sendgrid-key", re: /\b(SG\.[\w-]{22}\.[\w-]{43})\b/, group: 1, severity: "high", what: "a SendGrid API key", fix: ROTATE },
  { id: "twilio-key", re: /\b(SK[0-9a-f]{32})\b/, group: 1, severity: "high", what: "a Twilio API key", fix: ROTATE },
  {
    id: "google-api-key",
    re: /\b(AIza[0-9A-Za-z_-]{35})\b/,
    group: 1,
    severity: "medium",
    what: "a Google API key",
    fix: "Google keys in web pages and apps are visible to everyone, so they must be restricted. In Google Cloud console, limit the key to your domains or app and to the APIs it needs. If it is a server key, rotate it.",
  },
  {
    id: "db-url",
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^:\s/"'@]+:([^@\s/"']{3,})@[^\s"'/]+/,
    group: 1,
    severity: "high",
    what: "a database address with its password",
    fix: "Change the database password, then read the address from an environment variable (DATABASE_URL).",
  },
  {
    id: "generic",
    // The key must start a word (not "new-password"), so text values like autocomplete names do not count.
    re: /(?<![-\w])(?:password|passwd|pwd|secret|api_?key|apikey|auth_?token|access_?token|client_?secret|private_?key|secret_?key)["']?\s*(?:=>|[:=])\s*["']([^"'\s]{8,})["']/i,
    group: 1,
    severity: "medium",
    what: "a hard-coded password or key",
    fix: "Move it to an environment variable or a secrets store, and change it if this repository was ever shared.",
  },
];

/** Values that are clearly not real secrets: templates, placeholders, variable names. */
const PLACEHOLDER =
  /^(\$|\{\{|<|%|process\.env|env\(|getenv|os\.environ|config\(|\$_ENV|import\.meta)|change.?me|your[_-]|example|placeholder|xxxx|\*\*\*|dummy|sample|^test|^password|^secret|^null$|^none$|^undefined$|^true$|^false$|redacted|^\.\.\.|\.\.\.$/i;
/** Files that are lists of packages or generated, where long random strings are normal. */
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|go\.sum|Cargo\.lock)$|\.(min\.js|min\.css|map|svg|lock)$/i;
const ENV_FILE = /(^|\/)\.env(\.[\w-]+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;

const mask = (s: string) => (s.length <= 8 ? `${s.slice(0, 2)}***` : `${s.slice(0, 4)}***${s.slice(-2)} (${s.length} characters)`);
const down: Record<Severity, Severity> = { critical: "high", high: "medium", medium: "low", low: "low", info: "info" };

function scanFile(file: SourceFile): Finding[] {
  const out: Finding[] = [];
  const isTest = TEST_PATH.test(file.path) || ENV_TEMPLATE.test(file.path);
  const lines = file.text.split("\n");
  for (const p of SECRET_PATTERNS) {
    if (p.id === "generic" && isTest) continue;
    let first: { line: number; value: string } | null = null;
    let count = 0;
    lines.forEach((line, i) => {
      if (line.length > 2000) return;
      const m = p.re.exec(line);
      if (!m) return;
      const value = m[p.group ?? 0] ?? m[0];
      if (p.group && PLACEHOLDER.test(value)) return;
      if (p.id === "generic" && /^[a-z_.]+$/i.test(value) && !/\d/.test(value)) return; // a variable name, not a value
      count++;
      first ??= { line: i + 1, value };
    });
    if (!first) continue;
    const hit = first as { line: number; value: string };
    out.push(
      finding({
        category: "security",
        rule: `code:secret-${p.id}`,
        severity: isTest ? down[p.severity] : p.severity,
        title: `Code contains ${p.what}`,
        detail: `${file.path} line ${hit.line} holds ${p.what}${count > 1 ? ` (${count} places in this file)` : ""}. ${p.fix}${
          isTest ? " It is in a test or example file, so it may be a dummy: check." : ""
        }`,
        pageUrl: file.path,
        evidence: `line ${hit.line}: ${p.id === "private-key" ? "-----BEGIN ... PRIVATE KEY-----" : mask(hit.value)}`,
        count,
      }),
    );
  }
  return out;
}

export const codeSecretsAgent: EngineAgent<CodeContext> = {
  id: "code.secrets",
  name: "Leaked secrets",
  description: "Finds passwords, API keys, private keys and database dumps saved in the code.",
  category: "security",
  engine: "code",
  products: ["code"],
  run({ files, allPaths, source }) {
    const out: Finding[] = [];
    for (const f of files) {
      if (SKIP_FILE.test(f.path)) continue;
      if (ENV_FILE.test(f.path) && !ENV_TEMPLATE.test(f.path)) {
        // A .env in a zip of someone's working folder is normal; in a repository it is a leak.
        if (source !== "git") continue;
        const keys = f.text.split("\n").filter((l) => /^\s*[A-Z][A-Z0-9_]*\s*=\s*\S/.test(l)).length;
        out.push(
          finding({
            category: "security",
            rule: "code:env-committed",
            severity: "high",
            title: "A .env file is saved in the repository",
            detail: `${f.path} holds ${keys} settings and is committed, so everyone with access to the repository (and its history) can read them. Remove it with git rm --cached, add .env to .gitignore, and change every password and key in it.`,
            pageUrl: f.path,
            evidence: `${keys} settings`,
          }),
        );
        continue;
      }
      out.push(...scanFile(f));
      if (/\.sql$/i.test(f.path) && f.size > 10_000 && /\bINSERT INTO\b/i.test(f.text)) {
        const rows = (f.text.match(/\bINSERT INTO\b/gi) ?? []).length;
        out.push(
          finding({
            category: "security",
            rule: "code:db-dump",
            severity: TEST_PATH.test(f.path) ? "low" : "high",
            title: "A database dump is saved in the code",
            detail: `${f.path} (${Math.round(f.size / 1000)} KB) contains ${rows} INSERT statements. Real customer or user data must not live in the code. Remove it, and keep only a schema or made-up seed data.`,
            pageUrl: f.path,
            evidence: `${rows} INSERT statements`,
          }),
        );
      }
    }
    for (const p of allPaths) {
      if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(p) && !TEST_PATH.test(p) && !files.some((f) => f.path === p && /PUBLIC KEY|CERTIFICATE/.test(f.text) && !/PRIVATE KEY/.test(f.text))) {
        if (out.some((f) => f.pageUrl === p)) continue;
        out.push(
          finding({
            category: "security",
            rule: "code:key-file",
            severity: "high",
            title: "A key or certificate store file is saved in the code",
            detail: `${p} looks like a private key or keystore. Anyone with the code can use it to sign apps or decrypt traffic. Remove it, keep it in a secure store, and replace it if the code was shared.`,
            pageUrl: p,
          }),
        );
      }
    }
    return out;
  },
};
