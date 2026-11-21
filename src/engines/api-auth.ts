import type { APIRequestContext } from "playwright";
import type { Login } from "../types.js";
import { validateTarget } from "../runner/urls.js";

/* How a saved API login is sent: a fixed key or token, or one fetched at the start of the test. */

export interface AuthParts {
  headers: Record<string, string>;
  query?: [string, string];
  /** How the login is sent, for the report (never the secret). */
  label: string;
  /** Tokens fetched during the test (OAuth2, sign-in call): hidden in the report like saved secrets. */
  secrets?: string[];
}

/** The headers or query parameter of a fixed login (bearer, header key, query key, basic). */
export function authParts(auth?: Login): AuthParts {
  if (!auth) return { headers: {}, label: "" };
  switch (auth.authType) {
    case "basic":
      return {
        headers: { authorization: `Basic ${Buffer.from(`${auth.username ?? ""}:${auth.password ?? ""}`).toString("base64")}` },
        label: `basic login as ${auth.username}`,
      };
    case "header":
      return { headers: { [auth.paramName!.toLowerCase()]: auth.token ?? "" }, label: `a key in the ${auth.paramName} header` };
    case "query":
      return { headers: {}, query: [auth.paramName!, auth.token ?? ""], label: `a key in the ${auth.paramName} query parameter` };
    case "oauth2":
    case "login":
      // Fetched by resolveAuth; until then nothing is sent.
      return { headers: {}, label: auth.authType === "oauth2" ? "an OAuth2 token" : "a token from the sign-in call" };
    default:
      return { headers: { authorization: `Bearer ${auth.token ?? ""}` }, label: "a bearer token" };
  }
}

/** Reads "$.data.access_token" (or "data.access_token") from a JSON answer. */
export function readPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cur: unknown = value;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** The first token-looking value in a sign-in answer, when no path is given. */
function findToken(json: unknown): string | undefined {
  for (const p of ["access_token", "accessToken", "token", "jwt", "id_token", "data.access_token", "data.accessToken", "data.token", "result.token", "auth.token"]) {
    const v = readPath(json, p);
    if (typeof v === "string" && v.length >= 8) return v;
  }
  return undefined;
}

/**
 * Turns the saved login into what each call sends. OAuth2 client credentials and sign-in calls
 * fetch a token first (the only request of the test that is not GET on a live API: it creates no
 * data). Returns a refresh function the engine calls once when a token runs out mid-test.
 */
export async function resolveAuth(request: APIRequestContext, auth: Login | undefined, log: (m: string) => void): Promise<{ parts: AuthParts; refresh?: () => Promise<AuthParts> }> {
  const fixed = authParts(auth);
  if (!auth || (auth.authType !== "oauth2" && auth.authType !== "login")) return { parts: fixed };
  const fetchToken = async (): Promise<AuthParts> => {
    const url = validateTarget(auth.tokenUrl ?? "");
    let res;
    if (auth.authType === "oauth2") {
      log("Getting an OAuth2 token (client credentials)");
      const form: Record<string, string> = { grant_type: "client_credentials" };
      if (auth.scope) form.scope = auth.scope;
      res = await request.post(url, {
        form,
        headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(auth.username ?? "")}:${encodeURIComponent(auth.password ?? "")}`).toString("base64")}`, accept: "application/json" },
        timeout: 20_000,
        failOnStatusCode: false,
      });
    } else {
      log("Signing in with the sign-in call to get a token");
      const userField = /@/.test(auth.username ?? "") ? "email" : "username";
      res = await request.post(url, {
        data: { [userField]: auth.username, username: auth.username, email: auth.username, password: auth.password },
        headers: { accept: "application/json" },
        timeout: 20_000,
        failOnStatusCode: false,
      });
    }
    const status = res.status();
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    if (status >= 400) throw new Error(`The ${auth.authType === "oauth2" ? "token address" : "sign-in call"} answered HTTP ${status}. Check the address and the saved ${auth.authType === "oauth2" ? "client id and secret" : "user name and password"}.`);
    const token = auth.tokenPath ? readPath(json, auth.tokenPath) : findToken(json);
    if (typeof token !== "string" || !token) {
      throw new Error(
        auth.tokenPath
          ? `The answer has no token at ${auth.tokenPath}.`
          : "The answer has no token (looked for access_token, token and jwt). Enter where the token is, like $.data.token.",
      );
    }
    const header = (auth.paramName ?? "").trim();
    return header && header.toLowerCase() !== "authorization"
      ? { headers: { [header.toLowerCase()]: token }, label: `${fixed.label}, sent in the ${header} header`, secrets: [token] }
      : { headers: { authorization: `Bearer ${token}` }, label: fixed.label, secrets: [token] };
  };
  return { parts: await fetchToken(), refresh: fetchToken };
}
