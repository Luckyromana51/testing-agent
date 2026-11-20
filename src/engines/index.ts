import { readFile } from "node:fs/promises";
import path from "node:path";
import { scanSite } from "../runner/scan.js";
import type { LiveSink } from "../live.js";
import { stat } from "node:fs/promises";
import type { ApiScenario, HookInbox, Journey, Login, ProductType, ProjectTarget, RoleLogin, RumSummary, ScanResult, SeoInput, WriteConsent } from "../types.js";
import { redact, secretsOf } from "../vault.js";
import { scanApi } from "./api.js";

export interface EngineInput {
  product: ProductType;
  target: ProjectTarget;
  /** The project's saved login, decrypted for this run only. */
  login?: Login;
  /** Agent ids to run. */
  agents?: string[];
  maxPages: number;
  /** Where screenshots and other evidence go. */
  artifactsDir: string;
  /** Where uploaded files (APK, IPA, source zip, API file) are kept. */
  uploadsDir: string;
  /** Scratch space for clones and unpacked files; removed after the run. */
  workDir: string;
  onProgress?: (message: string) => void;
  /** Aborted when the run is cancelled or the server stops. */
  signal?: AbortSignal;
  /** Web tests signed in: gets the session's Cookie header, for the outside tools. */
  onSession?: (cookie: string) => void;
  /** Web tests: how many pages to test at the same time. */
  parallel?: number;
  /** Web tests: where the live screens go. */
  live?: LiveSink;
  /** Web tests: record the inspect screen. */
  inspect?: boolean;
  /** Web tests: the project's approved pictures, for visual compare. */
  baselineDir?: string;
  /** Web tests: user journeys to follow. */
  journeys?: Journey[];
  /** Web tests: the test mailbox (Mailpit) address, when the mail module is on. */
  mailUrl?: string;
  /** Web tests: the project's other accounts (roles, another company), decrypted for this run only. */
  roles?: RoleLogin[];
  /** Web tests: the project's webhook inbox, for journeys. */
  hookInbox?: HookInbox;
  /** Web tests: click through the signed-in app's menus (on unless turned off). */
  explore?: boolean;
  system?: string;
  /** API tests: the project's scenarios. */
  apiScenarios?: ApiScenario[];
  /** API tests: the approved copy of the API file (api-spec.json), to list breaking changes. */
  apiBaselineFile?: string;
  /** Signed-in apps: whether checks that change data may run (a test copy, or the client's permission). */
  writes?: WriteConsent;
  /** Websites: the SEO audit's input. */
  seo?: SeoInput;
  /** Websites: real visitors' speed from the in-house snippet. */
  rum?: RumSummary;
}

/** The approved API file, when there is one. */
async function readBaseline(file?: string): Promise<{ spec: unknown; at: string } | undefined> {
  if (!file) return undefined;
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return { spec: JSON.parse(text), at: info.mtime.toISOString() };
  } catch {
    return undefined;
  }
}

/** Full path of an uploaded file, refusing names that try to leave the uploads folder. */
export function uploadedPath(uploadsDir: string, file: string): string {
  const name = path.basename(file);
  if (!name || name !== file) throw new Error("Bad upload name.");
  return path.join(uploadsDir, name);
}

/**
 * Picks the test engine for the product and runs it. Any secret from the login that shows up in
 * the result or in an error (a page that prints a token, for example) is replaced with [hidden].
 */
export async function runEngine(input: EngineInput): Promise<ScanResult> {
  const secrets = [...secretsOf(input.login, input.target.repoUrl), ...(input.roles ?? []).flatMap((r) => secretsOf(r.login))];
  const onProgress = input.onProgress && ((m: string) => input.onProgress!(redact(m, secrets)));
  try {
    return redact(await pickEngine({ ...input, onProgress }), secrets);
  } catch (err) {
    throw new Error(redact((err as Error).message, secrets));
  }
}

