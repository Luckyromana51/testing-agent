import { execFile } from "node:child_process";
import { deviceById, deviceStatus, listDevices, type AppDevice } from "../mobile/devices.js";

/**
 * Shared helpers for the tools that drive a real Android phone over adb (on-device performance,
 * deep-link runner, TalkBack labels). iOS is handled by the Mac helper, so these are Android-only.
 */

/** Picks a ready Android test phone (a named one, or the first ready). */
export async function pickAndroid(choice: string, signal?: AbortSignal): Promise<AppDevice> {
  if (choice && choice !== "auto") {
    const d = deviceById(choice);
    if (!d) throw new Error("The chosen test phone was removed: pick another.");
    if (d.platform !== "android") throw new Error(`${d.name} is not an Android phone.`);
    const why = await deviceStatus(d, signal);
    if (why) throw new Error(`${d.name} is not ready: ${why}`);
    return d;
  }
  const mine = listDevices().filter((d) => d.platform === "android");
  if (!mine.length) throw new Error("No Android test phone is set up: add one in Owner panel > Test phones, or start the built-in emulator (docker compose --profile android up -d).");
  const reasons: string[] = [];
  for (const d of mine) {
    const why = await deviceStatus(d, signal);
    if (!why) return d;
    reasons.push(`${d.name}: ${why}`);
  }
  throw new Error(`No Android test phone is ready. ${reasons.join(" ")}`);
}

/** Runs one adb command against the device, returning stdout (empty on failure). */
export function adb(serial: string | undefined, args: string[], timeoutMs = 30_000): Promise<string> {
  const full = serial ? ["-s", serial, ...args] : args;
  return new Promise((resolve) => {
    execFile("adb", full, { timeout: timeoutMs, maxBuffer: 20_000_000 }, (err, stdout) => resolve(err ? (stdout ?? "").toString() : stdout.toString()));
  });
}
