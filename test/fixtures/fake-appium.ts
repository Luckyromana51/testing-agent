/*
 * A stand-in for an Appium server with a phone attached, so the device tests run without the
 * Android SDK, an emulator or a Mac. It speaks the W3C WebDriver calls the explorer uses and plays a
 * small demo shop app with deliberate problems:
 *
 * - Home: an icon button with no label, a "?" button 20 dp wide, a light-grey text (low contrast),
 *   "Cart" crashes the app (NullPointerException), dark mode makes the title hard to read
 * - Products: turning the phone sideways crashes it; a product has "Buy now" (must never be tapped)
 * - Settings: "Delete account" and "Log out" (must never be tapped), About runs off the screen with large text
 * - Sign in: a password field with no label; test@glv.in / s3cret signs in
 * - No internet: a blank screen. Traffic: a plain-HTTP call with a token, and Firebase Analytics at launch
 * - Speed: 3.2 s cold start, 350 MB memory, 25% slow frames
 * - Interruptions: back from the background it starts again on Home (the screen is lost); with the
 *   camera permission turned off, opening Products crashes it
 */
import http from "node:http";
import net from "node:net";
import { encodePng } from "../../src/mobile/png.js";

type Kind = "text" | "button" | "image-button" | "field" | "password";
interface El {
  kind: Kind;
  id?: string;
  text?: string;
  desc?: string;
  hint?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fg?: string;
  bg?: string;
  tap?: string;
}

export interface FakePhone {
  url: string;
  /** Every label tapped, in order. */
  taps: string[];
  shell: string[];
  close(): Promise<void>;
  /** Plain-HTTP backend the demo app calls (through the phone's proxy). */
  backendHits: string[];
}

const PKG = "in.glv.demoshop";

