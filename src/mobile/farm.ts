import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AppDevice } from "./devices.js";

/**
 * GLV's own phone farm: a rack of real Android phones and iPhones, used remotely from the tool
 * instead of BrowserStack or Sauce Labs.
 * - Android: DeviceFarmer (STF, open source) runs on the farm machine (docker compose --profile farm)
 *   with the phones on USB. The tool lists them through STF's API, reserves one, and connects adb to
 *   it over the network; Appium on GLV's server then drives it like any test phone.
 * - iPhones: go-ios (open source) talks to iPhones on USB from Linux, so no Mac is needed to list
 *   them, read their details and start WebDriverAgent for Appium's XCUITest driver.
 */

export interface FarmPhone {
  source: "stf" | "go-ios";
  serial: string;
  name: string;
  platform: "android" | "ios";
  version?: string;
  /** Free to reserve right now. */
  available: boolean;
  /** Who has it, when someone else is using it. */
  usedBy?: string;
  battery?: number;
}

interface StfDevice {
  serial: string;
  present?: boolean;
  ready?: boolean;
  using?: boolean;
  owner?: { name?: string; email?: string } | null;
  model?: string;
  manufacturer?: string;
  marketName?: string;
  version?: string;
  battery?: { level?: number };
}

/** Turns STF's /api/v1/devices answer into farm phones. Pure, for tests. */
export function readStfDevices(data: { devices?: StfDevice[] }): FarmPhone[] {
  return (data.devices ?? [])
    .filter((d) => d.present !== false)
    .map((d) => ({
      source: "stf" as const,
      serial: d.serial,
      name: [d.manufacturer, d.marketName || d.model].filter(Boolean).join(" ") || d.serial,
      platform: "android" as const,
      version: d.version,
      available: Boolean(d.ready) && !d.owner,
      ...(d.owner ? { usedBy: d.owner.name || d.owner.email || "someone" } : {}),
      ...(d.battery?.level !== undefined ? { battery: d.battery.level } : {}),
    }));
}

/** Reads `ios list --details` (go-ios JSON) into farm phones. Pure, for tests. */
export function readGoIos(json: string): FarmPhone[] {
  let data: { deviceList?: { Udid?: string; ProductName?: string; ProductVersion?: string; DeviceName?: string; ProductType?: string }[] };
  try {
    data = JSON.parse(json.trim().split("\n").find((l) => l.startsWith("{")) ?? "{}");
  } catch {
    return [];
  }
  return (data.deviceList ?? [])
    .filter((d) => d.Udid)
    .map((d) => ({ source: "go-ios" as const, serial: d.Udid!, name: d.DeviceName || d.ProductType || "iPhone", platform: "ios" as const, version: d.ProductVersion, available: true }));
}

function stf(): { url: string; token: string } | null {
  const url = process.env.STF_URL?.replace(/\/+$/, "");
  const token = process.env.STF_TOKEN;
  return url && token ? { url, token } : null;
}

async function stfCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const s = stf();
  if (!s) throw new Error("The phone farm (STF) is not set up: set STF_URL and STF_TOKEN in .env.");
  const res = await fetch(`${s.url}${path}`, { ...init, headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  const data = (await res.json().catch(() => ({}))) as T & { description?: string };
  if (!res.ok) throw new Error(`The phone farm answered ${res.status}${data.description ? `: ${data.description}` : ""}`);
  return data;
}

function goIos(args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(process.env.GO_IOS_PATH || "ios", args, { timeout: 20_000 }, (_e, out) => resolve(String(out ?? ""))));
}

/** Every phone in the farm, Android (STF) and iPhone (go-ios), with whether it is free. */
export async function farmPhones(): Promise<{ phones: FarmPhone[]; notes: string[] }> {
  const phones: FarmPhone[] = [];
  const notes: string[] = [];
  if (stf()) {
    try {
      phones.push(...readStfDevices(await stfCall<{ devices?: StfDevice[] }>("/api/v1/devices?fields=serial,present,ready,using,owner,model,manufacturer,marketName,version,battery")));
    } catch (err) {
      notes.push(`Android farm (STF): ${(err as Error).message}`);
    }
  } else notes.push("Android farm (STF) is not set up: start docker compose --profile farm and set STF_URL and STF_TOKEN.");
  const ios = await goIos(["list", "--details"]);
  if (ios.trim()) phones.push(...readGoIos(ios));
  else notes.push("No iPhone on USB (go-ios found none, or it is not installed).");
  return { phones, notes };
}

/**
 * Takes a farm phone for testing and returns it as a test phone the tools can use: STF reserves it
 * and opens remote adb, which adb on this server connects to; an iPhone keeps its UDID for Appium's
 * XCUITest driver (WebDriverAgent started with go-ios).
 */
export async function useFarmPhone(source: FarmPhone["source"], serial: string, hours = 2): Promise<AppDevice> {
  const appiumUrl = process.env.APPIUM_URL || "http://127.0.0.1:4723";
  if (source === "stf") {
    await stfCall("/api/v1/user/devices", { method: "POST", body: JSON.stringify({ serial, timeout: Math.min(hours, 8) * 3600_000 }) });
    const remote = await stfCall<{ remoteConnectUrl?: string }>(`/api/v1/user/devices/${encodeURIComponent(serial)}/remoteConnect`, { method: "POST" });
    if (!remote.remoteConnectUrl) throw new Error("The phone farm did not give a remote adb address.");
    await new Promise<void>((ok) => execFile(process.env.ADB_PATH || "adb", ["connect", remote.remoteConnectUrl!], { timeout: 20_000 }, () => ok()));
    return { id: `farm-${randomBytes(3).toString("hex")}`, name: `Farm: ${serial}`, platform: "android", appiumUrl, kind: "phone", udid: remote.remoteConnectUrl };
  }
  const info = await goIos(["info", "--udid", serial]);
  const version = info.match(/"ProductVersion"\s*:\s*"([^"]+)"/)?.[1];
  return { id: `farm-${randomBytes(3).toString("hex")}`, name: `Farm iPhone ${serial.slice(0, 8)}`, platform: "ios", appiumUrl: process.env.IOS_APPIUM_URL || appiumUrl, kind: "phone", udid: serial, ...(version ? { platformVersion: version } : {}) };
}

/** Gives an STF phone back to the farm. */
export async function releaseFarmPhone(serial: string): Promise<void> {
  if (!stf()) return;
  await stfCall(`/api/v1/user/devices/${encodeURIComponent(serial)}`, { method: "DELETE" }).catch(() => undefined);
}
