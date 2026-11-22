import type { AttackFinding, Family } from "./types.js";

/**
 * Business logic in online stores: GLV's own shopping cart (a fresh visitor session, never a real
 * customer's) is given a negative quantity, a fraction and a huge number, and the cart's total is
 * read back. A total below zero, a fraction of an item or a cart the store cannot sell are money
 * lost. WooCommerce and Shopify carts are recognised; nothing is ordered or paid. It changes the
 * test's own cart only, but it is a change, so it runs only when the permission allows changes.
 */

export interface CartTry {
  quantity: string;
  total: number | null;
  qtyInCart: number | null;
  accepted: boolean;
}

/** What is wrong with the carts the tries left. Pure, for tests. */
export function logicProblems(tries: CartTry[]): { rule: string; severity: "critical" | "high" | "medium"; title: string; why: string }[] {
  const out: { rule: string; severity: "critical" | "high" | "medium"; title: string; why: string }[] = [];
  const neg = tries.find((t) => Number(t.quantity) < 0 && t.accepted && ((t.total ?? 0) < 0 || (t.qtyInCart ?? 0) < 0));
  if (neg) out.push({ rule: "logic:negative-quantity", severity: "critical", title: "The cart accepts a negative quantity", why: `Quantity ${neg.quantity} gave a cart total of ${neg.total}${neg.qtyInCart !== null ? ` (${neg.qtyInCart} in the cart)` : ""}: a buyer can lower the price of the rest of the order, even below zero.` });
  const frac = tries.find((t) => t.quantity.includes(".") && t.accepted && t.qtyInCart !== null && !Number.isInteger(t.qtyInCart));
  if (frac) out.push({ rule: "logic:fraction-quantity", severity: "high", title: "The cart accepts a fraction of an item", why: `Quantity ${frac.quantity} put ${frac.qtyInCart} items in the cart, so a buyer pays part of the price for a whole item.` });
  const huge = tries.find((t) => Number(t.quantity) >= 100000 && t.accepted && (t.qtyInCart ?? 0) >= 100000);
  if (huge) out.push({ rule: "logic:no-quantity-limit", severity: "medium", title: "The cart takes any quantity", why: `Quantity ${huge.quantity} was accepted (total ${huge.total}). Stock and price limits are not checked when adding, which also lets totals overflow.` });
  return out;
}

class Jar {
  private c = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

const num = (s: unknown) => {
  const n = Number(String(s ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function shopifyTry(origin: string, variant: string, quantity: string, signal: AbortSignal): Promise<CartTry> {
  const jar = new Jar();
  const opts = (init: RequestInit = {}) => ({ ...init, headers: { "content-type": "application/json", accept: "application/json", cookie: jar.header(), ...(init.headers ?? {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  const add = await fetch(`${origin}/cart/add.js`, opts({ method: "POST", body: JSON.stringify({ id: Number(variant), quantity: Number(quantity) }) }));
  jar.take(add);
  const cart = (await (await fetch(`${origin}/cart.js`, opts())).json().catch(() => ({}))) as { total_price?: number; item_count?: number };
  await fetch(`${origin}/cart/clear.js`, opts({ method: "POST" })).catch(() => undefined);
  return { quantity, accepted: add.ok, total: cart.total_price !== undefined ? cart.total_price / 100 : null, qtyInCart: cart.item_count ?? null };
}

async function wooTry(origin: string, product: string, quantity: string, signal: AbortSignal): Promise<CartTry> {
  const jar = new Jar();
  const opts = (init: RequestInit = {}) => ({ ...init, redirect: "manual" as const, headers: { cookie: jar.header(), ...(init.headers ?? {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  const body = new URLSearchParams({ product_id: product, quantity });
  const add = await fetch(`${origin}/?wc-ajax=add_to_cart`, opts({ method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }));
  jar.take(add);
  const answer = (await add.json().catch(() => ({}))) as { error?: boolean };
  // The Store API (WooCommerce 6+) gives the cart as JSON.
  const res = await fetch(`${origin}/wp-json/wc/store/v1/cart`, opts({ headers: { accept: "application/json" } }));
  const cart = (await res.json().catch(() => ({}))) as { totals?: { total_price?: string; currency_minor_unit?: number }; items_count?: number; items?: { quantity?: number }[] };
  const minor = cart.totals?.currency_minor_unit ?? 2;
  const total = cart.totals?.total_price !== undefined ? Number(cart.totals.total_price) / 10 ** minor : null;
  const qty = cart.items?.length ? cart.items.reduce((n, i) => n + (i.quantity ?? 0), 0) : (cart.items_count ?? null);
  return { quantity, accepted: add.ok && !answer.error, total, qtyInCart: qty };
}

export const logicFamily: Family = {
  id: "logic",
  label: "Store business logic (needs changes allowed)",
  hint: "Negative, fractional and huge quantities in GLV's own fresh cart (WooCommerce, Shopify); the cart is emptied after. Runs only when the permission allows changes.",
  async run(fc): Promise<AttackFinding[]> {
    const { ctx, http, surface, log } = fc;
    if (!ctx.permit?.writes) {
      log("Store business logic: skipped, the permission does not allow changes");
      return [];
    }
    const origin = new URL(ctx.startUrl).origin;
    let shop: "shopify" | "woo" | null = null;
    let item = "";
    for (const page of surface.pages.slice(0, 15)) {
      if (http.left() < 5000) break;
      const res = await http.get(page).catch(() => null);
      if (!res) continue;
      const b = res.body;
      if (!shop && /cdn\.shopify\.com|Shopify\.theme/.test(b)) shop = "shopify";
      if (!shop && /woocommerce|wc-ajax/.test(b)) shop = "woo";
      const id = shop === "shopify" ? b.match(/name="id"\s+value="(\d{6,})"|"variants":\[\{"id":(\d{6,})/) : b.match(/data-product_id="(\d+)"|name="add-to-cart"\s+value="(\d+)"/);
      if (id) item = id[1] ?? id[2] ?? "";
      if (shop && item) break;
    }
    if (!shop || !item) {
      log("Store business logic: no WooCommerce or Shopify cart with a product found");
      return [];
    }
    const tries: CartTry[] = [];
    for (const q of ["-3", "0.5", "100000"]) {
      if (http.left() < 5000) break;
      try {
        tries.push(shop === "shopify" ? await shopifyTry(origin, item, q, ctx.signal) : await wooTry(origin, item, q, ctx.signal));
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
    }
    log(`Store business logic (${shop}): ${tries.map((t) => `qty ${t.quantity} → ${t.accepted ? `total ${t.total}` : "refused"}`).join("; ")}`);
    return logicProblems(tries).map((p) => ({
      rule: p.rule,
      severity: p.severity,
      tag: "injection" as const,
      title: p.title,
      detail: `${p.why} How to fix: on the server, accept only whole quantities from 1 to a sensible maximum (and the stock left), and recalculate the price from the product, never from what the browser sends. ${shop === "woo" ? "WooCommerce: check woocommerce_add_to_cart_validation and woocommerce_update_cart_validation filters, and plugins that change quantity input." : "Shopify: check apps and theme code that edit the cart; Shopify's own cart refuses negative quantities."}`,
      pageUrl: origin,
      evidence: tries.map((t) => `quantity ${t.quantity}: ${t.accepted ? "accepted" : "refused"}, in cart ${t.qtyInCart ?? "?"}, total ${t.total ?? "?"}`).join("\n"),
      key: `${p.rule}:${origin}`,
    }));
  },
};
