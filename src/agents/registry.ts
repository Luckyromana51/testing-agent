import type { ProductType } from "../types.js";
import { API_AGENTS } from "./api/index.js";
import { CODE_AGENTS } from "./code/index.js";
import { ANDROID_AGENTS } from "./mobile/android.js";
import { IOS_AGENTS } from "./mobile/ios.js";
import type { AgentInfo, WebAgent } from "./types.js";
import { keyboardAgent, motionAgent, screenReaderAgent, textSpacingAgent, zoomAgent } from "./web/a11y.js";
import { corsAgent, cspAgent, orphanPagesAgent, redirectChainAgent, renderedHtmlAgent } from "./web/audit.js";
import { browserLabAgent } from "./web/browsers.js";
import { anchorsAgent, devicesAgent, formFieldsAgent, monkeyAgent, notFoundPageAgent, searchAgent } from "./web/interact.js";
import { authFormsAgent, infoLeakAgent, jsLibrariesAgent, sriAgent } from "./web/leaks.js";
import { linksAgent } from "./web/links.js";
import { formatsAgent, languageAgent, otherLocaleAgent } from "./web/locale.js";
import { imagesAgent, networkAgent, slowNetworkAgent } from "./web/network.js";
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
import { accessAgent } from "../app/access.js";
import { appCallsAgent } from "../app/calls.js";
import { csrfAgent, idNumbersAgent, sessionAgent, tokensAgent, userEnumAgent } from "../app/session.js";
import { tablesAgent } from "../app/tables.js";
import { appInstallAgent } from "./web/pwa.js";
import { linkGraphAgent, thinContentAgent, urlsAgent } from "./web/seo-site.js";
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
import { coverAgent, cutTextAgent, overlapAgent, overlapPhoneAgent, readabilityAgent } from "./web/ui.js";

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
  // Keyboard, zoom, screen readers and motion.
  keyboardAgent,
  zoomAgent,
  textSpacingAgent,
  screenReaderAgent,
  motionAgent,
  readabilityAgent,
  // Using the site: form limits, random clicking, screen sizes, other browsers, search.
  formFieldsAgent,
  monkeyAgent,
  devicesAgent,
  browserLabAgent,
  anchorsAgent,
  searchAgent,
  notFoundPageAgent,
  // Layout as drawn.
  overlapAgent,
  overlapPhoneAgent,
  cutTextAgent,
  coverAgent,
  // Speed beyond the timing numbers.
  imagesAgent,
  networkAgent,
  slowNetworkAgent,
  // Search engines across pages.
  linkGraphAgent,
  thinContentAgent,
  urlsAgent,
  // Security, passive: only what every visitor already gets.
  infoLeakAgent,
  jsLibrariesAgent,
  sriAgent,
  authFormsAgent,
  // Language and region.
  languageAgent,
  formatsAgent,
  otherLocaleAgent,
  appInstallAgent,
  // Site audit: redirect chains, JavaScript-only content, orphan pages, CORS and CSP strength.
  redirectChainAgent,
  renderedHtmlAgent,
  orphanPagesAgent,
  corsAgent,
  cspAgent,
  // Checks for one kind of product: store pages, and the private pages of web apps, SaaS and CRMs.
  ...PRODUCT_AGENTS,
  // Signed-in apps (CRM, ERP, SaaS...): app calls, lists and tables, ID numbers, CSRF, tokens, and
  // the checks that sign in again in their own browser: who can see what, then the session.
  appCallsAgent,
  tablesAgent,
  idNumbersAgent,
  csrfAgent,
  tokensAgent,
  accessAgent,
  sessionAgent,
  userEnumAgent,
];

/** All agents of every engine. */
export const ALL_AGENTS: AgentInfo[] = [...WEB_AGENTS, ...API_AGENTS, ...CODE_AGENTS, ...ANDROID_AGENTS, ...IOS_AGENTS];

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