/** API tests: SOAP, gRPC, WebSocket or REST/GraphQL, and the Pact contract test when there is one. */
async function runApi(input: EngineInput): Promise<ScanResult> {
  const { target, agents, login, onProgress } = input;
  const auth = login?.kind === "api" ? login : undefined;
  const common = { auth, onProgress, signal: input.signal };
  const contract = target.contractFile
    ? async () => {
        if (!target.url) throw new Error("A contract test needs the API's address (the provider), to send the Pact requests to.");
        const { verifyPact } = await import("./pact.js");
        return verifyPact({ ...common, pactText: await readFile(uploadedPath(input.uploadsDir, target.contractFile!), "utf8"), baseUrl: target.url, testServer: target.testServer });
      }
    : undefined;
  let main: (() => Promise<ScanResult>) | undefined;
  if (target.soapUrl) main = async () => (await import("./soap.js")).scanSoap({ ...common, wsdlUrl: target.soapUrl!, testServer: target.testServer });
  else if (target.grpcUrl) main = async () => (await import("./grpc.js")).scanGrpc({ ...common, address: target.grpcUrl!, protoFile: target.protoFile ? uploadedPath(input.uploadsDir, target.protoFile) : undefined, testServer: target.testServer });
  else if (target.wsUrl) main = async () => (await import("./websocket.js")).scanWebSocket({ ...common, url: target.wsUrl!, messages: target.wsMessages });
  else if (target.specUrl || target.file || target.graphqlUrl || !contract)
    main = async () =>
      scanApi({
        specUrl: target.specUrl,
        specText: target.file ? await readFile(uploadedPath(input.uploadsDir, target.file), "utf8") : undefined,
        baseUrl: target.url,
        graphqlUrl: target.graphqlUrl,
        auth,
        roles: auth ? input.roles : undefined,
        testServer: target.testServer,
        scenarios: input.apiScenarios,
        baseline: await readBaseline(input.apiBaselineFile),
        artifactsDir: input.artifactsDir,
        agents,
        onProgress,
        signal: input.signal,
      });
  if (!main) return contract!();
  const first = await main();
  if (!contract) return first;
  onProgress?.("Running the contract test");
  const { mergeResults } = await import("./protocol.js");
  try {
    return mergeResults(first, await contract());
  } catch (err) {
    return { ...first, notes: [...(first.notes ?? []), `The contract test could not run: ${(err as Error).message}`] };
  }
}

async function pickEngine(input: EngineInput): Promise<ScanResult> {
  const { product, target, agents, login, onProgress } = input;
  switch (product) {
    case "api":
      return runApi(input);
    case "code": {
      const { scanCode } = await import("./code.js");
      return scanCode({
        repoUrl: target.repoUrl,
        branch: target.branch,
        gitLogin: login?.kind === "git" ? login : undefined,
        zipFile: target.file ? uploadedPath(input.uploadsDir, target.file) : undefined,
        workDir: input.workDir,
        agents,
        onProgress,
        signal: input.signal,
      });
    }
    case "android": {
      if (!target.file) throw new Error("Upload the APK file to test.");
      const { scanApk } = await import("./apk.js");
      return scanApk({ apkFile: uploadedPath(input.uploadsDir, target.file), fileName: target.fileName, agents, onProgress });
    }
    case "ios": {
      if (!target.file) throw new Error("Upload the iOS app (.ipa, or a zip of the .app) to test.");
      const { scanIpa } = await import("./ipa.js");
      return scanIpa({ ipaFile: uploadedPath(input.uploadsDir, target.file), fileName: target.fileName, agents, onProgress });
    }
    default:
      return scanSite({
        url: target.url ?? "",
        maxPages: input.maxPages,
        product,
        agents,
        login: login?.kind === "web" ? login : undefined,
        artifactsDir: input.artifactsDir,
        onProgress,
        signal: input.signal,
        onSession: input.onSession,
        parallel: input.parallel,
        live: input.live,
        inspect: input.inspect,
        baselineDir: input.baselineDir,
        journeys: input.journeys,
        mailUrl: input.mailUrl,
        roles: login?.kind === "web" ? input.roles : undefined,
        hookInbox: input.hookInbox,
        explore: input.explore,
        system: input.system,
        writes: input.writes,
        seo: input.seo,
        rum: input.rum,
        uploadsDir: input.uploadsDir,
      });
  }
}
