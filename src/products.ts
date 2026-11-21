import { CATEGORIES, type Category, type ProductType } from "./types.js";

export interface ProductInfo {
  type: ProductType;
  name: string;
  description: string;
  /** What the tester enters to start. */
  input: "url" | "openapi" | "repo" | "apk" | "ipa";
  /** False while the engine for this product is still being built. */
  available: boolean;
  /** Short list of what gets tested, shown on the picker card. */
  tests: string[];
}

const WEB_TESTS = [
  "Broken pages and links",
  "JavaScript errors",
  "Accessibility (WCAG 2.2), keyboard and screen readers",
  "SEO",
  "Security headers, leaks and old libraries",
  "Speed, images and network",
  "Phones, 11 screen sizes, Firefox and Safari's engine",
  "Forms, search and random clicking",
];

export const PRODUCTS: ProductInfo[] = [
  {
    type: "website",
    name: "Website",
    description: "Company sites, landing pages and blogs",
    input: "url",
    available: true,
    tests: WEB_TESTS,
  },
  {
    type: "ecommerce",
    name: "Online store",
    description: "Shopify, WooCommerce and custom stores",
    input: "url",
    available: true,
    tests: ["Everything in Website", "Refund, shipping and other store policies", "Product pages: price, buy button, product data", "Checkout scripts (card skimming risk)", "Privacy and tracking"],
  },
  {
    type: "webapp",
    name: "Web app",
    description: "Portals, dashboards and booking systems",
    input: "url",
    available: true,
    tests: ["Everything in Website", "Private pages that open without a login", "Signed-in pages kept in caches", "Personal data in page addresses", "Exposed files"],
  },
  {
    type: "saas",
    name: "SaaS platform",
    description: "Multi-tenant products with sign-up and billing",
    input: "url",
    available: true,
    tests: ["Everything in Web app", "Pricing, terms, privacy and refund pages", "Logged-in testing"],
  },
  {
    type: "crm",
    name: "CRM",
    description: "Customer, lead and WhatsApp CRMs",
    input: "url",
    available: true,
    tests: ["Everything in Web app", "Logged-in testing", "No search engine (SEO) checks: a CRM is private"],
  },
  {
    type: "api",
    name: "API",
    description: "REST APIs with an OpenAPI or Swagger file",
    input: "openapi",
    available: true,
    tests: ["Every endpoint answers", "Answers match the API file", "Login required where it should be", "Data and error leaks", "Slow endpoints", "HTTPS and CORS"],
  },
  {
    type: "code",
    name: "Source code",
    description: "A Git repository or a zip, tested offline",
    input: "repo",
    available: true,
    tests: ["Leaked passwords and keys", "Packages with known holes", "SQL injection and other risky code", "Broken files and missing tests"],
  },
  {
    type: "android",
    name: "Android app",
    description: "Upload an APK or app bundle (.aab)",
    input: "apk",
    available: true,
    tests: ["Debug builds and signing", "Permissions Play restricts", "Plain HTTP and certificates", "Hard-coded keys", "Exposed components", "64-bit and 16 KB pages", "SDKs, trackers and library versions", "App links, languages and size", "Crashes and screens on a test phone"],
  },
  {
    type: "ios",
    name: "iOS app",
    description: "Upload an IPA, or a zip of the .app",
    input: "ipa",
    available: true,
    tests: ["App Transport Security and plain HTTP", "Permissions and their purpose texts", "Privacy manifest (App Store rule)", "UIWebView, 64-bit and signing", "Hard-coded keys and open Firebase", "Debug and expired builds", "SDKs, trackers and library versions", "Universal links, languages and size", "Crashes and screens on a test phone"],
  },
];

/** Score categories that apply to each kind of test (an API has no phone layout). */
export function categoriesFor(type: ProductType): Category[] {
  if (type === "api") return ["functional", "security", "performance"];
  if (type === "code" || type === "android" || type === "ios") return ["security", "functional"];
  if (type === "crm") return CATEGORIES.filter((c) => c !== "seo");
  return CATEGORIES;
}

export const productInfo = (type: ProductType): ProductInfo => PRODUCTS.find((p) => p.type === type) ?? PRODUCTS[0];

/** Products that the browser engine tests. */
export const WEB_PRODUCTS: ProductType[] = ["website", "ecommerce", "webapp", "saas", "crm"];

/**
 * Web products meant to be found on Google, so they get the search engine (SEO) checks. A CRM is a
 * private tool: only its sign-in page is public, and search advice on it is noise.
 */
export const PUBLIC_WEB_PRODUCTS: ProductType[] = ["website", "ecommerce", "webapp", "saas"];
