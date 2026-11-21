/**
 * Reads a JMeter test plan (.jmx) and decides whether it is safe to run on GLV's server against
 * the client's site. A plan is a program: it can run Groovy or JavaScript on the server, read
 * and upload the server's files, write files anywhere, or send load to any site. So only known,
 * harmless parts are allowed, every request must go to an address the client allowed, and
 * requests that change data need the client's permission for that too.
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** A small, strict XML reader: elements, attributes, text and CDATA. No DTDs and no entities of its own. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      top().text += decode(xml.slice(i));
      break;
    }
    if (lt > i) top().text += decode(xml.slice(i, lt));
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt);
      if (end < 0) throw new Error("The plan's XML is cut off.");
      i = end + 2;
    } else if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt);
      if (end < 0) throw new Error("The plan's XML is cut off.");
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      if (end < 0) throw new Error("The plan's XML is cut off.");
      top().text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith("<!", lt)) {
      throw new Error("The plan holds a DOCTYPE, which a JMeter plan never needs.");
    } else if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt);
      if (end < 0) throw new Error("The plan's XML is cut off.");
      const name = xml.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.tag !== name || !stack.length) throw new Error(`The plan's XML is broken near </${name}>.`);
      i = end + 1;
    } else {
      // A start tag: find its end outside quoted attribute values.
      let j = lt + 1;
      let quote = "";
      for (; j < xml.length; j++) {
        const c = xml[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (j >= xml.length) throw new Error("The plan's XML is cut off.");
      let body = xml.slice(lt + 1, j);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([\w.:-]+)/.exec(body);
      if (!m) throw new Error("The plan's XML is broken.");
      const node: XmlNode = { tag: m[1], attrs: {}, children: [], text: "" };
      for (const a of body.slice(m[1].length).matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) node.attrs[a[1]] = decode(a[3] ?? a[4] ?? "");
      top().children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
    if (stack.length > 200) throw new Error("The plan's XML is nested too deeply.");
  }
  if (stack.length !== 1) throw new Error("The plan's XML is cut off.");
  return root;
}

/** Every element of the plan, depth first. */
function* walk(n: XmlNode): Generator<XmlNode> {
  for (const c of n.children) {
    yield c;
    yield* walk(c);
  }
}

/** A test element's own property (not those of elements inside it). */
function prop(el: XmlNode, name: string): string | undefined {
  for (const c of el.children) {
    if (c.attrs.name === name && /^(string|bool|int|long|double|float)Prop$/.test(c.tag)) return c.text.trim();
  }
  return undefined;
}

/** The parts of JMeter a plan may use. Anything else (scripts, files, other protocols, plugins) is refused. */
const ALLOWED = new Set([
  "TestPlan",
  "ThreadGroup",
  "SetupThreadGroup",
  "PostThreadGroup",
  "HTTPSamplerProxy",
  "ConfigTestElement",
  "HeaderManager",
  "CookieManager",
  "CacheManager",
  "AuthManager",
  "DNSCacheManager",
  "Arguments",
  "CounterConfig",
  "RandomVariableConfig",
  "LoopController",
  "GenericController",
  "TransactionController",
  "OnceOnlyController",
  "RandomController",
  "RandomOrderController",
  "InterleaveControl",
  "ThroughputController",
  "RunTime",
  "IfController",
  "WhileController",
  "ForeachController",
  "SwitchController",
  "ModuleController",
  "ConstantTimer",
  "UniformRandomTimer",
  "GaussianRandomTimer",
  "PoissonRandomTimer",
  "ConstantThroughputTimer",
  "PreciseThroughputTimer",
  "SyncTimer",
  "ResponseAssertion",
  "DurationAssertion",
  "SizeAssertion",
  "JSONPathAssertion",
  "MD5HexAssertion",
  "RegexExtractor",
  "JSONPostProcessor",
  "BoundaryExtractor",
  "HtmlExtractor",
  "JMESPathExtractor",
  "DebugPostProcessor",
  "ResultAction",
  "UserParameters",
  "RegExUserParameters",
  "URLRewritingModifier",
  "ResultCollector",
  "Summariser",
]);

