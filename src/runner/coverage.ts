import type { Finding } from "../types.js";

/**
 * An agent could not do its check (a database it needs is unreachable, for example). The run goes
 * on, but the report shows the check as "not tested" instead of counting it as passed, and the
 * regression check leaves that agent's issues as they are.
 */
export class NotTestedError extends Error {
  constructor(
    reason: string,
    /** Findings the agent did make before it had to stop. */
    public partial: Finding[] = [],
  ) {
    super(reason);
  }
}

/**
 * Nothing could be tested at all (the site or API could not be reached, or refused every request).
 * The run fails with this message instead of reporting a score.
 */
export class CouldNotTestError extends Error {}

/** Explains a browser or network error in plain words, saying whether it is likely the site or the testing server. */
export function explainLoadError(error: string, url: string): string {
  const code = /net::(ERR_[A-Z_]+)/.exec(error)?.[1] ?? "";
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (code === "ERR_NAME_NOT_RESOLVED" || /ENOTFOUND|getaddrinfo/.test(error)) {
    return `${host} could not be found (the DNS lookup failed). Check the address is spelled right and the domain has not expired.`;
  }
  if (code.startsWith("ERR_CERT") || /certificate|SSL|self[- ]signed|UNABLE_TO_VERIFY/i.test(error)) {
    return `The testing browser could not verify the HTTPS certificate of ${host} (${code || error.split("\n")[0]}). If the site opens normally in your own browser, a proxy or firewall on the testing server is getting in the way, not the site.`;
  }
  if (/ERR_(TUNNEL_CONNECTION_FAILED|PROXY_|NO_SUPPORTED_PROXIES)|ERR_HTTP_RESPONSE_CODE_FAILURE/.test(code)) {
    return `The testing server's network proxy would not connect to ${host} (${code}). The site was not tested; allow the testing server to reach it.`;
  }
  if (/ERR_CONNECTION_(REFUSED|RESET|CLOSED|FAILED)|ERR_EMPTY_RESPONSE|ERR_ADDRESS_UNREACHABLE|ECONNREFUSED|ECONNRESET/.test(code || error)) {
    return `${host} did not accept the connection (${code || "connection refused"}). The site may be down, or a firewall may be blocking the testing server.`;
  }
  if (/ERR_TIMED_OUT|Timeout|timed out/i.test(code || error)) {
    return `${host} did not answer within 30 seconds. The site may be down or very slow, or a firewall may be dropping the testing server's requests.`;
  }
  return `${host} could not be opened: ${error.split("\n")[0]}`;
}

/** First-page answers that mean the testing browser was turned away, so nothing on the site was tested. */
export function refusedStatus(status: number | null, url: string): string | undefined {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (status === 401) return `${host} asks for a login (HTTP 401) before showing anything. Add the login in the project's settings.`;
  if (status === 403) {
    return `${host} refused the testing browser (HTTP 403). It may block automated visitors (a firewall, Cloudflare or a security plugin): allow the testing server's address, then re-test.`;
  }
  if (status === 407) return `The testing server's network proxy refused to open ${host} (HTTP 407).`;
  if (status === 429) return `${host} is rate limiting the testing browser (HTTP 429). Wait a few minutes, or allow the testing server's address, then re-test.`;
  return undefined;
}
