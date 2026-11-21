/**
 * Client connections: how the testing agent, running on GLV's own servers, reaches a client's own
 * system. Three ways, each saved per project:
 *
 * - ssh: GLV signs in to the client's server with an SSH key (or password) the client gave. Every
 *   test then reads the server's health and safety settings (fixed, read-only commands), and can
 *   open the client's private test site through the server (a tunnel), for sites not on the internet.
 * - hostinger: the client's Hostinger API token (from hPanel). Every test reads the account's
 *   servers, websites and domains (read-only GET calls): stopped servers, missing firewalls and
 *   backups, domains about to expire, missing email protection (SPF, DMARC).
 * - mcp: the client's own MCP server (the tools they give AI assistants). Every test checks it the way
 *   an attacker would look at it: sign-in, HTTPS, Origin checks and hidden instructions in tool
 *   descriptions. Tools are only listed, never called.
 *
 * Secrets (keys, passwords, tokens) are sealed in the vault with SECRET_KEY, or kept out of the
 * database altogether as a reference to the server's .env (env:CONN_NAME) or a key file
 * (file:name in SSH_KEYS_DIR). The dashboard only ever sees whether a secret is saved.
 */

export type ConnectionKind = "ssh" | "hostinger" | "mcp";

export const CONNECTION_KINDS: ConnectionKind[] = ["ssh", "hostinger", "mcp"];

export interface ConnectionTest {
  at: string;
  ok: boolean;
  /** One plain line: what worked, or what to fix. */
  message: string;
  /** What the test saw (the server's system, the account's websites, the MCP server's tools). */
  details?: string[];
  /** Hostinger: the account's website addresses, offered as test addresses. */
  sites?: string[];
  /** Hostinger: the account's servers, offered for an SSH connection. */
  servers?: { name: string; ip: string }[];
}

/** What is saved about a connection, without its secret. */
export interface Connection {
  id: string;
  projectId: string;
  kind: ConnectionKind;
  name: string;
  /** SSH: the server's address (name or IP), port and user. */
  host?: string;
  port?: number;
  username?: string;
  /** SSH: sign in with a key (the default) or a password. */
  auth?: "key" | "password";
  /** SSH: the server's key fingerprint, kept from the first test (a changed key stops every test). */
  hostKey?: string;
  /** SSH: open the test site through this server (for a private test site). */
  tunnel?: boolean;
  /** SSH tunnel: the site's address as the server sees it (http://localhost:8080, http://staging.internal). */
  siteUrl?: string;
  /** MCP: the server's address (Streamable HTTP). */
  url?: string;
  /**
   * Where the secret is when it is not sealed in the vault: "env:CONN_ACME_TOKEN" (a line in the
   * server's .env) or "file:acme.pem" (a key file in SSH_KEYS_DIR).
   */
  secretRef?: string;
  /** Run this connection's checks on every test of the project (on unless turned off). */
  checks: boolean;
  lastTest?: ConnectionTest;
  createdAt: string;
  updatedAt: string;
  by: string;
}

/** The secret parts, sealed in the vault. */
export interface ConnectionSecret {
  /** SSH private key (OpenSSH or PEM text). */
  key?: string;
  /** SSH key passphrase, or the SSH password. */
  password?: string;
  /** Hostinger API token, or the MCP server's bearer token. */
  token?: string;
}

/** What the dashboard sees: never the secret, only whether there is one and where it is kept. */
export type ConnectionView = Connection & {
  secret: "saved" | "reference" | "none" | "unreadable";
  /** True for the kinds whose checks run in tests (all of them; kept for the dashboard's label). */
  label: string;
};

/** A connection with its secret, decrypted for one test or one connection check only. */
export type ResolvedConnection = Connection & { secret: ConnectionSecret };

export const KIND_LABEL: Record<ConnectionKind, string> = {
  ssh: "SSH server",
  hostinger: "Hostinger account",
  mcp: "MCP server",
};
