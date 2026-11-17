import type { EngineAgent } from "../types.js";
import type { CodeContext } from "./context.js";
import { codeHygieneAgent } from "./hygiene.js";
import { codePackagesAgent } from "./packages.js";
import { codeRiskyAgent } from "./risky.js";
import { codeSecretsAgent } from "./secrets.js";

/** Every agent of the source code engine, in the order they run. */
export const CODE_AGENTS: EngineAgent<CodeContext>[] = [codeSecretsAgent, codePackagesAgent, codeRiskyAgent, codeHygieneAgent];
