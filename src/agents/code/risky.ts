import { finding } from "../../runner/finding.js";
import type { Category, Finding, Severity } from "../../types.js";
import type { EngineAgent } from "../types.js";
import { TEST_PATH, type CodeContext } from "./context.js";
import { callArgs, filterFromInput, hasInput, startsWithInput, taintAt, taintOf, type Lang, type Taint } from "./taint.js";

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
  /** Only in files that also contain this (the line alone is not enough, as with a key that feeds a cipher). */
  fileHas?: RegExp;
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
  {
    id: "nosql-injection",
    files: JS,
    re: /["']?\$where["']?\s*:\s*(`[^`]*\$\{|["'][^"']*["']\s*\+|[A-Za-z_$][\w$.]*\s*\+)|\.\$where\s*\(\s*(`[^`]*\$\{|["'][^"']*["']\s*\+)/,
    severity: "high",
    title: "MongoDB $where query built by joining text (NoSQL injection)",
    fix: "$where runs JavaScript inside the database, so a value joined into it can read or change any record. Replace $where with normal query operators ($gt, $eq) and convert values with Number() or String().",
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
  {
    id: "hardcoded-crypto-key",
    files: JVM,
    codeOnly: true,
    re: /new\s+SecretKeySpec\s*\(\s*"|\bString\s+(?!\w*(?:alias|name|algo|transform|provider|header|type|mode|pref|file|path|url))\w*(?:key|secret|pass)\w*\s*=\s*"[^"]{8,}"/i,
    fileHas: /SecretKeySpec|Cipher\.getInstance/,
    severity: "high",
    title: "Encryption key is written in the code",
    fix: "Anyone with the code or the app can read the key and decrypt the data. On Android, create the key in the Android Keystore; on a server, load it from a secrets store or an environment variable.",
  },
  {
    id: "hardcoded-crypto-key",
    files: JS,
    re: /createCipheriv\s*\(\s*["'][\w-]+["']\s*,\s*["'][^"']{8,}["']|CryptoJS\.(?:AES|DES|TripleDES|Rabbit|RC4)\.(?:en|de)crypt\s*\([^,]+,\s*["'][^"']{4,}["']/,
    severity: "high",
    title: "Encryption key is written in the code",
    fix: "Anyone with the code can read the key and decrypt the data. Load the key from a secrets store or an environment variable, and never ship it in front-end code.",
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


/**
 * Calls that are dangerous when request input reaches them. Unlike CODE_RULES, these follow the
 * input through variables in the same file (see taint.ts), so `eval(req.body.preTax)` and
 * `const url = req.query.url; needle.get(url)` are caught, while the same calls on fixed values are not.
 */
interface FlowRule {
  id: string;
  lang: Lang;
  /** The call, up to and including its "(" (or where its value starts). */
  sink: RegExp;
  /**
   * Where the input must be: "start" (it is the whole URL or address, or its server), "first" (anywhere
   * in the first argument), "any" (anywhere in the call), or "filter" (it shapes a database filter).
   */
  needs: "start" | "first" | "any" | "filter";
  /** The first argument must also match this (SQL text with joined values, for example). */
  argTest?: RegExp;
  /** The whole call must also match this (shell=True, for example). */
  callTest?: RegExp;
  /** Only for projects that use MongoDB, and do not clean input with mongo-sanitize. */
  mongo?: boolean;
  severity: Severity;
  title: string;
  fix: string;
}

const JOINED = /\$\{|["'`]\s*\+|\+\s*["'`]|["']\s*%\s*[\w(]|\.format\s*\(|^\s*f["']/;
const SQL_TEXT = new RegExp(SQL, "i");
const SSRF_FIX =
  "Anyone can make your server fetch any address, including internal ones (cloud metadata at 169.254.169.254, admin panels, databases). Only allow a fixed list of hosts, or map a short name from the request to a URL you choose.";
const REDIRECT_FIX =
  "Attackers send links that open your site and land on their look-alike page (phishing). Only redirect to your own paths: accept values that start with a single \"/\" (not \"//\"), or pick from a list of allowed addresses.";

export const FLOW_RULES: FlowRule[] = [
  // ---- JavaScript and TypeScript
  {
    id: "eval",
    lang: "js",
    sink: /(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(|\bvm\.run\w*\s*\(|(?<![\w$.])setTimeout\s*\(\s*(?=["'`]|req\b)/,
    needs: "any",
    severity: "critical",
    title: "Request input is run as code (eval)",
    fix: "Anyone can run any code on the server, read its files and take it over. Never eval input: use Number() or parseInt() for numbers (eval(req.body.preTax) becomes Number(req.body.preTax)) and JSON.parse for data.",
  },
  {
    id: "command-injection",
    lang: "js",
    sink: /(?<![\w$])(?:child_process\.|cp\.)?(?:exec|execSync)\s*\(/,
    needs: "first",
    severity: "critical",
    title: "Request input is put into a shell command (command injection)",
    fix: "Anyone can run commands on the server by adding ; or && to the value. Use execFile or spawn with an array of arguments, and check the value against a list of allowed values.",
  },
  {
    id: "sql-injection",
    lang: "js",
    sink: /(?<![\w$])(?:[\w$]+\.)?(?:query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(/,
    needs: "first",
    argTest: JOINED,
    severity: "critical",
    title: "Request input is joined into SQL (SQL injection)",
    fix: "Anyone can read or change the whole database with a crafted value. Pass values as parameters (?, $1 or :name) instead of joining them into the SQL text.",
  },
  {
    id: "nosql-injection",
    lang: "js",
    sink: /["']?\$where["']?\s*:\s*/,
    needs: "first",
    severity: "critical",
    title: "Request input is run in a MongoDB $where query (NoSQL injection)",
    fix: "$where runs JavaScript inside the database, so input there can read or change any record. Replace $where with normal query operators ($gt, $eq) and convert the values with Number() or String().",
  },
  {
    id: "nosql-injection",
    lang: "js",
    sink: /\.(?:find|findOne|findOneAndUpdate|findOneAndDelete|findOneAndRemove|findOneAndReplace|updateOne|updateMany|deleteOne|deleteMany|remove|count|countDocuments|exists)\s*\(/,
    needs: "filter",
    mongo: true,
    severity: "high",
    title: "Database filter is built straight from request data (NoSQL injection)",
    fix: 'A visitor can send {"$ne": ""} instead of a value and match any record, for example to log in without the password. Convert each value with String() (or validate it), or clean all input with express-mongo-sanitize, or turn on mongoose.set("sanitizeFilter", true).',
  },
  {
    id: "ssrf",
    lang: "js",
    sink: /(?<![\w$.])(?:axios(?:\.(?:get|post|put|patch|delete|head|request))?|got(?:\.(?:get|post|stream))?|needle(?:\.(?:get|post|put|request|head))?|superagent\.(?:get|post)|request(?:\.(?:get|post))?|fetch|https?\.(?:get|request)|phin|undici\.request)\s*\(/,
    needs: "start",
    severity: "high",
    title: "Server fetches an address from the request (SSRF)",
    fix: SSRF_FIX,
  },
  {
    id: "open-redirect",
    lang: "js",
    sink: /\b(?:res|response|reply|ctx|h)\.(?:redirect|location)\s*\(/,
    needs: "start",
    severity: "medium",
    title: "Redirects to an address from the request (open redirect)",
    fix: REDIRECT_FIX,
  },
  {
    id: "prototype-pollution",
    lang: "js",
    sink: /(?<![\w$])(?:_|lodash|Hoek|hoek)\.(?:merge|mergeWith|defaultsDeep|set|setWith|zipObjectDeep|applyToDefaults)\s*\(|(?<![\w$])(?:\$|jQuery)\.extend\s*\(\s*true\s*,|(?<![\w$.])(?:deepmerge|deepExtend|mergeDeep|defaultsDeep)\s*\(/,
    needs: "any",
    severity: "high",
    title: "Request data is deep-merged into an object (prototype pollution)",
    fix: 'A body like {"__proto__": {"isAdmin": true}} changes every object in the app, which can skip login checks or crash it. Copy only the fields you expect, or drop the keys __proto__, constructor and prototype first, and keep lodash at 4.17.21 or later.',
  },
  // ---- Python
  {
    id: "eval",
    lang: "py",
    sink: /(?<![\w.])(?:eval|exec)\s*\(/,
    needs: "any",
    severity: "critical",
    title: "Request input is run as code (eval)",
    fix: "Anyone can run any code on the server. Use int(), float() or json.loads for data, or a dictionary of allowed functions.",
  },
  {
    id: "command-injection",
    lang: "py",
    sink: /\bos\.(?:system|popen)\s*\(/,
    needs: "any",
    severity: "critical",
    title: "Request input is put into a shell command (command injection)",
    fix: 'Call subprocess.run(["cmd", value]) with a list and without shell=True, and check the value against a list of allowed values.',
  },
  {
    id: "command-injection",
    lang: "py",
    // Without shell=True, a list of arguments never reaches a shell.
    sink: /\bsubprocess\.\w+\s*\(/,
    needs: "any",
    callTest: /shell\s*=\s*True/,
    severity: "critical",
    title: "Request input is put into a shell command (command injection)",
    fix: 'Call subprocess.run(["cmd", value]) with a list and without shell=True, and check the value against a list of allowed values.',
  },
  {
    id: "sql-injection",
    lang: "py",
    sink: /\.execute(?:many)?\s*\(/,
    needs: "first",
    argTest: JOINED,
    severity: "critical",
    title: "Request input is joined into SQL (SQL injection)",
    fix: 'Pass values separately: cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))',
  },
  {
    id: "ssrf",
    lang: "py",
    sink: /(?<![\w.])(?:requests\.(?:get|post|put|patch|delete|head)|urllib\.request\.urlopen|urlopen|httpx\.(?:get|post|stream))\s*\(/,
    needs: "start",
    severity: "high",
    title: "Server fetches an address from the request (SSRF)",
    fix: SSRF_FIX,
  },
  {
    id: "open-redirect",
    lang: "py",
    sink: /(?<![\w.])(?:redirect|HttpResponseRedirect)\s*\(/,
    needs: "start",
    severity: "medium",
    title: "Redirects to an address from the request (open redirect)",
    fix: `${REDIRECT_FIX} In Django, url_has_allowed_host_and_scheme() does this check.`,
  },
  // ---- PHP
  {
    id: "eval",
    lang: "php",
    sink: /(?<![\w>$])(?:eval|assert|create_function)\s*\(/,
    needs: "any",
    severity: "critical",
    title: "Request input is run as code (eval)",
    fix: "Anyone can run any code on the server. Remove eval; use a switch or an array of allowed functions instead.",
  },
  {
    id: "command-injection",
    lang: "php",
    sink: /(?<![\w>$])(?:system|exec|shell_exec|passthru|popen|proc_open)\s*\(/,
    needs: "first",
    severity: "critical",
    title: "Request input is put into a shell command (command injection)",
    fix: "Never pass request input to a shell. If you must, wrap each argument in escapeshellarg() and check it against a list of allowed values.",
  },
  {
    id: "sql-injection",
    lang: "php",
    sink: /(?:mysqli?_query|->query|->exec|pg_query|->prepare)\s*\(/,
    needs: "any",
    callTest: SQL_TEXT,
    severity: "critical",
    title: "Request input is joined into SQL (SQL injection)",
    fix: "Use prepared statements: $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?'); $stmt->execute([$id]);",
  },
  {
    id: "ssrf",
    lang: "php",
    sink: /(?<![\w>$])(?:file_get_contents|fopen|curl_init|readfile|get_headers|simplexml_load_file)\s*\(|\bcurl_setopt\s*\(\s*[^,]+,\s*CURLOPT_URL\s*,/,
    needs: "start",
    severity: "high",
    title: "Server fetches an address or file named in the request (SSRF)",
    fix: `${SSRF_FIX} For files, map the value to a fixed list of file names.`,
  },
  {
    id: "open-redirect",
    lang: "php",
    sink: /\bheader\s*\(\s*["']Location:\s*["']\s*\.\s*|\bheader\s*\(\s*"Location:\s*(?=\$)|(?<![\w>$])(?:wp_redirect|redirect)\s*\(|->(?:away|to)\s*\(/,
    needs: "start",
    severity: "medium",
    title: "Redirects to an address from the request (open redirect)",
    fix: `${REDIRECT_FIX} In WordPress, wp_safe_redirect() does this check.`,
  },
];

const LANG_OF = (path: string): Lang | undefined => (JS.test(path) ? "js" : PY.test(path) ? "py" : PHP.test(path) ? "php" : undefined);

/** True when request input reaches the call that starts at `rest` (just after the sink). */
export function flowHits(rule: FlowRule, scope: Taint, rest: string): boolean {
  const args = callArgs(rest);
  const first = args[0] ?? "";
  if (rule.callTest && !rule.callTest.test(args.join(","))) return false;
  if (rule.argTest && !rule.argTest.test(first)) return false;
  switch (rule.needs) {
    case "any":
      return hasInput(scope, args.join(","));
    case "first":
      return hasInput(scope, first);
    case "filter":
      return filterFromInput(scope, first);
    case "start": {
      // redirect(302, url): the address is the second argument.
      const target = /^\s*\d{3}\s*$/.test(first) && args[1] !== undefined ? args[1] : first;
      // axios({ url }) and similar: the address is a field.
      if (target.trim().startsWith("{")) {
        const m = /\b(?:url|uri|baseURL|host|hostname)\s*:\s*([^,}]+)/.exec(target);
        return Boolean(m && startsWithInput(scope, m[1]));
      }
      return startsWithInput(scope, target);
    }
  }
}

/** Projects that use MongoDB, and whether they clean input of $ operators everywhere. */
function mongoUse(files: CodeContext["files"]): { mongo: boolean; sanitized: boolean } {
  let mongo = false;
  let sanitized = false;
  for (const f of files) {
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f.path)) continue;
    if (/require\(\s*["'](?:mongoose|mongodb|monk|mongojs)["']\s*\)|from\s+["'](?:mongoose|mongodb)["']|"(?:mongoose|mongodb)"\s*:/.test(f.text)) mongo = true;
    if (/mongo-sanitize|sanitizeFilter["']?\s*,\s*true/.test(f.text)) sanitized = true;
  }
  return { mongo, sanitized };
}

export const codeRiskyAgent: EngineAgent<CodeContext> = {
  id: "code.risky",
  name: "Risky code",
  description: "Looks for SQL and command injection, eval, XSS, weak password hashing, turned-off HTTPS checks and debug mode (PHP, JavaScript, Python, Java, Kotlin).",
  category: "security",
  engine: "code",
  products: ["code"],
  run({ files }) {
    const out: Finding[] = [];
    const db = mongoUse(files);
    for (const file of files) {
      if (/\.min\.js$|\.bundle\.js$/i.test(file.path)) continue;
      const isTest = TEST_PATH.test(file.path);
      const rules = CODE_RULES.filter((r) => r.files.test(file.path) && (r.inTests || !isTest) && (!r.fileHas || r.fileHas.test(file.text)));
      const lines = file.text.split("\n");
      const done = new Set<string>();
      // First the calls that request input reaches: they are the surest and the most severe, so a
      // file gets that finding instead of the weaker pattern-only one below.
      const lang = LANG_OF(file.path);
      if (lang && !isTest) {
        const taint = taintOf(lines, lang);
        for (const rule of FLOW_RULES) {
          if (rule.lang !== lang || done.has(rule.id) || (rule.mongo && (!db.mongo || db.sanitized))) continue;
          let first = -1;
          let count = 0;
          lines.forEach((line, i) => {
            if (line.length > 400 || /^\s*(\/\/|#(?!include)|\*|\/\*)/.test(line)) return;
            if (/glvtest-ignore/.test(line) || /glvtest-ignore/.test(lines[i - 1] ?? "")) return;
            for (const m of line.matchAll(new RegExp(rule.sink.source, `${rule.sink.flags.replace("g", "")}g`))) {
              if (inLiteral(line, m.index)) continue;
              const rest = `${line.slice(m.index + m[0].length)}\n${lines.slice(i + 1, i + 4).join("\n")}`;
              if (!flowHits(rule, taintAt(taint, i), rest)) continue;
              count++;
              if (first < 0) first = i;
              break;
            }
          });
          if (first < 0) continue;
          done.add(rule.id);
          out.push(
            finding({
              category: "security",
              rule: `code:${rule.id}`,
              severity: rule.severity,
              title: rule.title,
              detail: `${file.path} line ${first + 1}${count > 1 ? ` (and ${count - 1} more in this file)` : ""}. The value comes from the request. ${rule.fix}`,
              pageUrl: file.path,
              evidence: `line ${first + 1}: ${lines[first].trim().slice(0, 160)}`,
              count,
            }),
          );
        }
      }
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
