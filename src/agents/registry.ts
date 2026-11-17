import type { ProductType } from "../types.js";
import { API_AGENTS } from "./api/index.js";
import { CODE_AGENTS } from "./code/index.js";
import { ANDROID_AGENTS } from "./mobile/android.js";
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
import { PRODUCT_AGENTS } from "./web/products.js";
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
  // Checks for one kind of product: store pages, and the private pages of web apps, SaaS and CRMs.
  ...PRODUCT_AGENTS,
];

/** All agents of every engine. */
export const ALL_AGENTS: AgentInfo[] = [...WEB_AGENTS, ...API_AGENTS, ...CODE_AGENTS, ...ANDROID_AGENTS];

/** Plain description of an agent, without its code, for the dashboard. */
export function describeAgent(a: AgentInfo): AgentInfo {
  const { id, name, description, category, engine, products, defaultOff, needsLogin } = a;
  return { id, name, description, category, engine, products, defaultOff, needsLogin };
}

/**
 * The agents that run for a product. `toggles` holds the owner's on/off choices;
 * anything not listed uses the agent's default.
 */
export function agentsFor(product: ProductType, toggles: Record<string, boolean> = {}): AgentInfo[] {
  return ALL_AGENTS.filter((a) => a.products.includes(product) && (toggles[a.id] ?? !a.defaultOff));
}
