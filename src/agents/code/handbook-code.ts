import { parseAllDocuments } from "yaml";
import { countCases } from "../../runner/cases.js";
import { finding } from "../../runner/finding.js";
import type { Category, Finding, Severity } from "../../types.js";
import type { EngineAgent } from "../types.js";
import { TEST_PATH, type CodeContext, type SourceFile } from "./context.js";

/**
 * Source code checks for the testing types of the testing handbook that need no running app:
 * database schemas and migrations, containers and deployment files, the test suite itself
 * (focused and skipped tests, tests that check nothing, coverage, CI), maintainability, AI and LLM
 * code (prompt injection, model output run as code), and resilience (timeouts, webhooks, payments).
 */

type CodeAgent = EngineAgent<CodeContext>;
const base = { engine: "code" as const, products: ["code" as const] };
const list = (items: string[], max = 8) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");
const CODE = /\.(m?[jt]sx?|cjs|vue|svelte|php|py|java|kt|rb|go|cs|scala|swift|dart)$/i;
const GENERATED = /(^|\/)(dist|build|vendor|third_party|generated|\.next|out|coverage|public\/build)\/|\.min\.\w+$|\.bundle\.js$|\.d\.ts$|-lock\.|\.lock$|\.pb\.go$|_pb2\.py$/i;
const appCode = (files: SourceFile[]) => files.filter((f) => CODE.test(f.path) && !GENERATED.test(f.path) && !TEST_PATH.test(f.path));

/** Collects findings with one finding per rule, listing every place. */
class Hits {
  private by = new Map<string, { severity: Severity; category: Category; title: string; detail: string; where: string[] }>();
  add(rule: string, severity: Severity, category: Category, title: string, detail: string, where: string) {
    const h = this.by.get(rule) ?? { severity, category, title, detail, where: [] };
    if (!h.where.includes(where)) h.where.push(where);
    this.by.set(rule, h);
  }
  get size() {
    return [...this.by.values()].reduce((n, h) => n + h.where.length, 0);
  }
  findings(): Finding[] {
    return [...this.by].map(([rule, h]) =>
      finding({ category: h.category, rule, severity: h.severity, title: h.title, detail: h.detail, pageUrl: h.where[0].split(" ")[0].replace(/:\d+$/, ""), evidence: list(h.where), count: h.where.length }),
    );
  }
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

// ---------------------------------------------------------------------------------------------
// Database schemas and migrations

const MIGRATION = /(^|\/)(migrations?|db\/migrate|database\/migrations|schema|sql|flyway|liquibase|alembic\/versions)(\/|$)|\.sql$/i;

export const codeDatabaseAgent: CodeAgent = {
  ...base,
  id: "code.database",
  name: "Database schema and migrations",
  description:
    "Reads SQL files, migrations and Prisma schemas: tables without a primary key, *_id columns with no foreign key (orphan records), password columns too short for a hash, card CVV numbers stored at all, money in FLOAT columns (rounding errors), migrations that drop tables or columns, up migrations with no way back, and SELECT * in the app's queries.",
  category: "security",
  run({ files, note }) {
    const hits = new Hits();
    let tried = 0;
    const sql = files.filter((f) => /\.sql$/i.test(f.path) && f.size < 5_000_000);
    const prisma = files.filter((f) => /\.prisma$/i.test(f.path));
    let tables = 0;
    for (const f of sql) {
      for (const m of f.text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.]+)[`"\]]?\s*\(([\s\S]*?)\)\s*(?:engine|without|with|;|$)/gi)) {
        tables++;
        const name = m[1];
        const body = m[2];
        const at = `${f.path}:${lineOf(f.text, m.index ?? 0)} (${name})`;
        tried += 5;
        if (!/primary\s+key/i.test(body)) hits.add("db:no-primary-key", "medium", "functional", "Tables without a primary key", "Without a primary key, rows cannot be updated or deleted one at a time, duplicates creep in, and replication and many tools refuse the table. Add an id primary key.", at);
        const cols = body.split(/,(?![^(]*\))/).map((c) => c.trim());
        for (const c of cols) {
          const col = /^[`"[]?(\w+)[`"\]]?\s+(\w+)(?:\s*\(\s*(\d+))?/i.exec(c);
          if (!col) continue;
          const [, cname, ctype, len] = col;
          if (/^(primary|unique|key|index|constraint|foreign|check)$/i.test(cname)) continue;
          if (/(^|_)(password|passwd|pwd)$/i.test(cname) && /char|text/i.test(ctype) && len && Number(len) < 60) hits.add("db:password-column-short", "high", "security", "Password columns too short for a password hash", "A bcrypt hash is 60 characters and an Argon2 hash about 95, so a shorter column means passwords are stored in plain text or with a weak hash (MD5, SHA-1). Store password_hash() / bcrypt output in VARCHAR(255).", `${at}: ${cname} ${ctype}(${len})`);
          if (/(^|_)cvv2?$|(^|_)cvc$|card_?security_?code/i.test(cname)) hits.add("db:stores-cvv", "critical", "security", "The database has a column for card CVV numbers", "PCI DSS forbids storing the card security code after authorisation, even encrypted. Remove the column and let the payment gateway (Razorpay, Stripe, PayU) handle cards.", `${at}: ${cname}`);
          else if (/(^|_)(card_?number|cc_?number|pan_?number|aadhaa?r(_no|_number)?)$/i.test(cname)) hits.add("db:sensitive-column", "medium", "security", "Card, PAN or Aadhaar numbers stored in plain columns", "These numbers need protection at rest (PCI DSS for cards; the Aadhaar Act and DPDP Act for Aadhaar): store only the last 4 digits or a token, or encrypt the column, and limit who can read it.", `${at}: ${cname}`);
          if (/(^|_)(price|amount|total|balance|cost|fee|salary|tax|discount|subtotal)$/i.test(cname) && /^(float|double|real)$/i.test(ctype)) hits.add("db:float-money", "medium", "functional", "Money is stored as a floating-point number", "FLOAT and DOUBLE cannot hold 0.10 exactly, so totals, taxes and refunds drift by a paisa or cent. Use DECIMAL(12,2) (or whole paise/cents in a BIGINT).", `${at}: ${cname} ${ctype}`);
          if (/_id$/i.test(cname) && !/primary/i.test(c) && !new RegExp(`foreign\\s+key\\s*\\([^)]*\\b${cname}\\b|\\b${cname}\\b[^,]*references`, "i").test(body)) hits.add("db:no-foreign-key", "low", "functional", "Related ids are not checked by the database", "Columns ending in _id point at another table but have no FOREIGN KEY, so deleting a customer leaves orders that point at nobody (orphan records). Add a foreign key with ON DELETE rules.", `${at}: ${cname}`);
        }
      }
      if (MIGRATION.test(f.path) && !/(^|[/._-])(down|rollback|revert|undo)([/._-]|$)/i.test(f.path)) {
        for (const m of f.text.matchAll(/\b(drop\s+table|drop\s+column|truncate\s+table|truncate)\b\s+[`"]?(\w+)/gi)) {
          if (/if\s+exists\s*$/i.test(f.text.slice(Math.max(0, (m.index ?? 0) - 20), m.index)) && /drop\s+table/i.test(m[1]) && /create\s+table/i.test(f.text)) continue;
          tried++;
          hits.add("db:destructive-migration", "medium", "functional", "Migrations delete tables or columns", "Running this migration deletes data for good. Back up first, copy the data to the new place in the same migration, and test the migration on a copy of the live database (migration testing).", `${f.path}:${lineOf(f.text, m.index ?? 0)} ${m[1].toUpperCase()} ${m[2]}`);
        }
      }
    }
    // Up migrations that have no down migration.
    const ups = files.filter((f) => /\.up\.sql$/i.test(f.path));
    for (const u of ups) {
      tried++;
      if (!files.some((f) => f.path === u.path.replace(/\.up\.sql$/i, ".down.sql"))) hits.add("db:no-down-migration", "low", "functional", "Migrations cannot be undone", "These up migrations have no matching down migration, so a bad release cannot be rolled back quickly. Write the down step (or a tested restore plan) with every migration.", u.path);
    }
    for (const f of prisma) {
      for (const m of f.text.matchAll(/^\s*(\w+)\s+Float\b/gm)) {
        tried++;
        if (/^(price|amount|total|balance|cost|fee|salary|tax|discount|subtotal)$/i.test(m[1])) hits.add("db:float-money", "medium", "functional", "Money is stored as a floating-point number", "FLOAT and DOUBLE cannot hold 0.10 exactly, so totals, taxes and refunds drift by a paisa or cent. Use DECIMAL(12,2) (Prisma: Decimal) or whole paise in an Int.", `${f.path}:${lineOf(f.text, m.index ?? 0)}: ${m[1]} Float`);
      }
      for (const m of f.text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
        tables++;
        tried++;
        if (!/@id\b|@@id\b/.test(m[2])) hits.add("db:no-primary-key", "medium", "functional", "Tables without a primary key", "Without a primary key, rows cannot be updated or deleted one at a time. Add an @id field.", `${f.path}:${lineOf(f.text, m.index ?? 0)} (${m[1]})`);
      }
    }
    // SELECT * in app queries.
    let star = 0;
    let firstStar = "";
    for (const f of appCode(files)) {
      for (const m of f.text.matchAll(/["'`]\s*select\s+\*\s+from\b/gi)) {
        star++;
        firstStar ||= `${f.path}:${lineOf(f.text, m.index ?? 0)}`;
      }
    }
    tried++;
    if (star >= 5) hits.add("db:select-star", "low", "performance", "Queries read every column (SELECT *)", `${star} queries ask for every column. They read more data than needed, break when a column is added, and can send password hashes or private fields to code that never needed them. Name the columns.`, `${firstStar} (${star} queries)`);
    if (tables) note(`${tables} database tables read from SQL and Prisma files.`);
    countCases(tried, hits.size);
    return hits.findings();
  },
};