/** Why some common parts are refused, in plain words. */
const REFUSED_WHY: Record<string, string> = {
  JSR223Sampler: "runs Groovy or JavaScript on GLV's server",
  JSR223PreProcessor: "runs Groovy or JavaScript on GLV's server",
  JSR223PostProcessor: "runs Groovy or JavaScript on GLV's server",
  JSR223Assertion: "runs Groovy or JavaScript on GLV's server",
  JSR223Timer: "runs Groovy or JavaScript on GLV's server",
  JSR223Listener: "runs Groovy or JavaScript on GLV's server",
  BeanShellSampler: "runs BeanShell code on GLV's server",
  BeanShellPreProcessor: "runs BeanShell code on GLV's server",
  BeanShellPostProcessor: "runs BeanShell code on GLV's server",
  BeanShellAssertion: "runs BeanShell code on GLV's server",
  BeanShellTimer: "runs BeanShell code on GLV's server",
  BeanShellListener: "runs BeanShell code on GLV's server",
  SystemSampler: "runs programs on GLV's server",
  CSVDataSet: "reads files on GLV's server (put test data in User Defined Variables instead)",
  KeystoreConfig: "reads files on GLV's server",
  IncludeController: "loads another plan from GLV's server",
  BackendListener: "sends the results to another service",
  JDBCSampler: "connects to a database",
  JDBCDataSource: "connects to a database",
  TCPSampler: "opens raw network connections",
  SmtpSampler: "sends email",
  MailReaderSampler: "reads a mailbox",
  JMSSampler: "uses a message queue",
  LDAPSampler: "uses a directory server",
  FTPSampler: "uses FTP",
  JavaSampler: "runs Java code",
  JUnitSampler: "runs Java code",
  AnchorModifier: "follows links to any site",
  HTMLAssertion: "writes files on GLV's server",
  XPathAssertion: "reads XML with external entities",
  XPath2Assertion: "reads XML with external entities",
  XPathExtractor: "reads XML with external entities",
  XPath2Extractor: "reads XML with external entities",
  AccessLogSampler: "reads files on GLV's server",
  BSFSampler: "runs scripts on GLV's server",
  BSFPreProcessor: "runs scripts on GLV's server",
  BSFPostProcessor: "runs scripts on GLV's server",
  BSFAssertion: "runs scripts on GLV's server",
  BSFTimer: "runs scripts on GLV's server",
  BSFListener: "runs scripts on GLV's server",
};

