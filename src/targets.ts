import { existsSync } from "node:fs";
import { uploadedPath } from "./engines/index.js";
import { validateRepoUrl } from "./engines/code.js";
import { validateTarget } from "./runner/urls.js";
import type { ApiAuthType, Login, LoginKind, LoginSummary, ProductType, ProjectTarget } from "./types.js";
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
}

/** Which uploaded file types each product takes. */
export const UPLOAD_TYPES: Record<string, RegExp> = {
  api: /\.(json|ya?ml)$/i,
  code: /\.zip$/i,
  android: /\.apk$/i,
  ios: /\.ipa$/i,
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
    if (!t.specUrl && !t.file) throw new Error("Enter the address of the OpenAPI (Swagger) file, or upload it.");
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
    if (!t.repoUrl && !t.file) throw new Error("Enter the repository address, or upload a zip of the code.");
    return t;
  }

  if (type === "android" || type === "ios") {
    if (!t.file) throw new Error(`Upload the ${type === "android" ? "APK" : "IPA"} file to test.`);
    return t;
  }
  return t;
}

/** A readable default name for a new project. */
export function defaultName(type: ProductType, t: ProjectTarget): string {
  try {
    if (t.repoUrl) return new URL(t.repoUrl).pathname.split("/").filter(Boolean).slice(-1)[0]?.replace(/\.git$/, "") || "Code";
    if (t.specUrl) return `${new URL(t.specUrl).hostname.replace(/^www\./, "")} API`;
    if (t.url) return new URL(t.url).hostname.replace(/^www\./, "");
  } catch {
    /* fall through */
  }
  if (t.fileName) return t.fileName.replace(/\.(apk|ipa|zip|json|ya?ml)$/i, "");
  return type;
}

/** Which kind of login a product uses: a sign-in form, an API key or token, or a Git access token. */
export function loginKindFor(type: ProductType): LoginKind | undefined {
  if (WEB_PRODUCTS.includes(type)) return "web";
  if (type === "api") return "api";
  if (type === "code") return "git";
  return undefined;
}

const API_AUTH_TYPES: ApiAuthType[] = ["bearer", "header", "basic", "query"];
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
    return login;
  }

  if (kind === "api") {
    const authType = (pick("authType", "The login type", 20) ?? "bearer") as ApiAuthType;
    if (!API_AUTH_TYPES.includes(authType)) throw new Error("Choose how the API key is sent: bearer token, header, basic or query.");
    login.authType = authType;
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