// ---------------------------------------------------------------------------------------------
// Containers and deployment files

const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)/i;
const DB_PORTS = new Map([["3306", "MySQL"], ["5432", "PostgreSQL"], ["27017", "MongoDB"], ["6379", "Redis"], ["9200", "Elasticsearch"], ["1433", "SQL Server"], ["11211", "Memcached"], ["5984", "CouchDB"]]);

export const codeContainerAgent: CodeAgent = {
  ...base,
  id: "code.container",
  name: "Containers and deployment",
  description:
    "Reads Dockerfiles, docker-compose files and Kubernetes manifests: containers that run as root, images with no fixed version, passwords baked into the image, curl piped into a shell, databases published to the internet, the Docker socket mounted, no health checks, no restart policy, no resource limits and a single copy of each service (no failover).",
  category: "security",
  run({ files, allPaths }) {
    const hits = new Hits();
    let tried = 0;
    const dockerfiles = files.filter((f) => /(^|\/)(Dockerfile|Containerfile)([.-][\w.-]+)?$|\.dockerfile$/i.test(f.path));
    for (const f of dockerfiles) {
      const lines = f.text.split("\n");
      const at = (re: RegExp) => {
        const i = lines.findIndex((l) => re.test(l));
        return i >= 0 ? `${f.path}:${i + 1}` : f.path;
      };
      const froms = lines.filter((l) => /^\s*FROM\s/i.test(l));
      tried += 7;
      const users = lines.filter((l) => /^\s*USER\s/i.test(l));
      if (!users.length || /^\s*USER\s+(root|0)(:|\s|$)/i.test(users.at(-1)!)) hits.add("container:runs-as-root", "medium", "security", "Containers run as root", "With no USER line the app runs as root inside the container, so a hole in the app gives an attacker root (and an easier way out of the container). Add a user and switch to it: RUN adduser -D app && USER app.", f.path);
      for (const l of froms) {
        const image = l.trim().split(/\s+/)[1] ?? "";
        if (/^(scratch|\$)/.test(image) || froms.some((x) => new RegExp(`\\bAS\\s+${image}\\b`, "i").test(x))) continue;
        if (!image.includes("@sha256") && (!/:[\w.-]+$/.test(image.replace(/^[^/]+:\d+\//, "")) || /:latest$/.test(image))) hits.add("container:unpinned-image", "low", "functional", "Images have no fixed version", "FROM without a version tag (or :latest) builds on whatever was published last, so the same Dockerfile can break or change behaviour from one day to the next. Pin a version, e.g. node:22.11-alpine (or a digest).", `${f.path}: ${l.trim()}`);
      }
      for (const [i, l] of lines.entries()) {
        const m = /^\s*(ENV|ARG)\s+(\w+)[= ]\s*["']?([^\s"'$]{4,})/i.exec(l);
        if (m && SECRET_NAME.test(m[2]) && !/^(changeme|example|xxx+|your|<)/i.test(m[3])) hits.add("container:secret-in-image", "high", "security", "Passwords or keys are written into the image", "ENV and ARG values are saved in the image's layers, so anyone who can pull the image can read them (docker history). Pass secrets at run time (environment variables from the server, Docker secrets or a vault).", `${f.path}:${i + 1}: ${m[1]} ${m[2]}=…`);
        if (/^\s*RUN\b.*\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i.test(l)) hits.add("container:curl-pipe-shell", "medium", "security", "The build runs scripts straight from the internet", "curl … | sh runs whatever the server sends at build time, with no check that it is the script you expect. Download it, check its SHA-256, then run it, or install from a package manager.", `${f.path}:${i + 1}`);
        if (/^\s*ADD\s+https?:\/\//i.test(l)) hits.add("container:add-url", "low", "security", "Files are downloaded with ADD", "ADD from a URL skips any checksum. Use RUN curl with a SHA-256 check (or ADD --checksum=sha256:…).", `${f.path}:${i + 1}`);
      }
      if (!lines.some((l) => /^\s*HEALTHCHECK\s/i.test(l)) && !/(^|\/)Dockerfile\.(dev|test)/i.test(f.path)) hits.add("container:no-healthcheck", "low", "functional", "Containers have no health check", "Without HEALTHCHECK, Docker and orchestrators only see whether the process is alive, not whether the app answers, so a hung app is never restarted. Add HEALTHCHECK CMD curl -f http://localhost:PORT/health || exit 1.", f.path);
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
      if (lines.some((l) => /^\s*COPY\s+\.\s+\S+/i.test(l)) && !allPaths.includes(`${dir}.dockerignore`) && !allPaths.includes(".dockerignore")) hits.add("container:no-dockerignore", "medium", "security", "COPY . copies everything, with no .dockerignore", "Without a .dockerignore, COPY . . puts .env files, .git history and local secrets into the image. Add a .dockerignore listing .git, .env*, node_modules and build output.", at(/^\s*COPY\s+\.\s/i));
    }

    const yamls = files.filter((f) => /\.ya?ml$/i.test(f.path) && f.size < 1_000_000 && !GENERATED.test(f.path));
    for (const f of yamls) {
      let docs: unknown[] = [];
      try {
        docs = parseAllDocuments(f.text).map((d) => d.toJS());
      } catch {
        continue;
      }
      for (const doc of docs as Record<string, any>[]) {
        if (!doc || typeof doc !== "object") continue;
        // docker-compose
        if (/compose/i.test(f.path) && doc.services && typeof doc.services === "object") {
          for (const [name, svc] of Object.entries<any>(doc.services)) {
            if (!svc || typeof svc !== "object") continue;
            const at = `${f.path} (${name})`;
            tried += 6;
            if (svc.privileged === true) hits.add("compose:privileged", "high", "security", "Services run privileged", "privileged: true gives the container full access to the host: anyone who breaks into the app owns the server. Remove it and add only the capability needed (cap_add).", at);
            const vols: string[] = (svc.volumes ?? []).map((v: any) => (typeof v === "string" ? v : `${v?.source ?? ""}:${v?.target ?? ""}`));
            if (vols.some((v) => /docker\.sock/.test(v))) hits.add("compose:docker-socket", "high", "security", "The Docker socket is mounted into a container", "Access to /var/run/docker.sock is root access to the host. Mount it only into trusted admin tools, read-only, or use a socket proxy that allows a few calls.", at);
            if (svc.network_mode === "host") hits.add("compose:host-network", "medium", "security", "Services use the host's network", "network_mode: host puts every port the container opens straight on the server's network, skipping Docker's isolation and port mapping. Publish only the ports you need.", at);
            for (const p of (svc.ports ?? []).map(String)) {
              const parts = p.replace(/\/(tcp|udp)$/, "").split(":");
              const container = parts.at(-1)!;
              const bound = parts.length >= 3 ? parts[0] : "";
              if (DB_PORTS.has(container) && parts.length >= 2 && !/^(127\.0\.0\.1|localhost|\[?::1\]?)$/.test(bound)) hits.add("compose:database-published", "high", "security", "Databases are published to the network", `The ${DB_PORTS.get(container)} port is published on every network address of the server, so anyone who can reach the server can try passwords on the database. Remove the ports line (other services reach it by name), or bind it to 127.0.0.1.`, `${at}: ${p}`);
            }
            const env = Array.isArray(svc.environment) ? Object.fromEntries(svc.environment.map((e: string) => String(e).split(/=(.*)/s).slice(0, 2))) : (svc.environment ?? {});
            for (const [k, v] of Object.entries(env)) {
              if (SECRET_NAME.test(k) && typeof v === "string" && v.length >= 4 && !/^\$\{|^\$\w/.test(v)) hits.add("compose:password-in-file", "medium", "security", "Passwords are written into docker-compose files", "The file holds the password itself, so it ends up in Git and in every copy of the project. Use ${VARIABLE} and keep the value in a .env file that is not committed.", `${at}: ${k}`);
            }
            if (!svc.restart && !svc.deploy?.restart_policy && !/(^|[./-])(dev|test|override|local|ci)([./-])/i.test(f.path)) hits.add("compose:no-restart", "low", "functional", "Services are not restarted after a crash or reboot", "With no restart policy, a crashed service or a server reboot leaves it down until someone starts it by hand. Add restart: unless-stopped.", at);
          }
        }
        // Kubernetes
        const kind = typeof doc.kind === "string" ? doc.kind : "";
        if (/^(Deployment|StatefulSet|DaemonSet|Pod|Job|CronJob|ReplicaSet)$/.test(kind)) {
          const spec = kind === "Pod" ? doc.spec : kind === "CronJob" ? doc.spec?.jobTemplate?.spec?.template?.spec : doc.spec?.template?.spec;
          const name = doc.metadata?.name ?? kind;
          const at = `${f.path} (${kind} ${name})`;
          for (const c of (spec?.containers ?? []) as any[]) {
            tried += 5;
            const sc = { ...(spec?.securityContext ?? {}), ...(c.securityContext ?? {}) };
            if (sc.privileged === true) hits.add("k8s:privileged", "high", "security", "Kubernetes containers run privileged", "A privileged container has full access to its node. Remove privileged: true.", at);
            if (sc.runAsNonRoot !== true && !(Number(sc.runAsUser) > 0)) hits.add("k8s:root", "low", "security", "Kubernetes containers may run as root", "Set securityContext.runAsNonRoot: true (and allowPrivilegeEscalation: false, readOnlyRootFilesystem: true) so a hole in the app does not give root.", `${at}: ${c.name}`);
            if (!c.resources?.limits) hits.add("k8s:no-limits", "low", "performance", "Containers have no CPU or memory limits", "Without limits one container can use the whole node and slow down or crash everything else on it. Set resources.requests and resources.limits from the load test's numbers.", `${at}: ${c.name}`);
            if (/^(Deployment|StatefulSet|DaemonSet)$/.test(kind) && !c.readinessProbe && !c.livenessProbe) hits.add("k8s:no-probes", "low", "functional", "Containers have no readiness or liveness checks", "Kubernetes cannot tell a hung or still-starting app from a working one, so it sends traffic to it and never restarts it. Add readinessProbe and livenessProbe on a /health address.", `${at}: ${c.name}`);
            if (typeof c.image === "string" && (!/:[\w.-]+$/.test(c.image.replace(/^[^/]+:\d+\//, "")) || /:latest$/.test(c.image)) && !c.image.includes("@sha256")) hits.add("container:unpinned-image", "low", "functional", "Images have no fixed version", "An image without a version tag (or :latest) can change under you between deployments. Pin a version or digest.", `${at}: ${c.image}`);
          }
          if (kind === "Deployment" || kind === "StatefulSet") {
            tried++;
            if ((doc.spec?.replicas ?? 1) < 2) hits.add("k8s:single-replica", "low", "functional", "Services run as a single copy", "With one replica, every deployment, node restart or crash takes the service down (no failover). Run at least 2 replicas with a PodDisruptionBudget.", at);
          }
        }
      }
    }
    countCases(tried, hits.size);
    return hits.findings();
  },
};

// ---------------------------------------------------------------------------------------------
// The test suite itself

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress)\/.*\.(m?[jt]sx?|py|php|rb|java|kt|go|cs)$|\.(test|spec)\.(m?[jt]sx?)$|_test\.(go|py)$|(^|\/)test_\w+\.py$|Test\.(java|kt|php)$|Tests?\.cs$/i;

/** Line, branch and function coverage read from the coverage report the project's tests wrote. */
export function readCoverage(files: SourceFile[]): { from: string; lines?: number; branches?: number } | null {
  const summary = files.find((f) => /coverage-summary\.json$/.test(f.path));
  if (summary) {
    try {
      const t = JSON.parse(summary.text).total;
      return { from: summary.path, lines: t?.lines?.pct, branches: t?.branches?.pct };
    } catch {
      /* try the others */
    }
  }
  const lcov = files.find((f) => /(^|\/)lcov\.info$/.test(f.path));
  if (lcov) {
    const sum = (k: string) => [...lcov.text.matchAll(new RegExp(`^${k}:(\\d+)`, "gm"))].reduce((n, m) => n + Number(m[1]), 0);
    const lf = sum("LF");
    const brf = sum("BRF");
    return { from: lcov.path, lines: lf ? (100 * sum("LH")) / lf : undefined, branches: brf ? (100 * sum("BRH")) / brf : undefined };
  }
  const xml = files.find((f) => /(^|\/)(coverage|cobertura[\w-]*)\.xml$/.test(f.path) && /<coverage\b/.test(f.text));
  if (xml) {
    const head = /<coverage\b[^>]*>/.exec(xml.text)?.[0] ?? "";
    const rate = (k: string) => {
      const v = new RegExp(`${k}="([\\d.]+)"`).exec(head)?.[1];
      return v === undefined ? undefined : Number(v) * 100;
    };
    return { from: xml.path, lines: rate("line-rate"), branches: rate("branch-rate") };
  }
  const clover = files.find((f) => /clover\.xml$/.test(f.path));
  if (clover) {
    const m = /<metrics\b[^>]*statements="(\d+)"[^>]*coveredstatements="(\d+)"/.exec(clover.text);
    const c = /<metrics\b[^>]*conditionals="(\d+)"[^>]*coveredconditionals="(\d+)"/.exec(clover.text);
    return { from: clover.path, lines: m && Number(m[1]) ? (100 * Number(m[2])) / Number(m[1]) : undefined, branches: c && Number(c[1]) ? (100 * Number(c[2])) / Number(c[1]) : undefined };
  }
  return null;
}

export const codeTestsAgent: CodeAgent = {
  ...base,
  id: "code.tests",
  name: "Test suite quality",
  description:
    "Checks the project's own tests: a test left focused with .only (CI then runs only that one), tests switched off (.skip, xit, @Disabled, pytest skip), test files that never assert anything, line and branch coverage from the coverage report (lcov, Istanbul, Cobertura, Clover), and whether CI runs the tests on every change (GitHub Actions, GitLab CI, Jenkins, Bitbucket, Azure).",
  category: "functional",
  run({ files, allPaths, note }) {
    const hits = new Hits();
    let tried = 0;
    const tests = files.filter((f) => TEST_FILE.test(f.path) && !GENERATED.test(f.path) && !/(^|\/)(fixtures?|mocks?|__mocks__|helpers?)\//i.test(f.path));
    let skipped = 0;
    let firstSkip = "";
    for (const f of tests) {
      tried += 3;
      const focus = /\b(?:it|test|describe|context)\.only\s*\(|\b(?:fit|fdescribe)\s*\(/.exec(f.text);
      if (focus) hits.add("tests:focused", "high", "functional", "A test is left focused with .only", "With .only (or fit/fdescribe) the test runner runs only this test and silently skips every other test in the file or suite, so CI stays green while nothing else is checked. Remove .only before committing (ESLint's no-only-tests rule catches it).", `${f.path}:${lineOf(f.text, focus.index)}`);
      const skips = f.text.match(/\b(?:it|test|describe)\.skip\s*\(|\bx(?:it|describe|test)\s*\(|@(?:Ignore|Disabled)\b|@pytest\.mark\.skip\b|\bt\.Skip\(|markTestSkipped\(|\[Ignore\]|\[Fact\(Skip\s*=/g);
      if (skips) {
        skipped += skips.length;
        firstSkip ||= f.path;
      }
      const hasTests = /\b(it|test)\s*\(|\bdef test_|@Test\b|func Test\w+\(|\[(Fact|Test|TestMethod)\]|public function test\w+/.test(f.text);
      const asserts = /\b(expect|assert\w*|should|t\.(Error|Fatal|Fail)\w*|require\.\w+|verify|toBe|toEqual|Assert\.\w+|assertThat|self\.assert\w+|pytest\.raises|check\.\w+|snapshot)\b/i.test(f.text);
      if (hasTests && !asserts) hits.add("tests:no-assertions", "medium", "functional", "Test files that never check anything", "These test files run code but contain no assertion (expect, assert, should), so they pass whatever the code does. Add the expected results.", f.path);
    }
    tried++;
    if (skipped >= 5) hits.add("tests:skipped", "low", "functional", `${skipped} tests are switched off`, "Skipped tests are usually tests that started failing. Each one is a part of the app that is no longer checked: fix or delete them, and track the rest in an issue.", `${firstSkip} (and others)`);

    const cov = readCoverage(files);
    if (cov) {
      tried += 2;
      if (cov.lines !== undefined) note(`Test coverage from ${cov.from}: ${cov.lines.toFixed(1)}% of lines${cov.branches !== undefined ? `, ${cov.branches.toFixed(1)}% of branches` : ""}.`);
      if (cov.lines !== undefined && cov.lines < 60) hits.add("tests:low-coverage", cov.lines < 30 ? "medium" : "low", "functional", `Tests run only ${Math.round(cov.lines)}% of the code`, "The coverage report shows most lines never run in a test (statement coverage), so bugs there are found by users. Aim for 70-80% on business logic first: payments, sign-up, orders, permissions.", cov.from);
      if (cov.branches !== undefined && cov.branches < 50) hits.add("tests:low-branch-coverage", "low", "functional", `Tests check only ${Math.round(cov.branches)}% of the if/else branches`, "Branch coverage counts each way through an if, switch or ?: (decision coverage). Low branch coverage means error paths and edge cases are untested. Add tests for the else branches: invalid input, empty lists, failures.", cov.from);
    } else if (tests.length) {
      note("No coverage report in the code (coverage/lcov.info, coverage-summary.json, coverage.xml): statement and branch coverage could not be read.");
    }

    const ci = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)Jenkinsfile$|(^|\/)bitbucket-pipelines\.ya?ml$|(^|\/)azure-pipelines\.ya?ml$|^\.circleci\/config\.ya?ml$|(^|\/)\.drone\.ya?ml$|(^|\/)\.travis\.ya?ml$/.test(f.path));
    const codeFiles = appCode(files).length;
    tried++;
    if (!ci.length && codeFiles >= 10) hits.add("tests:no-ci", "low", "functional", "Tests never run automatically", "There is no CI pipeline (GitHub Actions, GitLab CI, Jenkins...), so tests run only when someone remembers. Add a pipeline that runs the tests on every push and pull request (continuous testing).", "project");
    else if (ci.length && tests.length && !ci.some((f) => /\b(npm (run )?test|yarn test|pnpm test|npx (jest|vitest|playwright|cypress)|pytest|phpunit|pest|go test|mvn (-\S+ )*(test|verify)|gradlew? (test|check)|dotnet test|rspec|rake test|bundle exec|cargo test|tox|nox|make test|composer test)\b/.test(f.text))) {
      hits.add("tests:ci-skips-tests", "low", "functional", "The CI pipeline does not run the tests", "The pipeline builds or deploys but never runs the test suite, so a change that breaks the tests can still be released. Add the test command as a step before deploy.", ci[0].path);
    }
    if (allPaths.some((p) => /(^|\/)(stryker\.conf|infection\.json|\.mutmut|setup\.cfg)/.test(p))) note("A mutation testing setup was found (Stryker, Infection or mutmut).");
    note(`${tests.length} test files${ci.length ? `, CI: ${ci.map((f) => f.path).slice(0, 3).join(", ")}` : ", no CI pipeline"}.`);
    countCases(tried, hits.size);
    return hits.findings();
  },
};

// ---------------------------------------------------------------------------------------------
// Maintainability

/** Functions in brace languages: name, first line and length in lines, with their decision points. */
export function functionsOf(text: string, lang: "brace" | "py"): { name: string; line: number; length: number; decisions: number; depth: number }[] {
  const lines = text.split("\n");
  const out: { name: string; line: number; length: number; decisions: number; depth: number }[] = [];
  const DECIDE = /\b(if|elif|for|foreach|while|case|catch|except)\b|&&|\|\||\?\?|\s\?\s/g;
  if (lang === "py") {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(lines[i]);
      if (!m) continue;
      const indent = m[1].length;
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > indent)) j++;
      const body = lines.slice(i, j);
      out.push({ name: m[2], line: i + 1, length: j - i, decisions: body.join("\n").match(DECIDE)?.length ?? 0, depth: Math.max(0, ...body.map((l) => Math.floor((l.search(/\S/) - indent) / 4))) });
    }
    return out;
  }
  const SIG = /^\s*(?:export\s+)?(?:default\s+)?(?:public|private|protected|static|async|final|override|internal|\s)*(?:function\s*\*?\s*(\w+)|(\w+)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::\s*[\w<>[\]|, ]+)?\s*=>)|func\s+(?:\([^)]*\)\s*)?(\w+)|(?:[\w<>[\],]+\s+)+(\w+)\s*\([^;]*\)\s*(?:throws [\w, ]+)?\s*\{)/;
  for (let i = 0; i < lines.length; i++) {
    const m = SIG.exec(lines[i]);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!name || /^(if|for|while|switch|catch|return|else|new)$/.test(name)) continue;
    let depth = 0;
    let maxDepth = 0;
    let started = false;
    let j = i;
    for (; j < lines.length && j < i + 3000; j++) {
      const l = lines[j].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, "");
      for (const ch of l) {
        if (ch === "{") {
          depth++;
          started = true;
          maxDepth = Math.max(maxDepth, depth);
        } else if (ch === "}") depth--;
      }
      if (started && depth <= 0) break;
      if (!started && j > i + 2) break;
    }
    if (!started) continue;
    const body = lines.slice(i, j + 1).join("\n");
    out.push({ name, line: i + 1, length: j - i + 1, decisions: body.match(DECIDE)?.length ?? 0, depth: maxDepth - 1 });
    i = j; // nested functions count in their parent
  }
  return out;
}

export const codeMaintainabilityAgent: CodeAgent = {
  ...base,
  id: "code.maintainability",
  name: "Maintainability",
  description:
    "Measures how hard the code is to change safely: files over 1,500 lines, functions over 150 lines, functions with more than 25 decisions (cyclomatic complexity), code nested more than 6 levels deep, and the same 12 lines copied into several places (copy-paste duplication).",
  category: "functional",
  run({ files, note }) {
    const hits = new Hits();
    let tried = 0;
    const code = appCode(files).filter((f) => f.size < 1_500_000).slice(0, 1500);
    const big: { path: string; lines: number }[] = [];
    const longFns: string[] = [];
    const complex: string[] = [];
    const deep: string[] = [];
    let fns = 0;
    for (const f of code) {
      const n = f.text.split("\n").length;
      tried++;
      if (n > 1500) big.push({ path: f.path, lines: n });
      const lang = /\.py$/i.test(f.path) ? "py" : /\.(rb)$/i.test(f.path) ? null : "brace";
      if (!lang) continue;
      for (const fn of functionsOf(f.text, lang)) {
        fns++;
        tried += 3;
        if (fn.length > 150) longFns.push(`${f.path}:${fn.line} ${fn.name}() is ${fn.length} lines`);
        if (fn.decisions > 25) complex.push(`${f.path}:${fn.line} ${fn.name}() has ${fn.decisions} decision points`);
        if (fn.depth > 6) deep.push(`${f.path}:${fn.line} ${fn.name}() nests ${fn.depth} levels deep`);
      }
    }
    big.sort((a, b) => b.lines - a.lines);
    for (const b of big) hits.add("maint:huge-file", "low", "functional", "Files over 1,500 lines", "Very long files mix many jobs, cause merge conflicts and are hard to test. Split them by feature (one module for orders, one for invoices...).", `${b.path}: ${b.lines.toLocaleString("en-IN")} lines`);
    for (const l of longFns.sort()) hits.add("maint:long-function", "low", "functional", "Functions over 150 lines", "A function this long does several things, which makes it hard to read, test and change without breaking something. Split it into smaller functions with clear names.", l);
    for (const l of complex.sort()) hits.add("maint:complex-function", "medium", "functional", "Functions with too many decisions (high cyclomatic complexity)", "Each if, loop, case and && is another path through the function; past about 25 paths, no test suite covers them all and bugs hide in the rare ones. Split the function and replace long if/else chains with lookup tables or small handlers.", l);
    for (const l of deep.sort()) hits.add("maint:deep-nesting", "low", "functional", "Code nested more than 6 levels deep", "Deeply nested ifs and loops are hard to follow. Return early (guard clauses) and move inner blocks into their own functions.", l);

    // Copy-paste: the same 12 non-trivial lines in more than one place.
    const WINDOW = 12;
    const seen = new Map<string, string>();
    const dupes = new Map<string, Set<string>>();
    for (const f of code.slice(0, 600)) {
      const raw = f.text.split("\n");
      const lines = raw.map((l, i) => ({ t: l.trim(), i })).filter((x) => x.t.length > 12 && !/^(import|from|require|use |using |#include|package |\/\/|\*|\/\*|#|<\/?\w+>?$|[{}()[\];,]+$)/.test(x.t));
      for (let i = 0; i + WINDOW <= lines.length; i += 3) {
        const key = lines.slice(i, i + WINDOW).map((x) => x.t).join("\n");
        const here = `${f.path}:${lines[i].i + 1}`;
        const first = seen.get(key);
        if (!first) seen.set(key, here);
        else if (first.split(":")[0] !== f.path || Math.abs(Number(first.split(":")[1]) - lines[i].i - 1) > WINDOW) {
          const g = dupes.get(first) ?? new Set([first]);
          g.add(here);
          dupes.set(first, g);
        }
      }
    }
    const groups = [...dupes.values()].map((g) => [...g]);
    tried++;
    if (groups.length >= 2) hits.add("maint:duplicate-code", "low", "functional", "The same code is copied into several places", `${groups.length} blocks of ${WINDOW} or more lines appear more than once. A bug fixed in one copy stays in the others. Move the shared code into one function.`, groups.slice(0, 8).map((g) => g.slice(0, 3).join(" = ")).join("\n"));
    note(`${fns.toLocaleString("en-IN")} functions measured for length, complexity and nesting.`);
    countCases(tried, hits.size);
    return hits.findings();
  },
};

// ---------------------------------------------------------------------------------------------
// AI and LLM code

const LLM_SDK = /(from\s+["']?(openai|anthropic|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|groq-sdk|cohere-ai|ollama|langchain[\w/.-]*|@langchain\/[\w-]+|llamaindex|ai)["']?|import\s+(openai|anthropic|ollama|cohere)\b|require\(["'](openai|@anthropic-ai\/sdk|langchain[\w/-]*)["']\)|from\s+(openai|anthropic|langchain\w*|llama_index)\s+import|new\s+(OpenAI|Anthropic|ChatOpenAI|ChatAnthropic|GoogleGenerativeAI)\s*\(|genai\.configure|\bgenerateText\s*\(|\bstreamText\s*\()/;
const REQUEST_INPUT = /\breq\.(body|query|params)\b|\brequest\.(form|args|json|GET|POST|data|get_json)\b|\$_(GET|POST|REQUEST)\b|\bctx\.request\.body\b|\b(userInput|user_input|userMessage|user_message|userPrompt|user_prompt|message\.content)\b/;

export const codeAiAgent: CodeAgent = {
  ...base,
  id: "code.ai",
  name: "AI and LLM code",
  description:
    "For apps that call an AI model (OpenAI, Claude, Gemini, LangChain, Ollama...): user text written into the system prompt (prompt injection), model answers run as code, HTML or shell commands, AI keys exposed to the browser, model tools that run commands, calls with no output limit, and no evaluation tests (Promptfoo, DeepEval, Ragas or your own) to catch quality drops when the model or prompt changes.",
  category: "security",
  run({ files, allPaths, note }) {
    const hits = new Hits();
    let tried = 0;
    const llm = appCode(files).filter((f) => LLM_SDK.test(f.text));
    if (!llm.length) return [];
    note(`${llm.length} files call an AI model.`);
    for (const f of llm) {
      const lines = f.text.split("\n");
      tried += 5;
      for (const [i, l] of lines.entries()) {
        const near = lines.slice(i, i + 3).join(" ");
        if (/(role\s*:\s*["'`]system["'`]|\bsystem\s*[:=]\s*[`"'f]|system_?prompt|systemPrompt|SystemMessage\s*\(|instructions\s*[:=])/i.test(l) && REQUEST_INPUT.test(near) && !/role\s*:\s*["'`]user/.test(near)) {
          hits.add("ai:prompt-injection", "high", "security", "User text is written into the AI's system instructions", "Text from the request goes into the system prompt, where the model treats it as instructions: a user can write \"ignore the rules above and…\" and take over the assistant (prompt injection, OWASP LLM01). Keep the system prompt fixed, send user text only as a user message, and never let the model's answer decide permissions.", `${f.path}:${i + 1}`);
        }
        if (/\b(eval|exec|execSync|spawnSync|os\.system|subprocess\.\w+|child_process\.\w+|new Function)\s*\(|innerHTML\s*=|dangerouslySetInnerHTML|\.query\s*\(|cursor\.execute\s*\(/.test(l) && /(choices\[0\]|\.content\b|completion|\bllm\w*|ai_?(response|output|answer)|output_text|\.text\(\)|generated|modelOutput|response\.text\b)/i.test(l)) {
          hits.add("ai:output-run-as-code", "high", "security", "The AI's answer is run as code, HTML or a query", "The model's output goes into eval, a shell command, innerHTML or a database query. A manipulated prompt (or a document the model read) can then run commands, inject script into users' browsers or change data (OWASP LLM05). Treat model output as untrusted input: parse it into a fixed structure, escape it, and allow only listed actions.", `${f.path}:${i + 1}`);
        }
        if (/dangerouslyAllowBrowser\s*:\s*true/.test(l)) hits.add("ai:key-in-browser", "high", "security", "The AI key is used in the browser", "dangerouslyAllowBrowser: true sends the API key to every visitor, who can then run up your AI bill or read your prompts. Call the model from your server and give the browser only your own endpoint.", `${f.path}:${i + 1}`);
        if (/["'`](name|function)["'`]?\s*:\s*["'`](run_?shell|exec(ute)?_?(command|shell|code)|bash|terminal|run_?command|python_?repl|shell)["'`]/i.test(l) || /\b(ShellTool|PythonREPLTool|BashTool|TerminalTool)\b/.test(l)) {
          hits.add("ai:shell-tool", "medium", "security", "The AI agent has a tool that runs commands", "The model can call a tool that runs shell commands or code. Any prompt injection then runs on your server (OWASP LLM06 excessive agency). Run it in a sandbox with no secrets, allow only listed commands, and ask a person before anything that changes data.", `${f.path}:${i + 1}`);
        }
        if (/\bchat\.completions\.create\s*\(|\bresponses\.create\s*\(|\bgenerate_?content\s*\(|\bgenerateContent\s*\(/.test(l) && !/max_(completion_|output_)?tokens|maxOutputTokens|max_tokens|maxTokens/.test(lines.slice(i, i + 15).join(" "))) {
          hits.add("ai:no-output-limit", "low", "performance", "AI calls have no output limit", "Without max_tokens (max_output_tokens, maxOutputTokens) one request can produce a very long, slow and expensive answer, and a user can make every answer long on purpose. Set a limit that fits the feature.", `${f.path}:${i + 1}`);
        }
      }
    }
    tried++;
    const evals = allPaths.some((p) => /(^|\/)(promptfoo(config)?\.(ya?ml|json|js)|\.promptfoo|evals?\/|deepeval|ragas|giskard|\w*eval\w*\.(py|ts|js|ya?ml))/i.test(p) && !/node_modules/.test(p));
    if (!evals) hits.add("ai:no-evals", "low", "functional", "No tests for the AI's answers", "Nothing checks the quality of the AI feature, so a new model version or a prompt change can make answers worse (wrong, made up, unsafe) without anyone noticing. Keep a set of example questions with expected answers and run it in CI (Promptfoo or DeepEval are free and open source), including prompt-injection attempts.", llm[0].path);
    countCases(tried, hits.size);
    return hits.findings();
  },
};

// ---------------------------------------------------------------------------------------------
// Resilience, webhooks, payments, time zones

export const codeResilienceAgent: CodeAgent = {
  ...base,
  id: "code.resilience",
  name: "Resilience, webhooks and payments",
  description:
    "Finds code that fails badly when something else fails: outside calls with no timeout (one slow partner hangs the app), errors swallowed by empty catch blocks, webhook endpoints that never check the sender's signature, payments created without an idempotency key (a retry charges twice), money calculated with floating point, and dates saved without a time zone.",
  category: "functional",
  run({ files }) {
    const hits = new Hits();
    let tried = 0;
    let empty = 0;
    let firstEmpty = "";
    let naive = 0;
    let firstNaive = "";
    for (const f of appCode(files)) {
      const lines = f.text.split("\n");
      const py = /\.py$/i.test(f.path);
      tried += 4;
      for (const [i, l] of lines.entries()) {
        if (py && /\brequests\.(get|post|put|patch|delete|head|request)\s*\(/.test(l)) {
          const call = lines.slice(i, i + 6).join(" ");
          const end = call.indexOf(")", call.indexOf("requests."));
          if (!/timeout\s*=/.test(end > 0 ? call.slice(0, end + 1 + 200) : call)) hits.add("res:no-timeout", "medium", "functional", "Calls to other servers have no timeout", "Python's requests waits for ever by default: if a partner API hangs, every worker that calls it hangs too and the whole app stops answering. Pass timeout=(5, 30) on every call.", `${f.path}:${i + 1}`);
        }
        if (/\.go$/.test(f.path) && /\bhttp\.(Get|Post|Head)\s*\(|http\.DefaultClient\b/.test(l)) hits.add("res:no-timeout", "medium", "functional", "Calls to other servers have no timeout", "Go's default HTTP client has no timeout: a hanging partner API ties up goroutines for ever. Use &http.Client{Timeout: 30 * time.Second}.", `${f.path}:${i + 1}`);
        if (/catch\s*(\(\s*\w*\s*(:\s*\w+)?\s*\))?\s*\{\s*\}|except(\s+\w+(\s+as\s+\w+)?)?\s*:\s*pass\b|catch\s*\(\s*\\?Exception\s+\$\w+\s*\)\s*\{\s*\}/.test(l)) {
          empty++;
          firstEmpty ||= `${f.path}:${i + 1}`;
        }
        if (py && /\bdatetime\.(now|utcnow)\(\s*\)/.test(l)) {
          naive++;
          firstNaive ||= `${f.path}:${i + 1}`;
        }
        if (/(parseFloat|Number|float|floatval)\s*\([^)]*(price|amount|total|cost|fee)[^)]*\)\s*\*\s*100\b/i.test(l)) hits.add("res:float-money", "low", "functional", "Money is calculated with floating point", "parseFloat(price) * 100 gives 1999.9999999 for 19.99, so amounts sent to the payment gateway are off by a paisa or rejected. Round with Math.round, or keep amounts in whole paise and use a decimal library.", `${f.path}:${i + 1}`);
      }
      // Webhooks that never check who sent them.
      const route = /(app|router|server|api|r)\.(post|all)\s*\(\s*["'`][^"'`]*webhook|Route::(post|any)\s*\(\s*["'][^"']*webhook|@\w+\.(route|post)\s*\(\s*["'][^"']*webhook|path\s*\(\s*["'][^"']*webhook|HandleFunc\s*\(\s*"[^"]*webhook|\[(HttpPost|Route)\s*\(\s*"[^"]*webhook/i.exec(f.text);
      if (route) {
        tried++;
        if (!/constructEvent|signature|verify\w*|hmac|createHmac|hash_hmac|compare_digest|timingSafeEqual|hash_equals|x-hub-signature|x-razorpay-signature|stripe-signature|x-shopify-hmac|validateWebhook|webhookSecret|webhook_secret|svix/i.test(f.text)) hits.add("res:webhook-unsigned", "high", "security", "Webhook endpoints do not check who sent them", "Anyone who finds this address can post a fake \"payment succeeded\" or \"order paid\" event and the app will act on it. Verify the provider's signature header (Stripe-Signature, X-Razorpay-Signature, X-Hub-Signature-256...) with the webhook secret before doing anything, and ignore events you have already handled.", `${f.path}:${lineOf(f.text, route.index)}`);
      }
      // Payments without an idempotency key.
      const pay = /\b(paymentIntents|charges|refunds|payouts|transfers)\.create\s*\(|\bstripe\.(PaymentIntent|Charge|Refund)\.create\s*\(|\bStripe\\(PaymentIntent|Charge)::create\s*\(/.exec(f.text);
      if (pay) {
        tried++;
        if (!/idempotency[_-]?key|idempotencyKey|Idempotency-Key/i.test(f.text)) hits.add("res:payment-no-idempotency", "medium", "functional", "Payments are created without an idempotency key", "If the request times out and is sent again (by the app, a retry library or a double click), the customer is charged twice. Pass an idempotency key made from your order id (Stripe: idempotencyKey; Razorpay: use the order id and check payment status before charging again).", `${f.path}:${lineOf(f.text, pay.index)}`);
      }
    }
    tried++;
    if (empty >= 3) hits.add("res:empty-catch", "low", "functional", `${empty} errors are caught and ignored`, "Empty catch blocks (or except: pass) hide failures: the app carries on with missing data and nobody sees an error in the logs. Log the error, or let it reach the error handler.", `${firstEmpty} (and ${empty - 1} more)`);
    tried++;
    if (naive >= 3) hits.add("res:naive-datetime", "low", "functional", "Dates and times are saved without a time zone", `datetime.now() and utcnow() give a time with no zone (${naive} places), so times shift by 5½ hours between India and a UTC server, and across daylight saving abroad. Use datetime.now(timezone.utc) and convert to the user's zone only for display.`, `${firstNaive} (and ${naive - 1} more)`);
    countCases(tried, hits.size);
    return hits.findings();
  },
};

/** The code agents added for the testing handbook. */
export const HANDBOOK_CODE_AGENTS = [codeDatabaseAgent, codeContainerAgent, codeTestsAgent, codeMaintainabilityAgent, codeAiAgent, codeResilienceAgent];
