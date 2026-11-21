/*
 * One app on one test phone, through Appium: start it again, read the screen, tell whether it is
 * still open, read crash logs, and run adb shell commands (Android, when Appium allows adb_shell).
 */
import { parseScreen, type UiScreen } from "./screen.js";
import { WebDriver, WebDriverError } from "./webdriver.js";

export interface AppCrash {
  /** "crash", "anr" (the app stopped answering) or "closed" (it left without a crash log). */
  type: "crash" | "anr" | "closed";
  /** The error's first line, e.g. java.lang.NullPointerException: ... */
  reason: string;
  /** The stack trace lines. */
  stack: string[];
  /** What was being done: "tapping \"Cart\" on Home". */
  during: string;
  screenshot?: string;
}

/** APP_TEST_PACE below 1 shortens every wait (the tests' stand-in phone answers at once). */
const pace = () => Math.min(1, Math.max(0.05, Number(process.env.APP_TEST_PACE) || 1));

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms * pace());
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export class AppRunner {
  /** False once Appium refuses adb shell (it was started without --allow-insecure adb_shell). */
  shellOk: boolean;
  win = { width: 0, height: 0 };
  /** Screen units per dp (Android) or point (iOS). */
  dp = 1;
  constructor(
    readonly driver: WebDriver,
    readonly platform: "android" | "ios",
    readonly appId: string,
    readonly log: (m: string) => void,
    readonly signal?: AbortSignal,
  ) {
    this.shellOk = platform === "android";
  }

  async init(): Promise<void> {
    this.win = await this.driver.windowRect().catch(() => ({ x: 0, y: 0, width: 1080, height: 2280 }));
    if (this.platform === "android") {
      const info = (await this.driver.mobile("deviceInfo").catch(() => null)) as { displayDensity?: number } | null;
      this.dp = info?.displayDensity ? info.displayDensity / 160 : 2.625;
    }
    // Drop the log lines from before the app started.
    await this.driver.logs(this.platform === "android" ? "logcat" : "crashlog");
  }

  async screen(): Promise<UiScreen> {
    return parseScreen(await this.driver.source(), this.platform);
  }

  /** Waits until the screen stops changing (two reads in a row the same), up to about 4 seconds. */
  async settle(): Promise<UiScreen> {
    let last = await this.screen();
    for (let i = 0; i < 6; i++) {
      await sleep(350, this.signal);
      const next = await this.screen();
      if (next.signature === last.signature) return next;
      last = next;
    }
    return last;
  }

  /** Is the app still the one on screen? */
  async inApp(screen?: UiScreen): Promise<boolean> {
    if (this.platform === "android") {
      const pkg = await this.driver.mobile("getCurrentPackage").catch(() => screen?.pkg);
      return !pkg || pkg === this.appId;
    }
    const state = await this.driver.mobile("queryAppState", { bundleId: this.appId }).catch(() => 4);
    return Number(state) === 4;
  }

  async relaunch(): Promise<void> {
    const key = this.platform === "android" ? { appId: this.appId } : { bundleId: this.appId };
    await this.driver.mobile("terminateApp", key).catch(() => {});
    await this.driver.mobile("activateApp", key);
    await sleep(800, this.signal);
  }

  /** New crashes and "not responding" reports for this app in the device log. */
  async crashes(during: string): Promise<AppCrash[]> {
    const lines = (await this.driver.logs(this.platform === "android" ? "logcat" : "crashlog")).map((l) => l.message);
    return this.platform === "android" ? parseLogcat(lines, this.appId, during) : parseIosCrashes(lines, this.appId, during);
  }

  /** Runs an adb shell command; null when Appium does not allow it. */
  async shell(command: string, args: string[] = [], timeoutMs = 60_000): Promise<string | null> {
    if (!this.shellOk) return null;
    try {
      return String((await this.driver.mobile("shell", { command, args, timeout: timeoutMs }, timeoutMs + 5000)) ?? "");
    } catch (err) {
      if (err instanceof WebDriverError && /insecure|adb_shell|not been enabled|unknown command/i.test(err.message)) {
        this.shellOk = false;
        this.log("Appium does not allow adb shell (start it with --allow-insecure=*:adb_shell): speed, dark mode, large text, offline and traffic checks are skipped");
        return null;
      }
      throw err;
    }
  }
}

/** Crash reports in Android's log (AndroidRuntime's FATAL EXCEPTION, and ANRs from the system). */
export function parseLogcat(lines: string[], pkg: string, during: string): AppCrash[] {
  const out: AppCrash[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/FATAL EXCEPTION/.test(l)) {
      const block: string[] = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
        if (/FATAL EXCEPTION/.test(lines[j])) break;
        if (!/AndroidRuntime/.test(lines[j]) && block.length > 2) break;
        block.push(lines[j].replace(/^.*?AndroidRuntime:\s?/, ""));
      }
      const proc = block.find((b) => /^Process:/.test(b));
      if (proc && !proc.includes(pkg)) continue;
      const body = block.filter((b) => !/^Process:/.test(b));
      out.push({ type: "crash", reason: (body[0] ?? "The app stopped").trim(), stack: body.slice(1, 16).map((b) => b.trim()).filter(Boolean), during });
    } else if (/ANR in /.test(l) && l.includes(pkg)) {
      const reason = lines.slice(i + 1, i + 6).find((x) => /Reason:/.test(x));
      out.push({ type: "anr", reason: (reason?.replace(/^.*Reason:\s*/, "") ?? "The app stopped answering").trim(), stack: [], during });
    }
  }
  return out;
}

/** Crash reports Appium's XCUITest driver hands over (crashlog), for this app. */
export function parseIosCrashes(lines: string[], bundleId: string, during: string): AppCrash[] {
  const out: AppCrash[] = [];
  for (const text of lines) {
    if (!text.includes(bundleId) && !/"bundleID"\s*:\s*"/.test(text)) continue;
    const reason = text.match(/Exception Type:\s*(.+)/)?.[1] ?? text.match(/"exception"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"/)?.[1] ?? "The app crashed";
    const stack = (text.match(/Thread \d+ Crashed:[\s\S]*?(\n\n|$)/)?.[0] ?? "").split("\n").slice(1, 16).filter(Boolean);
    out.push({ type: "crash", reason: reason.trim(), stack, during });
  }
  return out;
}
