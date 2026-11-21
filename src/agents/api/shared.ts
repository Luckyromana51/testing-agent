import type { ApiOperation } from "../../engines/openapi.js";
import type { EngineAgent } from "../types.js";
import type { ApiContext } from "./context.js";

export type ApiAgent = EngineAgent<ApiContext>;

/** The documented response for a status: exact code, then "2XX", then "default". */
export function documentedResponse(op: ApiOperation, status: number) {
  return op.responses[String(status)] ?? op.responses[`${String(status)[0]}XX`] ?? op.responses.default;
}

/** Error text that shows internals (database errors, stack traces, debug pages). */
const LEAKS: { re: RegExp; what: string }[] = [
  { re: /SQLSTATE\[|You have an error in your SQL syntax|\bORA-\d{5}\b|PG::\w+Error|psycopg2\.|SQLITE_ERROR|Unclosed quotation mark|invalid input syntax for (type )?\w+|mysqli?_\w+\(\)/i, what: "a database error" },
  { re: /Werkzeug Debugger|Whoops! There was an error|Illuminate\\|Symfony\\Component\\|ActiveRecord::\w+|django\.(core|db)\./, what: "a framework debug page" },
  { re: /Traceback \(most recent call last\)/, what: "a Python traceback" },
  { re: /(Fatal error|Parse error|Warning|Notice|Uncaught \w+):? .{0,200} in \/[\w./-]+(?: on line |:)\d+/, what: "a PHP error with a file path" },
  { re: /Stack trace:\s*#0/, what: "a PHP stack trace" },
  { re: /System\.\w+Exception|\bat [\w.]+\(.*\) in [\w:\\/.]+:line \d+/, what: "a .NET exception" },
  { re: /\bat [\w.$]+\([\w$]+\.java:\d+\)/, what: "a Java stack trace" },
  { re: /\bat [\w.<>$\s]+\(?(?:file:\/\/)?[\w./\\:@-]+\.(?:js|ts|mjs|cjs):\d+:\d+\)?/, what: "a Node.js stack trace" },
];

export function findLeak(text: string): { what: string; snippet: string } | null {
  const sample = text.slice(0, 50_000);
  for (const { re, what } of LEAKS) {
    const m = re.exec(sample);
    if (m) {
      return { what, snippet: sample.slice(m.index, m.index + 160).split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

