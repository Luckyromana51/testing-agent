import type { ProductType } from "./types.js";

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
    tests: ["Everything in Web app", "Opens in a real cloud browser", "Logged-in testing (next update)"],
  },
  {
    type: "crm",
    name: "CRM",
    description: "Customer, lead and WhatsApp CRMs",
    input: "url",
    available: true,
    tests: ["Everything in Web app", "Opens in a real cloud browser", "Logged-in testing (next update)"],
  },
  {
    type: "api",
    name: "API",
    description: "REST APIs with an OpenAPI or Swagger file",
    input: "openapi",
    available: false,
    tests: ["Every endpoint answers", "Auth required where it should be", "Error leaks", "Slow endpoints", "CORS"],
  },
  {
    type: "code",
    name: "Source code",
    description: "A Git repository, tested offline",
    input: "repo",
    available: false,
    tests: ["Leaked secrets", "Vulnerable packages", "Risky code", "AI fix suggestions"],
  },
  {
    type: "android",
    name: "Android app",
    description: "Upload an APK file",
    input: "apk",
    available: false,
    tests: ["Permissions", "Insecure settings", "Hard-coded secrets", "Network security"],
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

export const productInfo = (type: ProductType): ProductInfo => PRODUCTS.find((p) => p.type === type) ?? PRODUCTS[0];

/** Products that the browser engine tests. */
export const WEB_PRODUCTS: ProductType[] = ["website", "ecommerce", "webapp", "saas", "crm"];