/** JMeter functions a plan may use: none of these runs code, reads files or changes JMeter's settings. */
const SAFE_FUNCTIONS = new Set([
  "__P",
  "__property",
  "__Random",
  "__RandomString",
  "__RandomDate",
  "__time",
  "__timeShift",
  "__dateTimeConvert",
  "__UUID",
  "__counter",
  "__threadNum",
  "__threadGroupName",
  "__intSum",
  "__longSum",
  "__urlencode",
  "__urldecode",
  "__escapeHtml",
  "__unescapeHtml",
  "__escapeXml",
  "__escapeOroRegexpChars",
  "__char",
  "__unescape",
  "__V",
  "__split",
  "__isVarDefined",
  "__isPropDefined",
  "__changeCase",
  "__digest",
  "__samplerName",
  "__TestPlanName",
  "__log",
  "__logn",
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The kinds of values a part may hold (arguments, headers, cookies, the thread group's loop). */
const ELEMENT_TYPES = new Set(["Arguments", "Argument", "HTTPArgument", "HTTPFileArgs", "HTTPFileArg", "Header", "Cookie", "Authorization", "LoopController", "StaticHost"]);

export interface PlanCheck {
  /** Why the plan cannot run, one line each. Empty when it is safe. */
  problems: string[];
  /** Users at once: the sum of the thread groups (or the largest, when they run one after another). */
  users: number;
  /** Planned length in seconds, when every thread group has a fixed duration. */
  seconds?: number;
  /** Requests in the plan, as "GET example.com/path". */
  requests: string[];
}

export interface PlanLimits {
  hosts: string[];
  maxUsers: number;
  maxMinutes: number;
  writes: boolean;
}

/** Checks a plan against the client's permission: what it uses, where it sends requests, how hard and how long. */
export function checkPlan(xml: string, limits: PlanLimits): PlanCheck {
  const problems: string[] = [];
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (err) {
    return { problems: [(err as Error).message], users: 0, requests: [] };
  }
  const plan = root.children.find((c) => c.tag === "jmeterTestPlan");
  if (!plan) return { problems: ["This is not a JMeter test plan (.jmx)."], users: 0, requests: [] };
  const seen = new Set<string>();
  const refuse = (line: string) => {
    if (!seen.has(line)) {
      seen.add(line);
      problems.push(line);
    }
  };
  // JMeter makes each part from its tag name (or a full Java class name), so the tag is what is checked.
  const elements: XmlNode[] = [];
  const visit = (tree: XmlNode) => {
    for (const c of tree.children) {
      if (c.tag === "hashTree") visit(c);
      else {
        elements.push(c);
        if (c.attrs.testclass && c.attrs.testclass !== c.tag) refuse(`"${c.attrs.testname ?? c.tag}" says it is ${c.attrs.testclass} but is ${c.tag}: save the plan again in JMeter.`);
      }
    }
  };
  for (const c of plan.children) if (c.tag === "hashTree") visit(c);
  if (!elements.some((e) => e.tag === "TestPlan")) problems.push("The plan has no Test Plan element.");
  // Values inside parts are made from their elementType or class too: only plain data is allowed.
  for (const n of walk(plan)) {
    if (n.attrs.elementType && !ELEMENT_TYPES.has(n.attrs.elementType)) refuse(`The plan holds a ${n.attrs.elementType} value, which GLV does not allow.`);
    if (n.attrs.class && n.attrs.class !== "SampleSaveConfiguration") refuse(`The plan holds a ${n.attrs.class} object, which GLV does not allow.`);
  }

  // Variables the plan sets once (User Defined Variables), and names that change while it runs.
  const vars = new Map<string, string>();
  const changing = new Set<string>();
  for (const el of [...walk(plan)]) {
    if (el.attrs.elementType === "Argument") {
      const name = prop(el, "Argument.name");
      const value = prop(el, "Argument.value");
      if (name) vars.set(name, value ?? "");
    }
    const name = el.attrs.name ?? "";
    if (/^(.*\.)?(refname|referenceNames?|variableName|returnVal)$/i.test(name) || name === "CounterConfig.name") {
      for (const v of el.text.split(";")) if (v.trim()) changing.add(v.trim());
    }
  }
  for (const el of elements.filter((e) => e.tag === "UserParameters")) {
    for (const n of [...walk(el)].filter((x) => x.attrs.name === "UserParameters.names")) for (const c of n.children) if (c.text.trim()) changing.add(c.text.trim());
  }
  const resolve = (s: string, depth = 0): string =>
    depth > 5
      ? s
      : s.replace(/\$\{__P\(\s*([\w.-]+)\s*(?:,([^)]*))?\)\}|\$\{([\w.-]+)\}/g, (m, p: string, def: string | undefined, v: string) => {
          if (p) return def !== undefined ? resolve(def.trim(), depth + 1) : m;
          if (changing.has(v)) return m;
          return vars.has(v) ? resolve(vars.get(v)!, depth + 1) : m;
        });

  for (const el of elements) {
    const cls = el.tag;
    const label = el.attrs.testname ? `"${el.attrs.testname}"` : cls;
    if (!ALLOWED.has(cls)) {
      refuse(`${label} (${cls}) ${REFUSED_WHY[cls] ?? "is not one of the parts GLV allows"}: remove it from the plan (switched-off parts count too).`);
      continue;
    }
    if (cls === "ConfigTestElement" && el.attrs.guiclass !== "HttpDefaultsGui") refuse(`${label} is not an HTTP Request Defaults element: remove it.`);
    if (cls === "ResultCollector" && (prop(el, "filename") ?? "") !== "") refuse(`${label} writes results to a file on GLV's server: clear its file name (the platform keeps the results).`);
    if (cls === "IfController" && prop(el, "IfController.useExpression") !== "true") {
      refuse(`${label} runs its condition as JavaScript: tick "Interpret Condition as Variable Expression".`);
    }
  }

  // Every function used anywhere in the plan, after XML escapes are undone (&#36; is also "$").
  for (const n of walk(plan)) {
    for (const value of [n.text, ...Object.values(n.attrs)]) {
      for (const m of value.matchAll(/\$\{\s*(__\w+)/g)) {
        if (!SAFE_FUNCTIONS.has(m[1])) refuse(`The plan uses the function ${m[1]}, which can run code or read files on GLV's server: replace it.`);
      }
    }
  }

  // Where the requests go.
  const defaults = elements.filter((e) => e.tag === "ConfigTestElement");
  const allowed = new Set(limits.hosts.map((h) => h.toLowerCase()));
  const requests: string[] = [];
  const defaultOf = (name: string) => defaults.map((d) => prop(d, name)).find((v) => v);
  for (const el of elements.filter((e) => e.tag === "HTTPSamplerProxy" || e.tag === "ConfigTestElement")) {
    const label = el.attrs.testname ? `"${el.attrs.testname}"` : "A request";
    const sampler = el.tag === "HTTPSamplerProxy";
    const rawPath = resolve(prop(el, "HTTPSampler.path") ?? "");
    let host = resolve(prop(el, "HTTPSampler.domain") ?? "") || (sampler ? resolve(defaultOf("HTTPSampler.domain") ?? "") : "");
    let port = resolve(prop(el, "HTTPSampler.port") ?? "") || (sampler ? resolve(defaultOf("HTTPSampler.port") ?? "") : "");
    let protocol = (resolve(prop(el, "HTTPSampler.protocol") ?? "") || (sampler ? resolve(defaultOf("HTTPSampler.protocol") ?? "") : "") || "http").toLowerCase();
    if (/^https?:\/\//i.test(rawPath)) {
      try {
        const u = new URL(rawPath);
        host = u.hostname;
        port = u.port;
        protocol = u.protocol.slice(0, -1);
      } catch {
        refuse(`${label} has an address JMeter cannot read: ${rawPath}`);
        continue;
      }
    } else if (rawPath.includes("://")) {
      refuse(`${label} uses a protocol other than http or https.`);
      continue;
    }
    if ((prop(el, "HTTPSampler.proxyHost") ?? "") !== "") refuse(`${label} goes through a proxy: remove the proxy settings.`);
    if (prop(el, "HTTPSampler.image_parser") === "true") refuse(`${label} downloads every image and script it finds, which can load other companies' sites: untick "Retrieve All Embedded Resources".`);
    // Files to upload are read from GLV's server.
    for (const f of [...walk(el)].filter((n) => n.attrs.name === "File.path")) {
      if (f.text.trim()) refuse(`${label} uploads a file from GLV's server: remove the file.`);
    }
    if (!sampler && !host) continue;
    if (!host) {
      refuse(`${label} has no server name, and there is no HTTP Request Defaults element with one.`);
      continue;
    }
    if (host.includes("${")) {
      refuse(`${label} sends to "${host}", which is only known while the plan runs: use a fixed server name, or a User Defined Variable.`);
      continue;
    }
    if (protocol !== "http" && protocol !== "https") refuse(`${label} uses ${protocol}, not http or https.`);
    const full = `${host.toLowerCase()}${port && !(protocol === "https" && port === "443") && !(protocol === "http" && port === "80") ? `:${port}` : ""}`;
    if (!allowed.has(full)) refuse(`${label} sends to ${full}, which the client's permission does not cover (it covers ${[...allowed].join(", ")}).`);
    if (sampler) {
      const method = (resolve(prop(el, "HTTPSampler.method") ?? "GET") || "GET").toUpperCase();
      if (!READ_METHODS.has(method) && !limits.writes) {
        refuse(`${label} sends ${method}, which can create or change the client's data; the client's permission allows only reading (GET). Ask the client to allow test data, or remove it.`);
      }
      requests.push(`${method} ${protocol}://${full}${/^https?:/i.test(rawPath) ? new URL(rawPath).pathname : rawPath || "/"}`);
    }
  }
  if (!requests.length) refuse("The plan has no HTTP requests.");

  // How hard and how long.
  const groups = elements.filter((e) => /^(Setup|Post)?ThreadGroup$/.test(e.tag));
  if (!groups.length) refuse("The plan has no thread group.");
  const testPlan = elements.find((e) => e.tag === "TestPlan");
  const oneByOne = testPlan ? prop(testPlan, "TestPlan.serialize_threadgroups") === "true" : false;
  const counts: number[] = [];
  let seconds: number | undefined = 0;
  for (const g of groups) {
    const label = g.attrs.testname ? `"${g.attrs.testname}"` : "A thread group";
    const threads = Number(resolve(prop(g, "ThreadGroup.num_threads") ?? "1"));
    if (!Number.isFinite(threads) || threads < 0) {
      refuse(`${label} has a number of users JMeter only knows while running: use a plain number.`);
      continue;
    }
    counts.push(threads);
    const scheduled = prop(g, "ThreadGroup.scheduler") === "true";
    const duration = Number(resolve(prop(g, "ThreadGroup.duration") ?? ""));
    const delay = Number(resolve(prop(g, "ThreadGroup.delay") ?? "0")) || 0;
    if (scheduled && Number.isFinite(duration) && duration > 0) {
      if (duration + delay > limits.maxMinutes * 60) refuse(`${label} runs for ${Math.ceil((duration + delay) / 60)} minutes; the client allows ${limits.maxMinutes}.`);
      seconds = seconds === undefined ? undefined : oneByOne ? seconds + duration + delay : Math.max(seconds, duration + delay);
    } else seconds = undefined;
  }
  const users = counts.length ? (oneByOne ? Math.max(...counts) : counts.reduce((a, b) => a + b, 0)) : 0;
  if (users > limits.maxUsers) refuse(`The plan runs ${users} users at once; the client allows ${limits.maxUsers}.`);
  return { problems, users, ...(seconds ? { seconds } : {}), requests };
}
