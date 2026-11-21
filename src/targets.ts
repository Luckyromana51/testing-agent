import { profileOf } from "./app/systems.js";
import { parseSecret } from "./app/totp.js";
import { parseSteps } from "./runner/journeys.js";
import { existsSync } from "node:fs";
import { uploadedPath } from "./engines/index.js";
import { validateRepoUrl } from "./engines/code.js";
import { validateTarget } from "./runner/urls.js";
import type { ApiAuthType, Login, LoginKind, LoginSummary, ProductType, ProjectTarget, RoleLogin, RoleSummary } from "./types.js";
import { WEB_PRODUCTS } from "./products.js";

export interface TargetInput {
  url?: string;
  specUrl?: string;
  repoUrl?: string;
  branch?: string;
  file?: string;
  fileName?: string;
  maxPages?: number;
  checkLinks?: boolean;
  /** A known system's id, or "" to let the test spot it. */
  system?: string;
  /** API: a GraphQL endpoint instead of a REST API file. */
  graphqlUrl?: string;
  /** API and signed-in apps: the project is a test server or test copy (tests may change data, and clean up). */
  testServer?: boolean;
  soapUrl?: string;
  grpcUrl?: string;
  protoFile?: string;
  protoFileName?: string;
  wsUrl?: string;
  wsMessages?: string;
  contractFile?: string;
  contractFileName?: string;
  /** Any project: the repository Claude's fixes are proposed to. */
  fixRepoUrl?: string;
  fixBranch?: string;
}

/** Extra uploaded files an API project takes, besides its API file. */
const EXTRA_UPLOADS: Record<"protoFile" | "contractFile", RegExp> = { protoFile: /\.proto$/i, contractFile: /\.json$/i };

/** "grpcs://host:443" from what was typed ("host:50051", "grpc://host:50051"...). */
export function grpcAddress(raw: string): string {
  const text = raw.trim();
  const withScheme = /^grpcs?:\/\//i.test(text) ? text : `grpcs://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme.replace(/^grpc(s?):/i, "http$1:"));
  } catch {
    throw new Error(`"${text}" is not a gRPC address. Write it as host:port, like api.example.com:443.`);
  }
  const tls = /^grpcs:/i.test(withScheme);
  // The same address rules as any other target (no private networks unless allowed).
  validateTarget(`${tls ? "https" : "http"}://${u.host}/`);
  return `${tls ? "grpcs" : "grpc"}://${u.hostname}:${u.port || (tls ? "443" : "80")}`;
}

