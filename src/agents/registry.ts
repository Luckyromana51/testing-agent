import type { ProductType } from "../types.js";
import type { AgentInfo, WebAgent } from "./types.js";
import { linksAgent } from "./web/links.js";
import {
  accessibilityAgent,
  contentAgent,
  formsAgent,
  mobileAgent,
  privacyAgent,
  securityHeadersAgent,
  seoAgent,
  structuredDataAgent,
} from "./web/page.js";
import { jsErrorsAgent, mixedContentAgent, resourcesAgent } from "./web/signals.js";
import {
  crawlabilityAgent,
  duplicatesAgent,
  exposedFilesAgent,
  httpsAgent,
  soft404Agent,
  wordpressAgent,
} from "./web/site.js";
import { speedAgent } from "./web/speed.js";

/** Every specialist agent of the browser engine. Add new agents here. */
export const WEB_AGENTS: WebAgent[] = [
  jsErrorsAgent,
  resourcesAgent,
  linksAgent,
  contentAgent,
  formsAgent,
  accessibilityAgent,
  seoAgent,
  structuredDataAgent,
  duplicatesAgent,
  crawlabilityAgent,
  soft404Agent,
  securityHeadersAgent,
  httpsAgent,
  mixedContentAgent,
  exposedFilesAgent,
  wordpressAgent,
  privacyAgent,
  speedAgent,
  mobileAgent,
];

/** All agents of every engine (API, code and mobile engines add theirs here). */
export const ALL_AGENTS: AgentInfo[] = [...WEB_AGENTS];

/** Plain description of an agent, without its code, for the dashboard. */
export function describeAgent(a: AgentInfo): AgentInfo {
  const { id, name, description, category, engine, products, defaultOff } = a;
  return { id, name, description, category, engine, products, defaultOff };
}

/**
 * The agents that run for a product. `toggles` holds the owner's on/off choices;
 * anything not listed uses the agent's default.
 */
export function agentsFor(product: ProductType, toggles: Record<string, boolean> = {}): AgentInfo[] {
  return ALL_AGENTS.filter((a) => a.products.includes(product) && (toggles[a.id] ?? !a.defaultOff));
}
