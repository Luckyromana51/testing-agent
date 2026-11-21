/*
 * A small W3C WebDriver client for Appium: just the calls the app explorer needs. It talks plain
 * HTTP to the Appium server (in our Docker image, on GLV's Mac, or on a laptop with a phone
 * plugged in), so there is no extra package to install.
 */

export class WebDriverError extends Error {
  constructor(
    message: string,
    readonly error?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ELEMENT = "element-6066-11e4-a52d-4f735466cecf";

export class WebDriver {
  private constructor(
    readonly base: string,
    readonly sessionId: string,
    readonly capabilities: Record<string, unknown>,
    private readonly signal?: AbortSignal,
  ) {}

  /** Opens a session: Appium installs the app and starts it. */
  static async start(base: string, capabilities: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WebDriver> {
    const url = base.replace(/\/+$/, "");
    const res = await call(url, "POST", "/session", { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, opts.signal, opts.timeoutMs ?? 300_000);
    const value = res as { sessionId?: string; capabilities?: Record<string, unknown> };
    if (!value.sessionId) throw new WebDriverError("Appium did not start a session.");
    return new WebDriver(url, value.sessionId, value.capabilities ?? {}, opts.signal);
  }

  /** Appium's /status: ready, and its version. */
  static async status(base: string, signal?: AbortSignal): Promise<{ ready: boolean; message?: string; version?: string }> {
    const v = (await call(base.replace(/\/+$/, ""), "GET", "/status", undefined, signal, 8000)) as { ready?: boolean; message?: string; build?: { version?: string } };
    return { ready: v.ready !== false, message: v.message, version: v.build?.version };
  }

  private cmd(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 120_000) {
    return call(this.base, method, `/session/${this.sessionId}${path}`, body, this.signal, timeoutMs);
  }

  async quit(): Promise<void> {
    await this.cmd("DELETE", "", undefined, 60_000).catch(() => {});
  }

  /** The screen's element tree as XML (UiAutomator2 or XCUITest format). */
  async source(): Promise<string> {
    return String(await this.cmd("GET", "/source"));
  }

  /** A PNG of the screen, base64. */
  async screenshot(): Promise<string> {
    return String(await this.cmd("GET", "/screenshot"));
  }

  async windowRect(): Promise<Rect> {
    return (await this.cmd("GET", "/window/rect")) as Rect;
  }

  /** A tap at a point on the screen (pixels on Android, points on iOS). */
  async tap(x: number, y: number): Promise<void> {
    await this.cmd("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "finger",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y) },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 80 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await this.cmd("DELETE", "/actions").catch(() => {});
  }

  async swipe(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.cmd("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "finger",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Math.round(from.x), y: Math.round(from.y) },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration: 400, x: Math.round(to.x), y: Math.round(to.y) },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await this.cmd("DELETE", "/actions").catch(() => {});
  }

  async back(): Promise<void> {
    await this.cmd("POST", "/back", {});
  }

  /** Finds one element by XPath; null when there is none. */
  async find(xpath: string): Promise<string | null> {
    try {
      const v = (await this.cmd("POST", "/element", { using: "xpath", value: xpath })) as Record<string, string>;
      return v[ELEMENT] ?? Object.values(v)[0] ?? null;
    } catch (err) {
      if (err instanceof WebDriverError && err.error === "no such element") return null;
      throw err;
    }
  }

  async click(element: string): Promise<void> {
    await this.cmd("POST", `/element/${element}/click`, {});
  }

  async clear(element: string): Promise<void> {
    await this.cmd("POST", `/element/${element}/clear`, {}).catch(() => {});
  }

  async type(element: string, text: string): Promise<void> {
    await this.cmd("POST", `/element/${element}/value`, { text, value: [...text] });
  }

  async setOrientation(orientation: "PORTRAIT" | "LANDSCAPE"): Promise<void> {
    await this.cmd("POST", "/orientation", { orientation });
  }

  /** Runs an Appium "mobile:" command (mobile: shell, mobile: activateApp...). */
  async mobile(name: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<unknown> {
    return this.cmd("POST", "/execute/sync", { script: `mobile: ${name}`, args: [args] }, timeoutMs);
  }

  /** New log lines of a type ("logcat" on Android, "syslog" or "crashlog" on iOS). */
  async logs(type: string): Promise<{ message: string; timestamp?: number }[]> {
    try {
      const v = await this.cmd("POST", "/se/log", { type });
      return Array.isArray(v) ? (v as { message: string; timestamp?: number }[]) : [];
    } catch {
      return [];
    }
  }
}

async function call(base: string, method: string, path: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const e = err as Error & { cause?: { code?: string } };
    throw new WebDriverError(timeout.aborted ? `Appium did not answer within ${Math.round(timeoutMs / 1000)} s (${method} ${path.replace(/\/session\/[^/]+/, "")}).` : `Appium at ${base} could not be reached (${e.cause?.code ?? e.message}).`);
  }
  const text = await res.text();
  let json: { value?: unknown } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new WebDriverError(`Appium answered ${res.status} with something that is not JSON.`, undefined, res.status);
  }
  const value = json.value as { error?: string; message?: string } | undefined;
  if (!res.ok || (value && typeof value === "object" && "error" in value && value.error)) {
    throw new WebDriverError(String(value?.message ?? `Appium answered ${res.status}`).split("\n")[0], value?.error, res.status);
  }
  return json.value;
}
