import type { ProductType } from "../types.js";
import { API_AGENTS } from "./api/index.js";
import { CODE_AGENTS } from "./code/index.js";
import { ALL_ANDROID_AGENTS as ANDROID_AGENTS, ALL_IOS_AGENTS as IOS_AGENTS } from "./mobile/index.js";
import type { AgentInfo, WebAgent } from "./types.js";
import { keyboardAgent, motionAgent, screenReaderAgent, textSpacingAgent, zoomAgent } from "./web/a11y.js";
import { corsAgent, cspAgent, orphanPagesAgent, redirectChainAgent, renderedHtmlAgent } from "./web/audit.js";
import { browserLabAgent } from "./web/browsers.js";
import { HANDBOOK_WEB_AGENTS } from "./web/handbook-web.js";
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
import { exposedAgent } from "../app/exposed.js";
import { loginRedirectAgent, twoStepAgent } from "../app/signin.js";
import { csrfAgent, idNumbersAgent, sessionAgent, tokensAgent, userEnumAgent } from "../app/session.js";
import { tablesAgent } from "../app/tables.js";
import { forgotPasswordAgent, lockoutAgent, massAssignAgent, salesforceGuestAgent, uploadAgent } from "../app/changes.js";
import { formFillAgent } from "../app/forms.js";
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
import { consentGateAgent } from "./web/consent.js";
import { coverAgent, cutTextAgent, overlapAgent, overlapPhoneAgent, readabilityAgent, tabletAgent } from "./web/ui.js";
import { seoAuditAgent } from "../seo/audit.js";
import { geoAgent, securityTxtAgent } from "./web/geo.js";
import { cloakingAgent, hackedAgent } from "./web/hacked.js";
import { emailDnsAgent } from "./web/email-dns.js";
import { darkPatternsAgent, fakeTimerAgent } from "./web/dark-patterns.js";
import { dpdpAgent, dpdpFormsAgent, gigwAgent } from "./web/india.js";
import { documentsAgent } from "./web/documents.js";
import { oauthAgent } from "./web/oauth.js";
import { exifAgent } from "./web/exif.js";
import { hreflangAgent, localSeoAgent, socialPreviewAgent } from "./web/seo-more.js";
import { jsRenderAgent } from "./web/js-render.js";
import { aaaAgent, colourVisionAgent } from "./web/a11y-more.js";
import { visualLayoutAgent } from "./web/visual-layout.js";
import { frontendProfileAgent } from "./web/frontend-profile.js";
import { slowCallsAgent } from "./web/slow-calls.js";

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
  tabletAgent,
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
  consentGateAgent,
  // Speed beyond the timing numbers.
  imagesAgent,
  networkAgent,
  slowNetworkAgent,
  // Search engines across pages.
  linkGraphAgent,
  thinContentAgent,
  urlsAgent,
  seoAuditAgent,
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
  // Wave 1 of the 2026 gap report: AI search, disclosure, hacked sites, email and DNS, dark
  // patterns, the India pack (DPDP, GIGW 3.0) and documents.
  geoAgent,
  securityTxtAgent,
  hackedAgent,
  cloakingAgent,
  emailDnsAgent,
  darkPatternsAgent,
  fakeTimerAgent,
  dpdpAgent,
  dpdpFormsAgent,
  gigwAgent,
  documentsAgent,
  oauthAgent,
  exifAgent,
  // Wave 2 of the gap report: local SEO, hreflang, social previews, JS-render diff, colour-blind
  // and low-vision, WCAG AAA/cognitive, and layout breaks on phones.
  localSeoAgent,
  hreflangAgent,
  socialPreviewAgent,
  jsRenderAgent,
  colourVisionAgent,
  aaaAgent,
  visualLayoutAgent,
  frontendProfileAgent,
  // Testing handbook: back and forward, downloads, caching, cookies, navigation, spelling, reliability.
  ...HANDBOOK_WEB_AGENTS,
  // Checks for one kind of product: store pages, and the private pages of web apps, SaaS and CRMs.
  ...PRODUCT_AGENTS,
  // Signed-in apps (CRM, ERP, SaaS...): app calls, lists and tables, ID numbers, CSRF, tokens, and
  // the checks that sign in again in their own browser: who can see what, then the session.
  appCallsAgent,
  slowCallsAgent,
  exposedAgent,
  tablesAgent,
  idNumbersAgent,
  csrfAgent,
  tokensAgent,
  accessAgent,
  sessionAgent,
  userEnumAgent,
  twoStepAgent,
  loginRedirectAgent,
  // Checks that change data, with consent only (a test copy, or the client's written permission):
  // they run last, the lockout check very last.
  salesforceGuestAgent,
  forgotPasswordAgent,
  massAssignAgent,
  uploadAgent,
  formFillAgent,
  lockoutAgent,
];

/** All agents of every engine. */
export const ALL_AGENTS: AgentInfo[] = [...WEB_AGENTS, ...API_AGENTS, ...CODE_AGENTS, ...ANDROID_AGENTS, ...IOS_AGENTS];

/** Plain description of an agent, without its code, for the dashboard. */
export function describeAgent(a: AgentInfo): AgentInfo {
  const { id, name, description, category, engine, products, defaultOff, needsLogin, needsConsent } = a;
  return { id, name, description, category, engine, products, defaultOff, needsLogin, needsConsent };
}

/**
 * The agents that run for a product. `toggles` holds the owner's on/off choices;
 * anything not listed uses the agent's default.
 */
export function agentsFor(product: ProductType, toggles: Record<string, boolean> = {}): AgentInfo[] {
  return ALL_AGENTS.filter((a) => a.products.includes(product) && (toggles[a.id] ?? !a.defaultOff));
}