/** "wss://host/path" from what was typed; ws:// is allowed (it is reported). */
export function wsAddress(raw: string): string {
  const text = raw.trim();
  if (!/^wss?:\/\//i.test(text)) throw new Error("A WebSocket address starts with wss:// (or ws://).");
  const http = text.replace(/^ws/i, "http");
  const checked = validateTarget(http);
  return checked.replace(/^http/i, "ws");
}

/** Which uploaded file types each product takes. */
export const UPLOAD_TYPES: Record<string, RegExp> = {
  api: /\.(json|ya?ml|har|txt|sh|curl)$/i,
  code: /\.zip$/i,
  android: /\.(apk|aab|apks|xapk)$/i,
  ios: /\.(ipa|zip)$/i,
};

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Builds a project's target from what the tester entered, checking each part.
 * `prev` is the current target when editing; fields left out keep their value.
 */
export function buildTarget(type: ProductType, input: TargetInput, uploadsDir: string, defaultMaxPages: number, prev: ProjectTarget = {}): ProjectTarget {
  const t: ProjectTarget = { ...prev };
  const set = <K extends keyof TargetInput>(k: K) => input[k] !== undefined;

  if (set("file")) {
    const file = clean(input.file);
    if (file) {
      const full = uploadedPath(uploadsDir, file);
      if (!existsSync(full)) throw new Error("The uploaded file was not found. Upload it again.");
      if (UPLOAD_TYPES[type] && !UPLOAD_TYPES[type].test(file)) throw new Error("That file type does not fit this product.");
      t.file = file;
      t.fileName = clean(input.fileName).slice(0, 200) || file;
    } else {
      delete t.file;
      delete t.fileName;
    }
  }

  if (WEB_PRODUCTS.includes(type)) {
    if (set("url") || !t.url) t.url = validateTarget(clean(input.url));
    if (set("maxPages") || t.maxPages === undefined) t.maxPages = Math.min(Math.max(Number(input.maxPages) || defaultMaxPages, 1), 200);
    if (set("checkLinks") || t.checkLinks === undefined) t.checkLinks = input.checkLinks !== false;
    if (set("testServer")) {
      if (input.testServer === true) t.testServer = true;
      else delete t.testServer;
    }
    fixRepo(t, input, set);
    if (set("system")) {
      const id = clean(input.system);
      if (!id) delete t.system;
      else if (!profileOf(id)) throw new Error("That system is not on the list. Choose another, or let the test spot it.");
      else t.system = id;
    }
    return t;
  }

  if (type === "api") {
    if (set("specUrl")) {
      const spec = clean(input.specUrl);
      if (spec) t.specUrl = validateTarget(spec);
      else delete t.specUrl;
    }
    if (set("url")) {
      const url = clean(input.url);
      if (url) t.url = validateTarget(url).replace(/\/$/, "");
      else delete t.url;
    }
    if (set("graphqlUrl")) {
      const g = clean(input.graphqlUrl);
      if (g) t.graphqlUrl = validateTarget(g);
      else delete t.graphqlUrl;
    }
    if (set("testServer")) {
      if (input.testServer === true) t.testServer = true;
      else delete t.testServer;
    }
    if (set("soapUrl")) {
      const v = clean(input.soapUrl);
      if (v) t.soapUrl = validateTarget(v);
      else delete t.soapUrl;
    }
    if (set("grpcUrl")) {
      const v = clean(input.grpcUrl);
      if (v) t.grpcUrl = grpcAddress(v);
      else delete t.grpcUrl;
    }
    if (set("wsUrl")) {
      const v = clean(input.wsUrl);
      if (v) t.wsUrl = wsAddress(v);
      else delete t.wsUrl;
    }
    if (set("wsMessages")) {
      const v = typeof input.wsMessages === "string" ? input.wsMessages.slice(0, 5000).trim() : "";
      if (v) t.wsMessages = v;
      else delete t.wsMessages;
    }
    for (const key of ["protoFile", "contractFile"] as const) {
      if (!set(key)) continue;
      const nameKey = key === "protoFile" ? "protoFileName" : "contractFileName";
      const file = clean(input[key]);
      if (!file) {
        delete t[key];
        delete t[nameKey];
        continue;
      }
      if (!existsSync(uploadedPath(uploadsDir, file))) throw new Error("The uploaded file was not found. Upload it again.");
      if (!EXTRA_UPLOADS[key].test(file)) throw new Error(key === "protoFile" ? "Upload a .proto file." : "Upload the Pact contract as a .json file.");
      t[key] = file;
      t[nameKey] = clean(input[nameKey]).slice(0, 200) || file;
    }
    fixRepo(t, input, set);
    if (!t.specUrl && !t.file && !t.graphqlUrl && !t.url && !t.soapUrl && !t.grpcUrl && !t.wsUrl && !t.contractFile) {
      throw new Error("Enter the address of the OpenAPI (Swagger) file, upload it (or a Postman collection, HAR file or cURL commands), give a GraphQL, SOAP (WSDL), gRPC or WebSocket address, upload a Pact contract, or give the API's base address so the test can look for the file.");
    }
    if (t.contractFile && !t.url) throw new Error("A Pact contract needs the API's base address too: the contract's requests are sent there.");
    return t;
  }

  if (type === "code") {
    if (set("repoUrl")) {
      const repo = clean(input.repoUrl);
      if (repo) t.repoUrl = validateRepoUrl(repo);
      else delete t.repoUrl;
    }
    if (set("branch")) {
      const branch = clean(input.branch);
      if (branch && (!/^[\w./-]{1,100}$/.test(branch) || branch.startsWith("-") || branch.includes(".."))) {
        throw new Error("That branch name has characters Git does not allow.");
      }
      if (branch) t.branch = branch;
      else delete t.branch;
    }
    fixRepo(t, input, set);
    if (!t.repoUrl && !t.file) throw new Error("Enter the repository address, or upload a zip of the code.");
    return t;
  }

  if (type === "android" || type === "ios") {
    if (!t.file) throw new Error(type === "android" ? "Upload the APK file to test." : "Upload the IPA file (or a zip of the .app) to test.");
    return t;
  }
  return t;
}

/** The repository Claude's fixes go to (a pull request), and the branch they start from. */
function fixRepo(t: ProjectTarget, input: TargetInput, set: (k: keyof TargetInput) => boolean): void {
  if (set("fixRepoUrl")) {
    const v = clean(input.fixRepoUrl);
    if (v) t.fixRepoUrl = validateRepoUrl(v);
    else delete t.fixRepoUrl;
  }
  if (set("fixBranch")) {
    const b = clean(input.fixBranch);
    if (b && (!/^[\w./-]{1,100}$/.test(b) || b.startsWith("-") || b.includes(".."))) throw new Error("That branch name has characters Git does not allow.");
    if (b) t.fixBranch = b;
    else delete t.fixBranch;
  }
}

/** A readable default name for a new project. */
export function defaultName(type: ProductType, t: ProjectTarget): string {
  try {
    if (t.repoUrl) return new URL(t.repoUrl).pathname.split("/").filter(Boolean).slice(-1)[0]?.replace(/\.git$/, "") || "Code";
    if (t.specUrl) return `${new URL(t.specUrl).hostname.replace(/^www\./, "")} API`;
    if (t.soapUrl) return `${new URL(t.soapUrl).hostname.replace(/^www\./, "")} SOAP`;
    if (t.grpcUrl) return `${new URL(t.grpcUrl.replace(/^grpcs?:/, "http:")).hostname} gRPC`;
    if (t.wsUrl) return `${new URL(t.wsUrl.replace(/^ws/, "http")).hostname} WebSocket`;
    if (t.url) return new URL(t.url).hostname.replace(/^www\./, "");
  } catch {
    /* fall through */
  }
  if (t.fileName) return t.fileName.replace(/\.(apk|aab|apks|xapk|ipa|zip|json|ya?ml)$/i, "");
  return type;
}

/** Which kind of login a product uses: a sign-in form, an API key or token, or a Git access token. */
export function loginKindFor(type: ProductType): LoginKind | undefined {
  if (WEB_PRODUCTS.includes(type)) return "web";
  if (type === "api") return "api";
  if (type === "code") return "git";
  // Mobile apps: the account the test phone signs in with on the app's own sign-in screen.
  if (type === "android" || type === "ios") return "app";
  return undefined;
}

const API_AUTH_TYPES: ApiAuthType[] = ["bearer", "header", "basic", "query", "oauth2", "login"];
// Control characters would let a value add its own headers or lines.
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(input: Partial<Login>, key: keyof Login, label: string, max: number): string | undefined {
  const raw = input[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(`${label} must be text.`);
  const v = key === "password" || key === "token" ? raw : raw.trim();
  if (v.length > max) throw new Error(`${label} is too long (at most ${max} characters).`);
  if (CONTROL.test(v)) throw new Error(`${label} has characters that are not allowed.`);
  return v || undefined;
}

/**
 * Checks a login entered for a project. `prev` is the saved one when editing: fields left out keep
 * their value, and secrets left empty keep the saved secret.
 */
export function buildLogin(type: ProductType, input: Partial<Login>, prev?: LoginSummary): Login {
  const kind = loginKindFor(type);
  if (!kind) throw new Error("This product type does not use a login.");
  const keep = prev && prev.kind === kind && !prev.unreadable ? prev : undefined;
  const pick = (key: keyof Login, label: string, max: number) => {
    const v = text(input, key, label, max);
    return input[key] !== undefined ? v : (keep?.[key as keyof LoginSummary] as string | undefined);
  };
  const login: Login = { kind };
  const password = text(input, "password", "The password", 500);
  const token = text(input, "token", "The token", 5000);

  if (kind === "app") {
    login.username = pick("username", "The user name", 200);
    if (!login.username) throw new Error("Enter the user name, email or phone number to sign in to the app with.");
    if (!password && !keep?.hasPassword) throw new Error("Enter the password to sign in with.");
    login.password = password;
    return login;
  }
  if (kind === "web") {
    const loginUrl = pick("loginUrl", "The sign-in page address", 2000);
    if (!loginUrl) throw new Error("Enter the address of the sign-in page.");
    login.loginUrl = validateTarget(loginUrl);
    login.username = pick("username", "The user name", 200);
    if (!login.username) throw new Error("Enter the user name or email to sign in with.");
    if (!password && !keep?.hasPassword) throw new Error("Enter the password to sign in with.");
    login.password = password;
    login.usernameSelector = pick("usernameSelector", "The user name field", 300);
    login.passwordSelector = pick("passwordSelector", "The password field", 300);
    login.submitSelector = pick("submitSelector", "The sign-in button", 300);
    login.successText = pick("successText", "The signed-in text", 200);
    login.roleName = pick("roleName", "The account's role", 40);
    const totpSecret = text(input, "totpSecret", "The two-step secret", 500);
    if (totpSecret) {
      try {
        parseSecret(totpSecret);
      } catch (err) {
        throw new Error((err as Error).message);
      }
      login.totpSecret = totpSecret;
    }
    const codeFrom = pick("codeFrom", "Where the code comes from", 10);
    if (codeFrom && codeFrom !== "totp" && codeFrom !== "email") throw new Error("The code comes from the two-step secret (totp) or an email.");
    if (codeFrom) login.codeFrom = codeFrom as "totp" | "email";
    const steps = input.steps !== undefined ? (typeof input.steps === "string" ? input.steps.slice(0, 3000).trim() || undefined : undefined) : keep?.steps;
    if (steps) {
      try {
        parseSteps(steps);
      } catch (err) {
        throw new Error(`The sign-in steps: ${(err as Error).message}`);
      }
      login.steps = steps;
    }
    return login;
  }

  if (kind === "api") {
    const authType = (pick("authType", "The login type", 20) ?? "bearer") as ApiAuthType;
    if (!API_AUTH_TYPES.includes(authType)) throw new Error("Choose how the API key is sent: bearer token, header, basic, query, OAuth2 or a sign-in call.");
    login.authType = authType;
    if (authType === "oauth2" || authType === "login") {
      const tokenUrl = pick("tokenUrl", authType === "oauth2" ? "The token address" : "The sign-in call address", 2000);
      if (!tokenUrl) throw new Error(authType === "oauth2" ? "Enter the OAuth2 token address." : "Enter the address of the sign-in call, like https://api.example.com/auth/login.");
      login.tokenUrl = validateTarget(tokenUrl);
      login.username = pick("username", authType === "oauth2" ? "The client id" : "The user name", 300);
      if (!login.username) throw new Error(authType === "oauth2" ? "Enter the client id." : "Enter the user name or email.");
      const keepSecret = keep?.authType === authType && keep.hasPassword;
      if (!password && !keepSecret) throw new Error(authType === "oauth2" ? "Enter the client secret." : "Enter the password.");
      login.password = password;
      if (authType === "oauth2") login.scope = pick("scope", "The scopes", 500);
      else login.tokenPath = pick("tokenPath", "Where the token is", 200);
      const header = pick("paramName", "The header name", 100);
      if (header && !/^[A-Za-z0-9_-]+$/.test(header)) throw new Error("The header name can only have letters, digits, - and _.");
      login.paramName = header;
      return login;
    }
    if (authType === "basic") {
      login.username = pick("username", "The user name", 200);
      if (!login.username) throw new Error("Enter the user name for basic login.");
      if (!password && !(keep?.authType === "basic" && keep.hasPassword)) throw new Error("Enter the password for basic login.");
      login.password = password;
      return login;
    }
    if (authType === "header" || authType === "query") {
      login.paramName = pick("paramName", "The header or parameter name", 100);
      if (!login.paramName || !/^[A-Za-z0-9_.-]+$/.test(login.paramName)) {
        throw new Error(`Enter the ${authType === "header" ? "header" : "query parameter"} name, for example ${authType === "header" ? "X-API-Key" : "api_key"}.`);
      }
    }
    if (!token && !(keep?.authType === authType && keep.hasToken)) throw new Error("Enter the API key or token.");
    login.token = token;
    return login;
  }

  // Git: an access token with read access to the repository.
  login.username = pick("username", "The user name", 100);
  if (login.username && !/^[\w.@-]+$/.test(login.username)) throw new Error("The user name has characters Git does not allow.");
  if (!token && !keep?.hasToken) throw new Error("Enter the access token for the repository.");
  login.token = token;
  return login;
}

export const MAX_ROLES = 6;

/** Checks another account entered for a project (a role, or a user of another company). */
export function buildRole(type: ProductType, input: Partial<RoleLogin> & { login?: Partial<Login> }, main: LoginSummary | undefined, prev?: RoleSummary): RoleLogin {
  if (!APP_TYPES.includes(type) && type !== "api") throw new Error("Other accounts are for web apps, SaaS, CRMs and APIs.");
  const kind = type === "api" ? "api" : "web";
  if (!main || main.kind !== kind) throw new Error("Save the main login first: other accounts are tested next to it.");
  const name = String(input.name ?? prev?.name ?? "").trim().slice(0, 40);
  if (!name || CONTROL.test(name)) throw new Error("Give the role a name, like Sales staff or Other company.");
  const li: Partial<Login> = { ...(input.login ?? {}) };
  if (kind === "web" && !li.loginUrl && !prev?.login.loginUrl) li.loginUrl = main.loginUrl;
  const login = buildLogin(type, li, prev?.login);
  const mustNotOpen = String(input.mustNotOpen ?? prev?.mustNotOpen ?? "").slice(0, 2000).trim();
  if (CONTROL.test(mustNotOpen.replace(/[\r\n]/g, ""))) throw new Error("The addresses have characters that are not allowed.");
  return {
    id: (String(input.id ?? prev?.id ?? "").replace(/[^\w-]/g, "").slice(0, 20) || `r${Date.now().toString(36)}`),
    name,
    login: { ...login, roleName: name },
    ...(input.otherCompany ?? prev?.otherCompany ? { otherCompany: true } : {}),
    ...(input.lockoutTest ?? prev?.lockoutTest ? { lockoutTest: true } : {}),
    ...(mustNotOpen ? { mustNotOpen } : {}),
  };
}

const APP_TYPES: ProductType[] = ["webapp", "saas", "crm"];
