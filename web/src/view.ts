import { useSyncExternalStore } from "react";

/*
 * Simple or full view. Simple (the default) hides the long lists of agents, tools and settings
 * and keeps each screen to what most testers need; full shows everything. Remembered in this
 * browser. Nothing about how a test runs changes: both views start the same safe test.
 */
export type View = "simple" | "full";
const KEY = "glv.view";
const listeners = new Set<() => void>();

function read(): View {
  try {
    return localStorage.getItem(KEY) === "full" ? "full" : "simple";
  } catch {
    return "simple";
  }
}
let current: View = read();

export function setView(v: View) {
  current = v;
  try {
    if (v === "simple") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    // Private window: the choice lasts until the tab closes.
  }
  for (const l of listeners) l();
}

export function useView(): View {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export const useSimple = () => useView() === "simple";
