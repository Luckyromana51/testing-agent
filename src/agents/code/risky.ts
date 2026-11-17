import { finding } from "../../runner/finding.js";
import type { Category, Finding, Severity } from "../../types.js";
import type { EngineAgent } from "../types.js";
import { TEST_PATH, type CodeContext } from "./context.js";

interface CodeRule {
  id: string;
  /** File names the rule applies to. */
  files: RegExp;
  re: RegExp;
  severity: Severity;
  category?: Category;
  title: string;
  fix: string;
  /** Also look in test files. */
  inTests?: boolean;
  /** The risky part is code, so a match inside a string, regex or comment does not count. */
  codeOnly?: boolean;
}

/**
 * True when position `at` of a line is inside a string, a regex literal or a trailing comment.
 * A small lexer: enough to tell `el.innerHTML = x` from a message that mentions innerHTML.
 */
export function inLiteral(line: string, at: number): boolean {
  let quote = "";
  let regex = false;
  let prev = "";
  for (let i = 0; i < at; i++) {
    const c = line[i];
    if (quote || regex) {
      if (c === "\\") i++;
      else if (quote && c === quote) quote = "";
      else if (regex && c === "/") regex = false;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return true;
    if (c === "#" && /^\s*$/.test(line.slice(0, i))) return true;
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && (prev === "" || /[=:(,[!&|?{};]/.test(prev))) regex = true;
    if (!/\s/.test(c)) prev = c;
  }
  return Boolean(quote || regex);
}

const JS = /\.(m?[jt]sx?|cjs|vue|svelte)$/i;
const PHP = /\.(php|phtml|inc)$/i;
const PY = /\.py$/i;
const JVM = /\.(java|kt)$/i;
const USER = String.raw`\$_(GET|POST|REQUEST|COOKIE)`;
const SQL = String.raw`\b(SELECT|INSERT|UPDATE|DELETE)\b`;

/**
 * Patterns for code that is often a real hole. Each one names the risk and the safe way to write it.
 * They read single lines, so they are hints for a developer to confirm, not proof.
 */
export const CODE_RULES: CodeRule[] = [
  // ---- SQL injection
  {
    id: "sql-injection",
    files: JS,
    re: new RegExp(String.raw`\b(query|execute|raw|prepare|\$queryRawUnsafe)\s*\(\s*(\x60[^\x60]*${SQL}[^\x60]*\$\{|["'][^"']*${SQL}[^"']*["']\s*\+)`, "i"),
    severity: "high",
    title: "SQL query built by joining text (SQL injection risk)",
    fix: "Pass values as parameters (?, $1 or :name) instead of putting them into the SQL text.",
  },
  {
    id: "sql-injection",
    files: PHP,
    re: new RegExp(String.raw`(mysqli?_query|->query|->exec|pg_query)\s*\(.*${USER}|["'][^"']*${SQL}[^"']*["']\s*\.\s*${USER}|"[^"]*${SQL}[^"]*${USER}`, "i"),
    severity: "critical",
    title: "SQL query built by joining text (SQL injection risk)",
    fix: "Use prepared statements: $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?'); $stmt->execute([$id]);",
  },
  {
    id: "sql-injection",
    files: PHP,
    re: new RegExp(String.raw`"\s*${SQL}[^"]*\$[a-z_]\w*`, "i"),
    severity: "medium",
    title: "SQL query built by joining text (SQL injection risk)",
    fix: "Use prepared statements with placeholders instead of putting $variables inside the SQL text.",
  },
  {
    id: "sql-injection",
    files: PY,
    re: /\.execute\s*\(\s*(f["'][^"']*\{|["'][^"']*["']\s*(%|\+)\s*[\w(]|["'][^"']*\{\}[^"']*["']\s*\.format)/,
    severity: "high",
    title: "SQL query built by joining text (SQL injection risk)",
    fix: 'Pass values separately: cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))',
  },
  {
    id: "sql-injection",
    files: JVM,
    re: new RegExp(String.raw`(createQuery|createNativeQuery|executeQuery|executeUpdate|prepareStatement|rawQuery|execSQL)\s*\(\s*"[^"]*${SQL}[^"]*"\s*\+`, "i"),
    severity: "high",
    title: "SQL query built by joining text (SQL injection risk)",
    fix: "Use a PreparedStatement with ? placeholders, or query parameters in JPA.",
  },
  // ---- Command injection and code execution
  {
    id: "command-injection",
    files: JS,
    re: /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|[^,)]*\+\s*\w)/,
    severity: "high",
    title: "Shell command built from variables (command injection risk)",
    fix: "Use execFile or spawn with an array of arguments, so input can never become part of the command.",
  },
  {
    id: "command-injection",
    files: PHP,
    re: new RegExp(String.raw`\b(system|exec|shell_exec|passthru|popen|proc_open)\s*\(.*${USER}`),
    severity: "critical",
    title: "Shell command built from variables (command injection risk)",
    fix: "Never pass request input to a shell. If you must, wrap each argument in escapeshellarg() and check it against a list of allowed values.",
  },
  {
    id: "command-injection",
    files: PY,
    re: /subprocess\.\w+\([^)]*shell\s*=\s*True|\bos\.system\s*\(/,
    severity: "medium",
    title: "Shell command built from variables (command injection risk)",
    fix: 'Call subprocess.run(["cmd", arg]) with a list and without shell=True.',
  },
  {
    id: "command-injection",
    files: JVM,
    re: /Runtime\.getRuntime\(\)\.exec\s*\([^)]*\+/,
    severity: "medium",
    title: "Shell command built from variables (command injection risk)",
    fix: "Use ProcessBuilder with a list of arguments.",
  },
  {
    id: "eval",
    files: JS,
    codeOnly: true,
    re: /(^|[^.\w$])eval\s*\(|new Function\s*\(/,
    severity: "medium",
    title: "Text is run as code (eval)",
    fix: "Replace eval with JSON.parse for data, or a lookup table for dynamic names.",
  },
  {
    id: "eval",
    files: PHP,
    re: new RegExp(String.raw`\b(eval|assert)\s*\(\s*\$|preg_replace\s*\(\s*["'][^"']*/e["']`),
    severity: "high",
    title: "Text is run as code (eval)",
    fix: "Remove eval. Use a switch or an array of allowed functions instead.",
  },
  {
    id: "eval",
    files: PY,
    codeOnly: true,
    re: /(^|[^.\w])(eval|exec)\s*\(/,
    severity: "medium",
    title: "Text is run as code (eval)",
    fix: "Use ast.literal_eval for data, or a dictionary of allowed functions.",
  },
  {
    id: "file-include",
    files: PHP,
    re: new RegExp(String.raw`\b(include|require)(_once)?\s*\(?\s*[^;]*${USER}`),
    severity: "critical",
    title: "File loaded from a name in the request (file inclusion)",
    fix: "Map the request value to a fixed list of files: $pages = ['home' => 'home.php']; include $pages[$key] ?? 'home.php';",
  },
  {
    id: "unsafe-deserialize",
    files: PHP,
    re: new RegExp(String.raw`\bunserialize\s*\(\s*[^)]*${USER}`),
    severity: "high",
    title: "Request data is unserialized (object injection)",
    fix: "Use json_decode for data from users.",
  },
  {
    id: "unsafe-deserialize",
    files: PY,
    re: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Loader)/,
    severity: "medium",
    title: "Request data is unserialized (object injection)",
    fix: "Use json, or yaml.safe_load, for data that could come from outside.",
  },
  // ---- Cross-site scripting
  {
    id: "xss",
    files: PHP,
    re: new RegExp(String.raw`\b(echo|print)\s+[^;]*${USER}|<\?=\s*${USER}`),
    severity: "high",
    title: "Request input is printed without escaping (XSS)",
    fix: "Escape on output: echo htmlspecialchars($_GET['q'], ENT_QUOTES, 'UTF-8');",
  },
  {
    id: "xss",
    files: JS,
    codeOnly: true,
    re: /\.(innerHTML|outerHTML)\s*[+]?=\s*(?!\s*(["'`])[^"'`$]*\2\s*;?\s*$)|dangerouslySetInnerHTML|document\.write\s*\(/,
    severity: "low",
    title: "Raw HTML is written into the page (XSS risk)",
    fix: "Use textContent for text. If HTML is needed, clean it first with DOMPurify.",
  },
  // ---- Weak crypto and TLS
  {
    id: "weak-password-hash",
    files: PHP,
    re: /\b(md5|sha1)\s*\(\s*\$_?(POST\[['"]pass|pass)/i,
    severity: "high",
    title: "Passwords are stored with MD5 or SHA-1",
    fix: "Use password_hash($password, PASSWORD_DEFAULT) and password_verify(). Re-hash old passwords at the next login.",
  },
  {
    id: "weak-password-hash",
    files: /\.(m?[jt]sx?|py)$/i,
    re: /(createHash\s*\(\s*["'](md5|sha1)["']\s*\)|hashlib\.(md5|sha1)\s*\()[^\n]*pass/i,
    severity: "high",
    title: "Passwords are stored with MD5 or SHA-1",
    fix: "Use bcrypt, scrypt or Argon2 for passwords.",
  },
  {
    id: "tls-verify-off",
    files: JS,
    codeOnly: true,
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/,
    severity: "medium",
    title: "HTTPS certificate checks are turned off",
    fix: "Remove rejectUnauthorized: false. For a private certificate authority, pass its certificate with the ca option instead.",
  },
  {
    id: "tls-verify-off",
    files: PY,
    codeOnly: true,
    re: /verify\s*=\s*False/,
    severity: "medium",
    title: "HTTPS certificate checks are turned off",
    fix: "Remove verify=False. Point verify at your certificate bundle if you use a private authority.",
  },
  {
    id: "tls-verify-off",
    files: PHP,
    codeOnly: true,
    re: /CURLOPT_SSL_VERIFYPEER\s*,\s*(false|0)/i,
    severity: "medium",
    title: "HTTPS certificate checks are turned off",
    fix: "Remove CURLOPT_SSL_VERIFYPEER false, and keep the server's CA bundle up to date.",
  },
  {
    id: "tls-verify-off",
    files: JVM,
    codeOnly: true,
    re: /checkServerTrusted\s*\([^)]*\)\s*(throws [\w.]+\s*)?\{\s*\}|ALLOW_ALL_HOSTNAME_VERIFIER|setHostnameVerifier\s*\(\s*\(?[^)]*\)?\s*->\s*true/,
    severity: "high",
    title: "HTTPS certificate checks are turned off",
    fix: "Remove the trust-all TrustManager or HostnameVerifier. Use certificate pinning through Android's network security config if needed.",
  },
  // ---- Debug left on
  {
    id: "debug-on",
    files: /(^|\/)settings[\w-]*\.py$/i,
    re: /^\s*DEBUG\s*=\s*True\b/,
    severity: "medium",
    title: "Debug mode is on in the settings",
    fix: "Read it from the environment: DEBUG = os.environ.get('DEBUG') == '1', and keep it off in production.",
  },
  {
    id: "debug-on",
    files: PHP,
    re: /ini_set\s*\(\s*["']display_errors["']\s*,\s*["']?(1|on|true)["']?\s*\)|error_reporting\s*\(\s*E_ALL\s*\)\s*;\s*ini_set\s*\(\s*["']display_errors/i,
    severity: "medium",
    title: "Debug mode is on in the settings",
    fix: "Turn display_errors off in production and log errors to a file instead.",
  },
  {
    id: "debugger",
    files: JS,
    codeOnly: true,
    re: /^\s*debugger\s*;?\s*$/,
    severity: "medium",
    category: "functional",
    title: "A debugger statement was left in the code",
    fix: "Remove it: it pauses the app for anyone with developer tools open.",
  },
  // ---- Unfinished merges break the build
  {
    id: "merge-conflict",
    files: /\.(m?[jt]sx?|cjs|vue|svelte|php|py|java|kt|rb|go|cs|css|scss|html?|json|ya?ml|xml)$/i,
    re: /^(<{7}|>{7})( |$)/,
    severity: "high",
    category: "functional",
    title: "Unresolved merge conflict in the code",
    fix: "Open the file, keep the right version between the <<<<<<< and >>>>>>> markers, and delete the markers.",
    inTests: true,
  },
];

export const codeRiskyAgent: EngineAgent<CodeContext> = {
  id: "code.risky",
  name: "Risky code",
  description: "Looks for SQL and command injection, eval, XSS, weak password hashing, turned-off HTTPS checks and debug mode (PHP, JavaScript, Python, Java, Kotlin).",
  category: "security",
  engine: "code",
  products: ["code"],
  run({ files }) {
    const out: Finding[] = [];
    for (const file of files) {
      if (/\.min\.js$|\.bundle\.js$/i.test(file.path)) continue;
      const isTest = TEST_PATH.test(file.path);
      const rules = CODE_RULES.filter((r) => r.files.test(file.path) && (r.inTests || !isTest));
      if (!rules.length) continue;
      const lines = file.text.split("\n");
      const done = new Set<string>();
      for (const rule of rules) {
        if (done.has(rule.id)) continue;
        let first = -1;
        let count = 0;
        lines.forEach((line, i) => {
          if (line.length > 400) return; // minified or generated
          const code = line.trimStart();
          if (/^(\/\/|#(?!include)|\*|\/\*)/.test(code)) return; // comments
          const m = rule.re.exec(line);
          if (!m) return;
          // A reviewed line can be marked safe with a "glvtest-ignore" comment on it or just above it.
          if (/glvtest-ignore/.test(line) || /glvtest-ignore/.test(lines[i - 1] ?? "")) return;
          // Point at the risky token itself, not the separator character some patterns start with.
          const at = m.index + (m[1] !== undefined && m[0].startsWith(m[1]) ? m[1].length : 0);
          if (rule.codeOnly && inLiteral(line, at)) return;
          count++;
          if (first < 0) first = i;
        });
        if (first < 0) continue;
        done.add(rule.id);
        out.push(
          finding({
            category: rule.category ?? "security",
            rule: `code:${rule.id}`,
            severity: rule.severity,
            title: rule.title,
            detail: `${file.path} line ${first + 1}${count > 1 ? ` (and ${count - 1} more in this file)` : ""}. ${rule.fix}`,
            pageUrl: file.path,
            evidence: `line ${first + 1}: ${lines[first].trim().slice(0, 160)}`,
            count,
          }),
        );
      }
    }
    return out;
  },
};