export async function startFakeAppium(opts: { platform?: "android" | "ios"; shell?: boolean; appId?: string } = {}): Promise<FakePhone> {
  const platform = opts.platform ?? "android";
  const appId = opts.appId ?? PKG;
  const W = platform === "android" ? 540 : 390;
  const H = platform === "android" ? 1140 : 844;
  const s = (n: number) => (platform === "android" ? Math.round(n * 1.5) : n); // dp to screen units
  const taps: string[] = [];
  const shellLog: string[] = [];
  const backendHits: string[] = [];
  const backend = http.createServer((req, res) => {
    backendHits.push(req.url ?? "");
    res.end('{"products":[]}');
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()));
  const backendPort = (backend.address() as net.AddressInfo).port;

  const state = {
    session: "",
    running: false,
    screen: "home",
    stack: [] as string[],
    signedIn: false,
    fields: {} as Record<string, string>,
    focused: "",
    landscape: false,
    fontScale: 1,
    dark: false,
    offline: false,
    proxy: "",
    tablet: false,
    cameraOff: false,
    foreground: "",
    log: [] as string[],
  };
  const win = () => (state.tablet ? { width: 800, height: 1280 } : state.landscape ? { width: H, height: W } : { width: W, height: H });

  const crash = (error: string, at: string) => {
    state.running = false;
    state.log.push(
      "E AndroidRuntime: FATAL EXCEPTION: main",
      `E AndroidRuntime: Process: ${appId}, PID: 4242`,
      `E AndroidRuntime: ${error}`,
      `E AndroidRuntime: \tat ${appId}.${at}(${at.split(".")[0]}.kt:42)`,
      "E AndroidRuntime: \tat android.view.View.performClick(View.java:7659)",
    );
  };

  const elements = (): El[] => {
    if (!state.running) return [{ kind: "text", text: "Phone home screen", x: 0, y: s(40), w: W, h: s(40) }];
    if (state.offline && state.screen === "home") return [];
    const dark = state.dark;
    const bw = W - s(40);
    switch (state.screen) {
      case "home":
        return [
          { kind: "text", text: "GLV Shop", x: s(20), y: s(20), w: s(200), h: s(36), fg: dark ? "#333333" : "#111111", bg: dark ? "#121212" : "#ffffff" },
          { kind: "image-button", id: "menu_button", x: W - s(64), y: s(16), w: s(48), h: s(48), tap: "nothing" },
          ...(state.signedIn ? [{ kind: "text" as const, text: "Welcome, Test", x: s(20), y: s(70), w: s(200), h: s(24) }] : []),
          { kind: "button", text: "Products", id: "products", x: s(20), y: s(110), w: bw, h: s(56), tap: "products" },
          { kind: "button", text: "Cart", id: "cart", x: s(20), y: s(180), w: bw, h: s(56), tap: "crash-cart" },
          { kind: "button", text: "Settings", id: "settings", x: s(20), y: s(250), w: bw, h: s(56), tap: "settings" },
          ...(!state.signedIn ? [{ kind: "button" as const, text: "Sign in", id: "sign_in", x: s(20), y: s(320), w: bw, h: s(56), tap: "signin" }] : []),
          { kind: "button", text: "?", id: "help", x: s(20), y: s(400), w: s(20), h: s(20), tap: "nothing" },
          { kind: "text", text: "Free delivery over 499", x: s(20), y: s(440), w: s(260), h: s(24), fg: "#c8c8c8", bg: "#ffffff" },
        ];
      case "products":
        return [
          { kind: "text", text: "Products", x: s(20), y: s(20), w: s(200), h: s(36) },
          { kind: "button", text: "Shoes", id: "row_shoes", x: 0, y: s(80), w: W, h: s(56), tap: "shoes" },
        ];
      case "shoes":
        return [
          { kind: "text", text: "Running shoes", x: s(20), y: s(20), w: s(240), h: s(36) },
          { kind: "button", text: "Buy now", id: "buy", x: s(20), y: s(100), w: bw, h: s(56), tap: "risky-buy" },
        ];
      case "settings":
        return [
          { kind: "text", text: "Settings", x: s(20), y: s(20), w: s(200), h: s(36) },
          { kind: "button", text: "About", id: "about", x: s(20), y: s(80), w: bw, h: s(56), tap: "about" },
          { kind: "button", text: "Delete account", id: "delete_account", x: s(20), y: s(150), w: bw, h: s(56), tap: "risky-delete" },
          { kind: "button", text: "Log out", id: "logout", x: s(20), y: s(220), w: bw, h: s(56), tap: "risky-logout" },
        ];
      case "about":
        return [
          { kind: "text", text: "About GLV Shop", x: s(20), y: s(20), w: s(240), h: s(36) },
          { kind: "text", text: "GLV Shop version 1.4.0, made in India", x: s(20), y: s(70), w: Math.round((W - s(60)) * (state.fontScale > 1.2 ? 1.6 : 1)), h: s(24) },
        ];
      case "signin":
        return [
          { kind: "text", text: "Sign in", x: s(20), y: s(20), w: s(200), h: s(36) },
          { kind: "field", id: "email", hint: "Email", text: state.fields.email ?? "", x: s(20), y: s(80), w: bw, h: s(56) },
          { kind: "password", text: state.fields.password ? "•".repeat(state.fields.password.length) : "", x: s(20), y: s(150), w: bw, h: s(56) },
          { kind: "button", text: "Log in", id: "log_in", x: s(20), y: s(230), w: bw, h: s(56), tap: "login" },
        ];
    }
    return [];
  };

  const androidXml = () => {
    const els = elements();
    const node = (e: El, i: number) => {
      const cls = { text: "android.widget.TextView", button: "android.widget.Button", "image-button": "android.widget.ImageButton", field: "android.widget.EditText", password: "android.widget.EditText" }[e.kind];
      const click = e.kind !== "text";
      const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      return `<${cls} index="${i}" package="${appId}" class="${cls}" text="${esc(e.text ?? "")}" resource-id="${e.id ? `${appId}:id/${e.id}` : ""}" content-desc="${esc(e.desc ?? "")}" hint="${esc(e.hint ?? "")}" clickable="${click}" enabled="true" focused="${state.focused !== "" && state.focused === (e.id ?? e.kind)}" password="${e.kind === "password"}" scrollable="false" displayed="true" bounds="[${e.x},${e.y}][${e.x + e.w},${e.y + e.h}]" />`;
    };
    const w = win();
    const pkg = state.running ? appId : "com.android.launcher3";
    return `<?xml version="1.0" encoding="UTF-8"?><hierarchy index="0" class="hierarchy" rotation="0" width="${w.width}" height="${w.height}"><android.widget.FrameLayout index="0" package="${pkg}" class="android.widget.FrameLayout" text="" resource-id="" content-desc="" clickable="false" enabled="true" bounds="[0,0][${w.width},${w.height}]">${elements().map(node).join("")}</android.widget.FrameLayout></hierarchy>`;
    void els;
  };

  const iosXml = () => {
    const type = { text: "StaticText", button: "Button", "image-button": "Button", field: "TextField", password: "SecureTextField" };
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const w = win();
    const node = (e: El) =>
      `<XCUIElementType${type[e.kind]} type="XCUIElementType${type[e.kind]}" name="${esc(e.id ?? e.text ?? "")}" label="${esc(e.kind === "image-button" ? "" : (e.text ?? ""))}" value="${esc(e.kind === "field" || e.kind === "password" ? (e.text ?? "") : (e.text ?? ""))}" placeholderValue="${esc(e.hint ?? "")}" enabled="true" visible="true" accessible="true" x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" />`;
    return `<?xml version="1.0" encoding="UTF-8"?><AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="GLV Shop" label="GLV Shop" enabled="true" visible="true" x="0" y="0" width="${w.width}" height="${w.height}"><XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" x="0" y="0" width="${w.width}" height="${w.height}">${elements()
      .map((e) => (e.kind === "image-button" ? { ...e, id: "" } : e))
      .map(node)
      .join("")}</XCUIElementTypeWindow></XCUIElementTypeApplication></AppiumAUT>`;
  };

  const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const screenshot = () => {
    const w = win();
    const data = Buffer.alloc(w.width * w.height * 4);
    const bg = hex(state.dark ? "#121212" : "#ffffff");
    for (let i = 0; i < w.width * w.height; i++) data.set([...bg, 255], i * 4);
    const fill = (x0: number, y0: number, ww: number, hh: number, c: number[]) => {
      for (let y = Math.max(0, y0); y < Math.min(w.height, y0 + hh); y++) for (let x = Math.max(0, x0); x < Math.min(w.width, x0 + ww); x++) data.set([...c, 255], (y * w.width + x) * 4);
    };
    for (const e of elements()) {
      if (e.bg) fill(e.x, e.y, e.w, e.h, hex(e.bg));
      if (e.text) fill(e.x + Math.round(e.w * 0.05), e.y + Math.round(e.h * 0.3), Math.round(e.w * 0.5), Math.round(e.h * 0.4), hex(e.fg ?? (state.dark ? "#eeeeee" : "#111111")));
    }
    return encodePng({ width: w.width, height: w.height, data }).toString("base64");
  };

  const callThroughProxy = () => {
    if (!state.proxy) return;
    const [host, port] = state.proxy.split(":");
    if (!port || port === "0") return;
    const req = http.request({ host, port: Number(port), method: "GET", path: `http://127.0.0.1:${backendPort}/api/products?token=abc123`, headers: { host: `127.0.0.1:${backendPort}` } }, (res) => res.resume());
    req.on("error", () => {});
    req.end();
    const sock = net.connect({ host, port: Number(port) }, () => sock.write("CONNECT app-measurement.com:443 HTTP/1.1\r\nHost: app-measurement.com:443\r\n\r\n"));
    sock.on("data", () => sock.destroy());
    sock.on("error", () => {});
    setTimeout(() => sock.destroy(), 1500);
  };

  const launch = () => {
    state.running = true;
    state.screen = "home";
    state.stack = [];
    state.focused = "";
    callThroughProxy();
  };

  const doTap = (x: number, y: number) => {
    const hit = elements()
      .filter((e) => e.kind !== "text" && x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h)
      .pop();
    if (!hit) return;
    taps.push(hit.text || hit.id || hit.kind);
    if (hit.kind === "field" || hit.kind === "password") {
      state.focused = hit.id ?? hit.kind;
      return;
    }
    const go = (to: string) => {
      state.stack.push(state.screen);
      state.screen = to;
    };
    switch (hit.tap) {
      case "products":
        if (state.cameraOff) {
          crash("java.lang.SecurityException: Permission Denial: opening camera requires android.permission.CAMERA", "ProductsActivity.onCreate");
          break;
        }
        go(hit.tap);
        break;
      case "settings":
      case "about":
      case "signin":
      case "shoes":
        go(hit.tap);
        break;
      case "crash-cart":
        crash("java.lang.NullPointerException: Attempt to invoke virtual method 'int java.util.List.size()' on a null object reference", "CartActivity.onCreate");
        break;
      case "login":
        if (state.fields.email === "test@glv.in" && state.fields.password === "s3cret") {
          state.signedIn = true;
          state.screen = "home";
          state.stack = [];
        }
        break;
    }
  };

  const shell = (command: string, args: string[]): string => {
    const line = [command, ...args].join(" ");
    shellLog.push(line);
    if (line === "settings put system font_scale 1.5") state.fontScale = 1.5;
    if (line === "settings put system font_scale 1.0") state.fontScale = 1;
    if (line === "cmd uimode night yes") state.dark = true;
    if (line === "cmd uimode night no") state.dark = false;
    if (line === "svc wifi disable") state.offline = true;
    if (line === "svc wifi enable") state.offline = false;
    if (line === "wm size 1600x2560") state.tablet = true;
    if (line === "wm size reset") state.tablet = false;
    if (line.startsWith("settings put global http_proxy ")) state.proxy = args[3] === ":0" ? "" : args[3];
    if (line.startsWith("dumpsys gfxinfo") && !line.endsWith("reset")) return "Stats since: 1\nTotal frames rendered: 200\nJanky frames: 50 (25.00%)\n";
    if (line.startsWith("dumpsys meminfo")) return "** MEMINFO in pid 4242 [in.glv.demoshop] **\n TOTAL PSS:   358400            TOTAL RSS:   400000\n";
    if (line.startsWith("cmd package resolve-activity")) return `priority=0 preferredOrder=0\n${appId}/.MainActivity\n`;
    if (line.startsWith("am force-stop")) state.running = false;
    if (line === "am start -a android.settings.SETTINGS") state.foreground = "com.android.settings";
    if (line.startsWith("dumpsys package ")) return `Packages:\n  Package [${appId}]\n    runtime permissions:\n      android.permission.CAMERA: granted=true, flags=[ USER_SET ]\n      android.permission.INTERNET: granted=true\n`;
    if (line === `pm revoke ${appId} android.permission.CAMERA`) {
      state.cameraOff = true;
      state.running = false; // Android stops the app when a permission is taken away
    }
    if (line === `pm grant ${appId} android.permission.CAMERA`) state.cameraOff = false;
    if (line.startsWith("am start -W")) {
      launch();
      return "Starting: Intent { cmp=in.glv.demoshop/.MainActivity }\nStatus: ok\nLaunchState: COLD\nTotalTime: 3200\nWaitTime: 3210\nComplete\n";
    }
    return "";
  };

  const mobile = (name: string, a: Record<string, unknown>): unknown => {
    switch (name) {
      case "deviceInfo":
        return { displayDensity: 240, platformVersion: "14" };
      case "getCurrentPackage":
        return state.foreground || (state.running ? appId : "com.android.launcher3");
      case "backgroundApp":
        // The demo app does not save its screen: it comes back on Home.
        state.screen = "home";
        state.stack = [];
        return null;
      case "queryAppState":
        return state.running ? 4 : 1;
      case "terminateApp":
        state.running = false;
        return true;
      case "activateApp":
        if (state.foreground) {
          state.foreground = "";
          if (state.running) return null;
        }
        launch();
        return null;
      case "shell":
        if (!opts.shell && opts.shell !== undefined) throw Object.assign(new Error("Potentially insecure feature 'adb_shell' has not been enabled."), { wd: "unsupported operation" });
        return shell(String(a.command), (a.args as string[]) ?? []);
      case "setAppearance":
        state.dark = a.style === "dark";
        return null;
    }
    throw Object.assign(new Error(`Unknown mobile command "${name}"`), { wd: "unknown method" });
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ value }));
    };
    const fail = (error: string, message: string, status = 500) => send({ error, message }, status);
    const url = req.url ?? "";
    try {
      if (url === "/status") return send({ ready: true, message: "The server is ready", build: { version: "3.9.1" } });
      if (url === "/session" && req.method === "POST") {
        const caps = body.capabilities?.alwaysMatch ?? {};
        if (!caps["appium:app"]) return fail("session not created", "No app given");
        state.session = `s${Date.now()}`;
        state.running = caps["appium:autoLaunch"] !== false;
        return send({ sessionId: state.session, capabilities: caps });
      }
      const m = url.match(/^\/session\/([^/]+)(\/.*)?$/);
      if (!m || m[1] !== state.session) return fail("invalid session id", "No such session", 404);
      const p = m[2] ?? "";
      if (req.method === "DELETE" && p === "") {
        state.session = "";
        return send(null);
      }
      if (p === "/source") return send(platform === "android" ? androidXml() : iosXml());
      if (p === "/screenshot") return send(screenshot());
      if (p === "/window/rect") return send({ x: 0, y: 0, ...win() });
      if (p === "/actions" && req.method === "DELETE") return send(null);
      if (p === "/actions") {
        const acts = body.actions?.[0]?.actions ?? [];
        const move = acts.find((x: { type: string }) => x.type === "pointerMove");
        const moves = acts.filter((x: { type: string }) => x.type === "pointerMove");
        if (moves.length === 1 && move) doTap(move.x, move.y);
        return send(null);
      }
      if (p === "/back") {
        if (state.stack.length) state.screen = state.stack.pop()!;
        else state.running = false;
        state.focused = "";
        return send(null);
      }
      if (p === "/orientation") {
        state.landscape = body.orientation === "LANDSCAPE";
        if (state.landscape && state.running && state.screen === "products") {
          crash("java.lang.IllegalStateException: Fragment ProductsFragment not attached to a context.", "ProductsFragment.onConfigurationChanged");
        }
        return send(null);
      }
      if (p === "/element") {
        if (/focused='true'/.test(body.value) && state.focused) return send({ "element-6066-11e4-a52d-4f735466cecf": `el-${state.focused}` });
        return fail("no such element", "An element could not be located", 404);
      }
      const el = p.match(/^\/element\/el-([^/]+)\/(clear|value|click)$/);
      if (el) {
        const key = el[1] === "password" ? "password" : el[1];
        if (el[2] === "clear") state.fields[key] = "";
        if (el[2] === "value") state.fields[key] = (state.fields[key] ?? "") + String(body.text ?? "");
        return send(null);
      }
      if (p === "/execute/sync") {
        const name = String(body.script).replace(/^mobile:\s*/, "");
        try {
          return send(mobile(name, body.args?.[0] ?? {}));
        } catch (err) {
          const e = err as Error & { wd?: string };
          return fail(e.wd ?? "unknown error", e.message);
        }
      }
      if (p === "/se/log") {
        const lines = state.log.splice(0);
        if (platform === "ios") return send(lines.length ? [{ message: `{"bundleID":"${appId}"}\nException Type: EXC_CRASH (SIGABRT)\nThread 0 Crashed:\n0 GLVShop CartViewController.viewDidLoad\n\n`, timestamp: Date.now() }] : []);
        return send(lines.map((message) => ({ message, timestamp: Date.now(), level: "ALL" })));
      }
      return fail("unknown command", `Not in the stand-in: ${req.method} ${p}`, 404);
    } catch (err) {
      return fail("unknown error", (err as Error).message);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    taps,
    shell: shellLog,
    backendHits,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => backend.close(() => r()));
    },
  };
}
