import { adb, pickAndroid } from "./android-device.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * App performance on a real Android phone, in the way Android's own "GPU rendering" and macrobenchmark
 * numbers work: it cold-starts the app (am start -W) to measure start time, reads the rendering stats
 * (dumpsys gfxinfo) for janky frames, the memory it uses (dumpsys meminfo) and its installed size.
 * These are the numbers that make an app feel slow or heavy. Started by hand on a connected phone.
 */

/** Cold-start time in ms from `am start -W`. Pure, for tests. */
export function parseAmStart(out: string): { totalMs: number | null; waitMs: number | null } {
  const total = out.match(/TotalTime:\s*(\d+)/)?.[1];
  const wait = out.match(/WaitTime:\s*(\d+)/)?.[1];
  return { totalMs: total ? Number(total) : null, waitMs: wait ? Number(wait) : null };
}

/** Janky-frame share from `dumpsys gfxinfo`. Pure, for tests. */
export function parseJank(out: string): { total: number; janky: number; pct: number } | null {
  const total = out.match(/Total frames rendered:\s*(\d+)/)?.[1];
  const janky = out.match(/Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/);
  if (!total || !janky) return null;
  return { total: Number(total), janky: Number(janky[1]), pct: Number(janky[2]) };
}

/** Total memory (PSS, kB) from `dumpsys meminfo <pkg>`. Pure, for tests. */
export function parseMeminfo(out: string): number | null {
  const m = out.match(/TOTAL(?:\s+PSS)?:?\s+(\d+)/) || out.match(/TOTAL\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

export const appPerfTool: Tool = {
  id: "app-perf",
  name: "App performance on device",
  maker: "GLV Infotech (built in), Android gfxinfo/meminfo",
  description:
    "On a connected Android phone, cold-starts the app to measure start time, reads janky frames (stutter while scrolling), the memory it uses and its installed size. These are the numbers users feel. iOS performance is measured by the Mac helper.",
  checks: ["Cold-start time (am start -W TotalTime)", "Janky frames while using the app (dumpsys gfxinfo)", "Memory used (dumpsys meminfo PSS)", "Installed app size"],
  products: ["android"],
  category: "performance",
  safety: "safe",
  takes: "1 to 3 minutes",
  licence: "GLV's own",
  homepage: "https://developer.android.com/topic/performance",
  signedIn: "public",
  needsDevice: true,
  manual: true,
  options: [
    { id: "device", label: "Test phone", kind: "text", placeholder: "auto", hint: "Leave as auto for the first ready Android phone.", choices: [], default: "auto" },
    { id: "startBudgetMs", label: "Warn if cold start over", choices: ["500", "1000", "1500", "2000"].map((v) => ({ value: v, label: `${v} ms` })), default: "1500" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const pkg = ctx.app?.id;
    if (!pkg) throw new Error("No app package is known for this project. Run the mobile test (which reads the app) first.");
    if (ctx.app?.platform === "ios") throw new Error("iOS performance is measured by the Mac helper (Instruments), not this tool.");
    const device = await pickAndroid(ctx.options.device || "auto", ctx.signal);
    const serial = device.udid;
    const budget = Number(ctx.options.startBudgetMs) || 1500;
    ctx.log(`App perf on ${device.name}: ${pkg}`);

    // Find the launchable activity, then cold-start it with -W.
    const resolve = await adb(serial, ["shell", "cmd", "package", "resolve-activity", "--brief", pkg]);
    const activity = resolve.trim().split(/\s+/).find((l) => l.includes("/")) ?? "";
    await adb(serial, ["shell", "am", "force-stop", pkg]);
    const startOut = activity ? await adb(serial, ["shell", "am", "start", "-W", "-n", activity]) : await adb(serial, ["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
    const start = parseAmStart(startOut);
    await new Promise((r) => setTimeout(r, 3000));
    const jank = parseJank(await adb(serial, ["shell", "dumpsys", "gfxinfo", pkg]));
    const mem = parseMeminfo(await adb(serial, ["shell", "dumpsys", "meminfo", pkg]));
    const sizeOut = await adb(serial, ["shell", "sh", "-c", `pm path ${pkg} | sed 's/package://' | xargs -r stat -c %s 2>/dev/null`]);
    const bytes = sizeOut.split(/\s+/).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0).reduce((a, b) => a + b, 0);

    const findings: ToolFinding[] = [];
    if (start.totalMs !== null && start.totalMs > budget)
      findings.push({ category: "performance", rule: "appperf:slow-start", severity: start.totalMs > budget * 2 ? "medium" : "low", title: `Cold start takes ${start.totalMs} ms`, detail: `The app takes ${start.totalMs} ms to open from cold (budget ${budget} ms). Slow starts lose users. Defer heavy work off the main thread, use App Startup/lazy init, and show content sooner with a splash that is not just a blank screen.`, pageUrl: pkg, evidence: startOut.split("\n").filter((l) => /Time/.test(l)).join("\n"), key: "appperf:slow-start" });
    if (jank && jank.pct >= 5 && jank.total >= 20)
      findings.push({ category: "performance", rule: "appperf:jank", severity: jank.pct >= 20 ? "medium" : "low", title: `${jank.pct}% of frames are janky`, detail: `${jank.janky} of ${jank.total} frames missed their deadline, so scrolling and animations stutter. Move work off the UI thread, avoid heavy layouts and large images in lists, and profile with Android's GPU rendering bars.`, pageUrl: pkg, evidence: `Janky frames: ${jank.janky}/${jank.total} (${jank.pct}%)`, key: "appperf:jank" });
    if (mem !== null && mem > 350_000)
      findings.push({ category: "performance", rule: "appperf:memory", severity: "low", title: `The app uses ${(mem / 1024).toFixed(0)} MB of memory`, detail: `${(mem / 1024).toFixed(0)} MB (PSS) is high; on phones with little RAM the system kills the app in the background, losing the user's place. Recycle bitmaps, free caches on onTrimMemory, and watch for leaks.`, pageUrl: pkg, evidence: `TOTAL PSS ${mem} kB`, key: "appperf:memory" });
    if (bytes > 100_000_000)
      findings.push({ category: "performance", rule: "appperf:size", severity: "low", title: `The app is ${(bytes / 1_048_576).toFixed(0)} MB installed`, detail: "A large app is slow to download on mobile data and is uninstalled first when storage is low (a real issue in India). Ship an app bundle (per-device split), compress assets, and remove unused libraries.", pageUrl: pkg, evidence: `${(bytes / 1_048_576).toFixed(1)} MB`, key: "appperf:size" });

    return {
      findings,
      summary: [`Start ${start.totalMs ?? "?"} ms, ${jank ? `${jank.pct}% janky frames` : "frame stats n/a"}, ${mem ? `${(mem / 1024).toFixed(0)} MB RAM` : "memory n/a"}, ${bytes ? `${(bytes / 1_048_576).toFixed(0)} MB installed` : "size n/a"}`],
      tested: `${pkg} on ${device.name}`,
      table: { title: "On-device performance", columns: ["Measure", "Value"], rows: [["Cold start", start.totalMs !== null ? `${start.totalMs} ms` : "n/a"], ["Janky frames", jank ? `${jank.pct}%` : "n/a"], ["Memory (PSS)", mem ? `${(mem / 1024).toFixed(0)} MB` : "n/a"], ["Installed size", bytes ? `${(bytes / 1_048_576).toFixed(1)} MB` : "n/a"]] },
    };
  },
};
