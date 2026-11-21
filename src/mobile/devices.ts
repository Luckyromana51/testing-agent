/*
 * Test phones: Appium servers the platform can drive. The built-in one is the Android emulator in
 * our Docker setup (docker compose --profile android); others are added by the owner (Owner panel
 * > Devices): Appium on GLV's Mac for iPhone Simulators, or on a laptop with a real phone plugged in.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { WebDriver } from "./webdriver.js";

export interface AppDevice {
  id: string;
  name: string;
  platform: "android" | "ios";
  /** The Appium server, e.g. http://127.0.0.1:4723 or http://192.168.1.20:4723. */
  appiumUrl: string;
  kind: "emulator" | "simulator" | "phone";
  /** Android: the adb serial (emulator-5554, or host:port for a network device). iOS: the device UDID. */
  udid?: string;
  /** iOS: the Simulator to start, e.g. "iPhone 16". */
  deviceName?: string;
  platformVersion?: string;
  /**
   * This server as the phone and the Appium machine see it, e.g. http://192.168.1.10:4000. Appium
   * downloads the app from here, and the phone sends its traffic through the recorder on this host.
   */
  serverAddress?: string;
  /** From the server's .env (the Docker emulator): shown, not editable. */
  builtIn?: boolean;
}

let saved: AppDevice[] = [];

export function setDevices(list: AppDevice[] | undefined) {
  saved = list ?? [];
}

/** The device from .env: APPIUM_URL (and ANDROID_DEVICE, APP_SERVER_ADDRESS), set by the Docker emulator profile. */
function builtIn(): AppDevice | undefined {
  const url = process.env.APPIUM_URL;
  if (!url) return undefined;
  return {
    id: "builtin",
    name: process.env.APPIUM_DEVICE_NAME || "Android emulator (built in)",
    platform: process.env.APPIUM_PLATFORM === "ios" ? "ios" : "android",
    appiumUrl: url,
    kind: "emulator",
    udid: process.env.ANDROID_DEVICE || undefined,
    serverAddress: process.env.APP_SERVER_ADDRESS || undefined,
    builtIn: true,
  };
}

export function listDevices(): AppDevice[] {
  const b = builtIn();
  return [...(b ? [b] : []), ...saved];
}

export const deviceById = (id: string) => listDevices().find((d) => d.id === id);

/** Checks a device the owner typed in. Returns the cleaned device. */
export function cleanDevice(input: Record<string, unknown>, id?: string): AppDevice {
  const s = (k: string, max = 200) => (typeof input[k] === "string" ? (input[k] as string).trim().slice(0, max) : "");
  const name = s("name", 60);
  if (!name) throw new Error("Give the device a name.");
  const platform = input.platform === "ios" ? "ios" : input.platform === "android" ? "android" : null;
  if (!platform) throw new Error("Pick Android or iOS.");
  const url = s("appiumUrl");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The Appium address must look like http://192.168.1.20:4723.");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("The Appium address must start with http:// or https://.");
  const server = s("serverAddress");
  if (server) {
    try {
      if (!/^https?:$/.test(new URL(server).protocol)) throw new Error();
    } catch {
      throw new Error("This server's address must look like http://192.168.1.10:4000.");
    }
  }
  const kind = input.kind === "phone" ? "phone" : platform === "ios" ? "simulator" : "emulator";
  const clean = (v: string) => v.replace(/[^\w .:@()-]/g, "");
  return {
    id: id ?? `dev_${randomBytes(6).toString("hex")}`,
    name,
    platform,
    appiumUrl: url.replace(/\/+$/, ""),
    kind: input.kind === "simulator" || input.kind === "emulator" || input.kind === "phone" ? (input.kind as AppDevice["kind"]) : kind,
    ...(s("udid") ? { udid: clean(s("udid", 100)) } : {}),
    ...(s("deviceName") ? { deviceName: clean(s("deviceName", 60)) } : {}),
    ...(s("platformVersion") ? { platformVersion: clean(s("platformVersion", 20)) } : {}),
    ...(server ? { serverAddress: server.replace(/\/+$/, "") } : {}),
  };
}

/** Null when the device's Appium server answers and is ready, else why not. */
export async function deviceStatus(d: AppDevice, signal?: AbortSignal): Promise<string | null> {
  try {
    const s = await WebDriver.status(d.appiumUrl, signal);
    return s.ready ? null : `Appium answered but is not ready${s.message ? `: ${s.message}` : ""}.`;
  } catch (err) {
    return (err as Error).message;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Handing the app to Appium                                                                       */

const shares = new Map<string, { file: string; name: string; until: number }>();

/** A download address for the app, valid for 30 minutes, for an Appium server on another machine. */
export function shareApp(file: string, name: string, server: string): string {
  const token = randomBytes(18).toString("base64url");
  shares.set(token, { file, name, until: Date.now() + 30 * 60_000 });
  return `${server.replace(/\/+$/, "")}/app-files/${token}/${encodeURIComponent(name.replace(/[^\w.-]/g, "_"))}`;
}

/** The app file behind a download address, or undefined when the address is unknown or old. */
export function sharedApp(token: string): { file: string; name: string } | undefined {
  const now = Date.now();
  for (const [k, v] of shares) if (v.until < now) shares.delete(k);
  return shares.get(token);
}

export function unshareApp(url: string) {
  const token = url.split("/app-files/")[1]?.split("/")[0];
  if (token) shares.delete(token);
}

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

/**
 * What to give Appium as "app": the file path when Appium runs on this server (the Docker image),
 * else a download address on this server.
 */
export function appLocation(d: AppDevice, file: string, name: string): { app: string; shared: boolean } {
  if (LOCAL.test(new URL(d.appiumUrl).hostname)) return { app: path.resolve(file), shared: false };
  const server = d.serverAddress || process.env.APP_SERVER_ADDRESS || process.env.PUBLIC_URL;
  if (!server) throw new Error(`Appium on ${d.name} runs on another machine, so it downloads the app from this server: set "This server's address" for the device in Owner panel > Test phones.`);
  return { app: shareApp(file, name, server), shared: true };
}
