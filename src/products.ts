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

const WEB_TESTS = ["Broken pages and links", "JavaScript errors", "Accessibility (WCAG 2.2)", "SEO", "Security headers", "Speed", "Phone layout"];

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
    tests: ["Everything in Website", "Product structured data", "Privacy and tracking", "Forms"],
  },
  {
    type: "webapp",
    name: "Web app",
    description: "Portals, dashboards and booking systems",
    input: "url",
    available: true,
    tests: ["Everything in Website", "Forms", "Exposed files", "Client errors"],
  },
  {
    type: "saas",
    name: "SaaS platform",
    description: "Multi-tenant products with sign-up and billing",
    input: "url",
    available: true,
    tests: ["Everything in Web app", "Opens in a real cloud browser", "Logged-in testing"],
  },
  {
    type: "crm",
    name: "CRM",
    description: "Customer, lead and WhatsApp CRMs",
    input: "url",
    available: true,
    tests: ["Everything in Web app", "Opens in a real cloud browser", "Logged-in testing"],
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
    description: "Upload an APK file",
    input: "apk",
    available: true,
    tests: ["Debug builds and signing", "Permissions Play restricts", "Plain HTTP and certificates", "Hard-coded keys", "Exposed components", "64-bit and 16 KB pages"],
  },
  {
    type: "ios",
    name: "iOS app",
    description: "Upload an IPA file (needs a Mac runner)",
    input: "ipa",
    available: false,
    tests: ["Permissions", "App Transport Security", "Hard-coded secrets"],
  },
];

/** Score categories that apply to each kind of test (an API has no phone layout). */
export function categoriesFor(type: ProductType): Category[] {
  if (type === "api") return ["functional", "security", "performance"];
  if (type === "code" || type === "android" || type === "ios") return ["security", "functional"];
  return CATEGORIES;
}

export const productInfo = (type: ProductType): ProductInfo => PRODUCTS.find((p) => p.type === type) ?? PRODUCTS[0];

/** Products that the browser engine tests. */
export const WEB_PRODUCTS: ProductType[] = ["website", "ecommerce", "webapp", "saas", "crm"];
