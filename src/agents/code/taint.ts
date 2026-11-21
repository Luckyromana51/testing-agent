/**
 * A small, single-file data-flow check: which variables hold request input, and whether a call
 * receives it. It reads assignments line by line (two passes, so `a = req.query.x; b = a + "/"`
 * marks both), which is enough to tell `needle.get(url)` with a URL from the request apart from
 * one with a fixed address. It does not follow values into other files or functions.
 */

export type Lang = "js" | "py" | "php";

/** "object": the value may be a whole object the visitor shaped (JSON body, ?a[b]=c). "text": any other input. */
export type InputKind = "object" | "text";

/** The variables holding request input at one line of a file. */
export interface Taint {
  lang: Lang;
  names: Map<string, InputKind>;
}

/** Every assignment in a file, so each line sees the value a name holds there. */
export interface FileTaint {
  lang: Lang;
  /** For each name, its assignments in order: the line, and the input kind (null when not input). */
  events: Map<string, { line: number; kind: InputKind | null }[]>;
}

/** How far down a file an assignment is still trusted to be the one in use (about one handler). */
const REACH = 80;

/** Request input that can be an object the visitor shaped (JSON bodies, query strings with brackets). */
const OBJECT_INPUT: Record<Lang, RegExp> = {
  js: /\b(?:req|request)\.(?:body|query|cookies|signedCookies)\b|\bctx\.(?:request\.(?:body|query)|query)\b/,
  py: /\brequest\.(?:json|get_json\s*\(|data)\b/,
  php: /\$_(?:GET|POST|REQUEST)\b/,
};

/** Any request input. */
const ANY_INPUT: Record<Lang, RegExp> = {
  js: new RegExp(
    `${OBJECT_INPUT.js.source}|\\b(?:req|request)\\.(?:params|headers|param\\s*\\(|get\\s*\\(|header\\s*\\()|\\bctx\\.(?:params|headers|get\\s*\\()`,
  ),
  py: /\brequest\.(?:args|form|values|json|data|files|cookies|headers|GET|POST|query_params|get_json\s*\()/,
  php: /\$_(?:GET|POST|REQUEST|COOKIE|FILES)\b|\$_SERVER\s*\[\s*["'](?:HTTP_\w+|QUERY_STRING|REQUEST_URI)["']|\$request->(?:input|get|query|post|all)\s*\(|\$this->input->(?:get|post)\s*\(/,
};

const ASSIGN: Record<Lang, RegExp> = {
  // const a = ..., let { a, b: c } = ..., a = ... (not obj.a = ..., a == b or a => b)
  js: /(?:^|[^\w$.])(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*|\{[^}]*\}|\[[^\]]*\])\s*=(?![=>])\s*(.+)/,
  py: /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)\s*(.+)/,
  php: /(\$[A-Za-z_]\w*)\s*=(?![=>])\s*(.+)/,
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A regex that finds a use of the variable as a whole name (not `obj.name` or `myname`). */
function nameRe(lang: Lang, name: string): RegExp {
  return lang === "php" ? new RegExp(`${escape(name)}(?![\\w])`) : new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`);
}

/** The names bound by the left side of an assignment, including destructuring (`{ a, b: c, d = 1 }`). */
function boundNames(lhs: string): string[] {
  if (!/^[{[]/.test(lhs) && !lhs.includes(",")) return [lhs];
  return lhs
    .replace(/^[{[]|[}\]]$/g, "")
    .split(",")
    .map((part) => part.split(":").pop()!.split("=")[0].replace(/^\s*\.\.\./, "").trim())
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

/** Whether the right side hands over the input itself (an object the visitor shaped), not text made from it. */
function passesObject(lang: Lang, rhs: string, names: Map<string, InputKind>): boolean {
  const value = rhs.replace(/;\s*$/, "").replace(/\s*(\|\||\?\?|\bor\b).*$/, "").trim();
  if (lang === "js" && /^(?:req|request)\.(?:body|query|cookies)(?:\.[\w$]+|\[["'][^"']+["']\])*$/.test(value)) return true;
  if (lang === "js" && /^ctx\.(?:request\.(?:body|query)|query)(?:\.[\w$]+)*$/.test(value)) return true;
  if (lang === "py" && /^request\.(?:json|get_json\(\s*\))(?:\[["'][^"']+["']\])*$/.test(value)) return true;
  if (lang === "php" && /^\$_(?:GET|POST|REQUEST)\s*\[\s*["'][^"']+["']\s*\]$/.test(value)) return true;
  return names.get(value) === "object";
}

/** The result of a database lookup or a check is data the app chose, not the visitor's input. */
const LOOKUP = /^\s*(?:await|yield|new)\b|^\s*[\w$]+(?:\.[\w$]+)*\.(?:find\w*|query|exec\w*|count\w*|aggregate|select|where|lookup|create|insert\w*|update\w*|save|authenticate|verify|compare\w*|objects\.\w+|filter|get_or_\w+)\s*\(/;

/** Finds, line by line, which variables of a file hold request input. */
export function taintOf(lines: string[], lang: Lang): FileTaint {
  const t: FileTaint = { lang, events: new Map() };
  lines.forEach((line, i) => {
    if (line.length > 400) return;
    const m = ASSIGN[lang].exec(line);
    if (!m) return;
    const [, lhs, rhs] = m;
    const scope = taintAt(t, i);
    const input = !LOOKUP.test(rhs) && hasInput(scope, rhs);
    const kind: InputKind | null = input ? (passesObject(lang, rhs, scope.names) ? "object" : "text") : null;
    for (const n of boundNames(lhs.trim())) {
      const list = t.events.get(n) ?? [];
      list.push({ line: i, kind });
      t.events.set(n, list);
    }
  });
  return t;
}

/** The names that hold request input at a line: each name's latest assignment above it, if recent. */
export function taintAt(t: FileTaint, line: number): Taint {
  const names = new Map<string, InputKind>();
  for (const [n, list] of t.events) {
    let last: { line: number; kind: InputKind | null } | undefined;
    for (const e of list) if (e.line < line) last = e;
    if (last?.kind && line - last.line <= REACH) names.set(n, last.kind);
  }
  return { lang: t.lang, names };
}

/** True when the text uses request input, directly or through a variable that holds it. */
export function hasInput(t: Taint, text: string, onlyObjects = false): boolean {
  if ((onlyObjects ? OBJECT_INPUT : ANY_INPUT)[t.lang].test(text)) return true;
  for (const [n, kind] of t.names) {
    if (onlyObjects && kind !== "object") continue;
    if (nameRe(t.lang, n).test(text)) return true;
  }
  return false;
}

/** True when the expression begins with request input, so the visitor controls all of it (a whole URL). */
export function startsWithInput(t: Taint, expr: string): boolean {
  const e = expr
    .trim()
    // A template or f-string that begins with the input: `${url}/x`, f"{url}/x"
    .replace(/^`\$\{\s*/, "")
    .replace(/^f["']\{\s*/, "")
    // "http://" + host, `https://${host}`: the visitor picks the server.
    .replace(/^(["'`])https?:\/\/\1\s*(\+|\.)\s*/, "")
    .replace(/^`https?:\/\/\$\{\s*/, "")
    .replace(/^f["']https?:\/\/\{\s*/, "");
  const head = e.slice(0, 120);
  const at = (re: RegExp) => {
    const m = re.exec(head);
    return Boolean(m && m.index === 0);
  };
  if (at(new RegExp(ANY_INPUT[t.lang].source))) return true;
  for (const n of t.names.keys()) if (at(nameRe(t.lang, n))) return true;
  return false;
}

/** The arguments of a call, from just after its "(" to the matching ")" (strings and nesting respected). */
export function callArgs(rest: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) {
        args.push(rest.slice(start, i));
        return args;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(rest.slice(start, i));
      start = i + 1;
    }
  }
  args.push(rest.slice(start));
  return args;
}

/**
 * True when a database filter is shaped by the visitor: the whole input object (`find(req.body)`),
 * or a field set straight from it (`{ username: req.body.username }`), which lets `{"$ne": ""}` through.
 */
export function filterFromInput(t: Taint, arg: string): boolean {
  const a = arg.trim();
  if (passesObject(t.lang, a, t.names)) return true;
  if (!a.startsWith("{")) return false;
  for (const m of a.matchAll(/:\s*([^,}\n]+)/g)) {
    if (passesObject(t.lang, m[1].trim(), t.names)) return true;
  }
  return false;
}
