import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Payment gateway test flows for Razorpay, PayU, Stripe, PayPal and UPI: using the client's TEST-mode
 * keys (from .env, CONN_ names), GLV checks the keys really are test keys, confirms the gateway is
 * reachable, and for Stripe and Razorpay runs the standard flows — a test payment, a failing card,
 * and a refund — in the gateway's sandbox, which handles no real money. It refuses live keys. For PayU,
 * PayPal and UPI it lists the sandbox test cards and VPAs to use. Started by hand only.
 */

export type Gateway = "stripe" | "razorpay" | "payu" | "paypal" | "upi" | "unknown";

/** Recognises the gateway (and whether it is a test key) from a key. Pure, for tests. */
export function gatewayOf(key: string): { gateway: Gateway; test: boolean } {
  if (/^sk_test_|^pk_test_|^rk_test_/.test(key)) return { gateway: "stripe", test: true };
  if (/^sk_live_|^pk_live_|^rk_live_/.test(key)) return { gateway: "stripe", test: false };
  if (/^rzp_test_/.test(key)) return { gateway: "razorpay", test: true };
  if (/^rzp_live_/.test(key)) return { gateway: "razorpay", test: false };
  if (/paypal|^A[\w-]{20,}$/i.test(key)) return { gateway: "paypal", test: key.includes("test") };
  if (/payu/i.test(key)) return { gateway: "payu", test: key.includes("test") };
  return { gateway: "unknown", test: false };
}

/** Standard sandbox test values for each gateway. Pure, for tests. */
export const TEST_VALUES: Record<Gateway, { success: string; failure: string; note: string }> = {
  stripe: { success: "4242 4242 4242 4242 (any future expiry, any CVC)", failure: "4000 0000 0000 0002 (card declined)", note: "Use 4000 0025 0000 3155 to test 3-D Secure." },
  razorpay: { success: "card 4111 1111 1111 1111; UPI success@razorpay", failure: "UPI failure@razorpay", note: "Netbanking test: pick any bank and click success/failure on the test page." },
  payu: { success: "card 5123 4567 8901 2346 (Mastercard test)", failure: "use an expired date to force failure", note: "PayU test merchant key/salt differ from live; confirm the test SURL/FURL." },
  paypal: { success: "a sandbox buyer account from developer.paypal.com", failure: "use a sandbox account with insufficient funds", note: "Sandbox and live use different client ids; never the live id in tests." },
  upi: { success: "success@razorpay / test VPA that auto-approves", failure: "failure@razorpay", note: "For UPI collect, the sandbox auto-approves or auto-rejects by the VPA name." },
  unknown: { success: "", failure: "", note: "" },
};

