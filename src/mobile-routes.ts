/*
 * Routes for test phones: the owner's list of Appium devices (Owner panel > Test phones), whether each
 * answers, and the short-lived download address Appium on another machine fetches the app from.
 */
import { createReadStream, existsSync } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { cleanDevice, deviceStatus, listDevices, setDevices, sharedApp, type AppDevice } from "./mobile/devices.js";
import type { Stores } from "./store.js";

interface Deps {
  stores: Stores;
  ownerOnly: (req: FastifyRequest) => void;
  fail: (status: number, message: string) => Error;
}

const MAX_DEVICES = 20;

export function registerMobileRoutes(app: FastifyInstance, deps: Deps): void {
  const { stores, ownerOnly, fail } = deps;
  setDevices(stores.settings.get().devices);
  const saved = () => stores.settings.get().devices ?? [];
  const save = (list: AppDevice[]) => {
    stores.settings.update({ devices: list });
    setDevices(list);
  };

  app.get<{ Querystring: { check?: string } }>("/api/owner/devices", async (req) => {
    ownerOnly(req);
    const devices = listDevices();
    if (req.query.check !== "1") return { devices: devices.map((d) => ({ ...d, status: null, checked: false })) };
    const statuses = await Promise.all(devices.map((d) => deviceStatus(d, AbortSignal.timeout(8000))));
    return { devices: devices.map((d, i) => ({ ...d, status: statuses[i], checked: true })) };
  });

  app.post("/api/owner/devices", async (req, reply) => {
    ownerOnly(req);
    if (saved().length >= MAX_DEVICES) throw fail(400, `Up to ${MAX_DEVICES} devices can be added.`);
    let d: AppDevice;
    try {
      d = cleanDevice((req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      throw fail(400, (err as Error).message);
    }
    save([...saved(), d]);
    return reply.code(201).send({ device: d });
  });

  app.put<{ Params: { id: string } }>("/api/owner/devices/:id", async (req) => {
    ownerOnly(req);
    if (req.params.id === "builtin") throw fail(400, "The built-in emulator is set in the server's .env file.");
    const list = saved();
    const i = list.findIndex((d) => d.id === req.params.id);
    if (i < 0) throw fail(404, "Device not found");
    let d: AppDevice;
    try {
      d = cleanDevice((req.body ?? {}) as Record<string, unknown>, req.params.id);
    } catch (err) {
      throw fail(400, (err as Error).message);
    }
    list[i] = d;
    save(list);
    return { device: d };
  });

  app.delete<{ Params: { id: string } }>("/api/owner/devices/:id", async (req, reply) => {
    ownerOnly(req);
    const list = saved();
    if (!list.some((d) => d.id === req.params.id)) throw fail(404, "Device not found");
    save(list.filter((d) => d.id !== req.params.id));
    return reply.code(204).send();
  });

  // Appium on another machine downloads the app under test from here. The address holds a random
  // token, lives 30 minutes and is removed when the test ends, so it needs no sign-in.
  app.get<{ Params: { token: string; name: string } }>("/app-files/:token/:name", async (req, reply) => {
    const s = sharedApp(req.params.token);
    if (!s || !existsSync(s.file)) return reply.code(404).send({ error: "This app download has expired." });
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${s.name.replace(/[^\w.-]/g, "_")}"`)
      .header("cache-control", "no-store")
      .send(createReadStream(s.file));
  });
}