async function stripeFlow(key: string, signal: AbortSignal, log: (m: string) => void): Promise<string[]> {
  const notes: string[] = [];
  const h = { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" };
  const opts = (body: string) => ({ method: "POST", headers: h, body, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  try {
    const pi = (await (await fetch("https://api.stripe.com/v1/payment_intents", opts("amount=5000&currency=inr&payment_method=pm_card_visa&confirm=true&automatic_payment_methods[enabled]=true&automatic_payment_methods[allow_redirects]=never"))).json()) as { id?: string; status?: string; error?: { message?: string } };
    if (pi.error) return [`Test payment call failed: ${pi.error.message}`];
    notes.push(`Test payment ${pi.id}: ${pi.status}`);
    log(`Stripe test payment ${pi.status}`);
    const decline = (await (await fetch("https://api.stripe.com/v1/payment_intents", opts("amount=5000&currency=inr&payment_method=pm_card_chargeDeclined&confirm=true&automatic_payment_methods[enabled]=true&automatic_payment_methods[allow_redirects]=never"))).json()) as { status?: string; last_payment_error?: { code?: string }; error?: { code?: string } };
    notes.push(`Declined card: ${decline.last_payment_error?.code ?? decline.error?.code ?? decline.status ?? "handled"}`);
    if (pi.id && pi.status === "succeeded") {
      const refund = (await (await fetch("https://api.stripe.com/v1/refunds", opts(`payment_intent=${pi.id}`))).json()) as { status?: string; error?: { message?: string } };
      notes.push(`Refund: ${refund.status ?? refund.error?.message ?? "requested"}`);
    }
  } catch (e) {
    notes.push(`Could not reach Stripe test API: ${(e as Error).message}`);
  }
  return notes;
}

async function razorpayFlow(keyId: string, secret: string, signal: AbortSignal, log: (m: string) => void): Promise<string[]> {
  const notes: string[] = [];
  const auth = `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`;
  const opts = (body: unknown) => ({ method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  try {
    const order = (await (await fetch("https://api.razorpay.com/v1/orders", opts({ amount: 5000, currency: "INR", receipt: "glv-test" }))).json()) as { id?: string; status?: string; error?: { description?: string } };
    if (order.error) return [`Order create failed: ${order.error.description}`];
    notes.push(`Test order ${order.id}: ${order.status}`);
    log(`Razorpay test order ${order.status}`);
    notes.push("Capture and refund need a payment id from the checkout; use card 4111 1111 1111 1111 or UPI success@razorpay on the test checkout.");
  } catch (e) {
    notes.push(`Could not reach Razorpay test API: ${(e as Error).message}`);
  }
  return notes;
}

export const paymentsTool: Tool = {
  id: "payments",
  name: "Payment gateway test flows",
  maker: "GLV Infotech (built in)",
  description:
    "Using the client's TEST-mode payment keys (from .env), checks the keys are test keys, confirms the gateway is reachable, and for Stripe and Razorpay runs a sandbox payment, a declined card and a refund. For PayU, PayPal and UPI it lists the sandbox test cards and VPAs. No real money moves; live keys are refused.",
  checks: ["Keys are test/sandbox, never live", "A sandbox payment, a declined card and a refund (Stripe, Razorpay)", "Sandbox test cards and UPI VPAs for each gateway", "Started by hand only"],
  products: ["ecommerce", "webapp", "saas", "api"],
  category: "functional",
  safety: "safe",
  takes: "1 to 3 minutes",
  licence: "GLV's own",
  homepage: "https://razorpay.com/docs/payments/payments/test-card-details/",
  signedIn: "public",
  manual: true,
  options: [
    { id: "keyEnv", label: "Test key name in .env", kind: "text", required: true, pattern: "^CONN_[A-Z0-9_]{2,60}$", placeholder: "CONN_ACME_STRIPE", hint: "The key's .env name. Razorpay also needs CONN_…_SECRET (the key secret).", choices: [], default: "" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const envName = ctx.options.keyEnv ?? "";
    const key = process.env[envName] ?? "";
    if (!key) throw new Error(`${envName} is not in .env. Add the gateway's TEST key and run again.`);
    const { gateway, test } = gatewayOf(key);
    const findings: ToolFinding[] = [];
    if (!test || gateway === "unknown") {
      findings.push({
        category: "security",
        rule: "payments:live-key",
        severity: "critical",
        title: gateway === "unknown" ? "The key is not a recognised test key" : "A LIVE payment key was given",
        detail: "Payment tests must use the gateway's test/sandbox keys only, so no real money moves and no real customer is charged. Replace this with the test key (Stripe sk_test_…, Razorpay rzp_test_…) before testing.",
        pageUrl: "payments",
        key: "payments:live-key",
      });
      return { findings, summary: ["Refused: not a test key."], tested: "payment key check" };
    }
    ctx.log(`Payments: ${gateway} test key`);
    let notes: string[] = [];
    if (gateway === "stripe") notes = await stripeFlow(key, ctx.signal, ctx.log);
    else if (gateway === "razorpay") {
      const secret = process.env[`${envName}_SECRET`] ?? "";
      notes = secret ? await razorpayFlow(key, secret, ctx.signal, ctx.log) : ["Add CONN_…_SECRET (the Razorpay key secret) to run order/refund flows."];
    } else notes = ["No automated sandbox run for this gateway yet; use the test values below on the checkout."];
    const tv = TEST_VALUES[gateway];
    return {
      findings,
      summary: [`${gateway} (test mode). ${notes.join(" ")}`, `Success: ${tv.success}. Failure: ${tv.failure}. ${tv.note}`],
      tested: `${gateway} sandbox`,
      table: { title: "Sandbox test values", columns: ["Result", "Use"], rows: [["Success", tv.success], ["Failure", tv.failure], ["Note", tv.note]] },
    };
  },
};
