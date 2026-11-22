import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, Severity } from "../../types.js";
import type { SiteAgent, SiteContext } from "../types.js";
import { isPrivateHost, registrableDomain, systemDns, type DnsLookup } from "./domain.js";
import { getText } from "./geo.js";

/**
 * Email and DNS security for any domain (not only Hostinger ones): can someone send email in the
 * client's name (SPF, DKIM, DMARC), is mail between servers protected (MTA-STS, TLS-RPT), is the
 * zone signed (DNSSEC), and who may issue its certificates (CAA). Reads public DNS only.
 */

/** DKIM selectors the big mail services and hosts use. A domain may use others; then DKIM shows as "not found", not failed. */
export const DKIM_SELECTORS = ["google", "default", "selector1", "selector2", "k1", "k2", "s1", "s2", "mail", "dkim", "smtp", "mx", "zoho", "zmail", "hostingermail1", "hostingermail2", "titan1", "mandrill", "sendgrid", "s1024", "everlytickey1", "mxvault", "protonmail", "fm1", "amazonses"];

export interface SpfFacts {
  record: string | null;
  /** How many SPF records were published (more than one is an error). */
  count: number;
  all: "+all" | "?all" | "~all" | "-all" | null;
  lookups: number;
  includes: string[];
}

export function readSpf(txt: string[]): SpfFacts {
  const spf = txt.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  const record = spf[0] ?? null;
  const terms = record ? record.trim().split(/\s+/).slice(1) : [];
  const allTerm = terms.find((t) => /^[+?~-]?all$/i.test(t));
  const all = allTerm ? ((/^[+?~-]/.test(allTerm) ? allTerm : `+${allTerm}`).toLowerCase() as SpfFacts["all"]) : null;
  const lookups = terms.filter((t) => /^[+?~-]?(include:|a\b|a:|a\/|mx\b|mx:|mx\/|ptr|exists:|redirect=)/i.test(t)).length;
  return { record, count: spf.length, all, lookups, includes: terms.filter((t) => /^[+?~-]?include:/i.test(t)).map((t) => t.replace(/^[+?~-]?include:/i, "")) };
}

export interface DmarcFacts {
  record: string | null;
  policy: string | null;
  subdomainPolicy: string | null;
  pct: number;
  rua: string[];
}

export function readDmarc(txt: string[]): DmarcFacts {
  const record = txt.find((t) => /^v=DMARC1\s*;/i.test(t.trim())) ?? null;
  const tags = new Map<string, string>();
  for (const part of (record ?? "").split(";")) {
    const m = part.trim().match(/^(\w+)\s*=\s*(.*)$/);
    if (m) tags.set(m[1].toLowerCase(), m[2].trim());
  }
  return {
    record,
    policy: tags.get("p")?.toLowerCase() ?? null,
    subdomainPolicy: tags.get("sp")?.toLowerCase() ?? null,
    pct: tags.has("pct") ? Number(tags.get("pct")) : 100,
    rua: (tags.get("rua") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export interface MailFinding {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence?: string;
}

/** Everything the DNS checks found for one domain. Pure once the lookups are done, so it can be tested. */
export async function mailDnsFindings(domain: string, d: DnsLookup, fetchPolicy?: (url: string) => Promise<string | null>): Promise<{ findings: MailFinding[]; checked: string[] }> {
  const out: MailFinding[] = [];
  const checked: string[] = [];
  const add = (rule: string, severity: Severity, title: string, detail: string, evidence?: string) => out.push({ rule, severity, title, detail, evidence });

  const [rootTxt, mx, dmarcTxt, caa, ds, stsTxt, rptTxt, bimiTxt] = await Promise.all([
    d.txt(domain),
    d.mx(domain),
    d.txt(`_dmarc.${domain}`),
    d.caa(domain),
    d.ds(domain).catch(() => null),
    d.txt(`_mta-sts.${domain}`),
    d.txt(`_smtp._tls.${domain}`),
    d.txt(`default._bimi.${domain}`),
  ]);
  const sendsMail = mx.length > 0 && !(mx.length === 1 && (mx[0].exchange === "" || mx[0].exchange === "."));
  checked.push(`MX: ${sendsMail ? mx.map((m) => m.exchange).join(", ") : "none (no email at this domain)"}`);

  // SPF
  const spf = readSpf(rootTxt);
  checked.push(`SPF: ${spf.record ?? "none"}`);
  if (!spf.record) {
    if (sendsMail) add("dns:no-spf", "high", "No SPF record: anyone can send email as this domain", `There is no "v=spf1" TXT record on ${domain}, so receiving servers cannot tell real email from forged. Add one listing the services that send your mail, ending in -all or ~all.`);
    else add("dns:no-spf-parked", "medium", "No SPF record on a domain that sends no email", `${domain} receives no email, so publish "v=spf1 -all" to tell the world it never sends any. Without it, spammers can use the name.`);
  } else {
    if (spf.count > 1) add("dns:spf-multiple", "high", "More than one SPF record", "Publishing two v=spf1 records makes SPF fail for every email (RFC 7208). Merge them into one.", rootTxt.filter((t) => /^v=spf1/i.test(t)).join("\n"));
    if (spf.all === "+all") add("dns:spf-pass-all", "critical", "SPF allows every server in the world (+all)", "\"+all\" means any server may send email as this domain: SPF gives no protection at all. Change it to -all (or ~all while testing).", spf.record);
    else if (spf.all === "?all" || spf.all === null) add("dns:spf-neutral", "medium", "SPF does not say what to do with other senders", "The record ends without -all or ~all (or with ?all), so forged email is not rejected. End it with -all once all real senders are listed.", spf.record);
    if (spf.lookups > 10) add("dns:spf-too-many-lookups", "high", `SPF needs ${spf.lookups} DNS lookups (the limit is 10)`, "Over 10 include, a, mx, ptr or exists terms makes SPF fail with a permanent error, so real email can land in spam. Remove unused services or flatten includes.", spf.record);
    else if (spf.lookups >= 8) add("dns:spf-near-limit", "low", `SPF is near the 10-lookup limit (${spf.lookups})`, "Each included service can add lookups of its own; adding one more sender can tip it over. Count the nested includes too.", spf.record);
  }

  // DMARC
  const dmarc = readDmarc(dmarcTxt);
  checked.push(`DMARC: ${dmarc.record ?? "none"}`);
  if (!dmarc.record) {
    add("dns:no-dmarc", sendsMail ? "high" : "medium", "No DMARC record: fake emails in this name are not stopped", `There is no TXT record at _dmarc.${domain}. Gmail and Yahoo require DMARC for bulk senders since 2024, and without it phishing email that uses this domain is delivered. Start with "v=DMARC1; p=none; rua=mailto:dmarc@${domain}", read the reports, then move to quarantine and reject.`);
  } else {
    if (dmarc.policy === "none") add("dns:dmarc-none", "medium", "DMARC only watches (p=none)", "p=none reports forged email but still delivers it. Once the reports show only your real senders, change to p=quarantine and then p=reject.", dmarc.record);
    else if (!dmarc.policy || !["quarantine", "reject"].includes(dmarc.policy)) add("dns:dmarc-invalid", "high", "DMARC record has no valid policy", "The record needs a p= tag of none, quarantine or reject right after v=DMARC1.", dmarc.record);
    if (dmarc.pct < 100 && dmarc.policy !== "none") add("dns:dmarc-partial", "low", `DMARC applies to only ${dmarc.pct}% of email`, "pct below 100 lets the rest of the forged email through. Raise it to 100 when you are confident.", dmarc.record);
    if (!dmarc.rua.length) add("dns:dmarc-no-reports", "low", "DMARC asks for no reports", "Without rua=mailto:…, you never learn who sends email in your name. Add an address for the daily reports.", dmarc.record);
    if (dmarc.subdomainPolicy === "none" && dmarc.policy !== "none") add("dns:dmarc-subdomains-open", "medium", "Subdomains are left out of DMARC (sp=none)", "Attackers can send as anything.yourdomain while the main domain is protected. Remove sp=none or set it to reject.", dmarc.record);
  }

  // DKIM: try the common selectors.
  if (sendsMail) {
    const found: string[] = [];
    await Promise.all(
      DKIM_SELECTORS.map(async (sel) => {
        const txt = await d.txt(`${sel}._domainkey.${domain}`).catch(() => []);
        const rec = txt.find((t) => /v=DKIM1|k=rsa|p=/i.test(t));
        if (!rec) return;
        found.push(sel);
        const key = rec.match(/p=([A-Za-z0-9+/=]*)/)?.[1] ?? "";
        if (!key) add("dns:dkim-revoked", "info", `DKIM key "${sel}" is empty (revoked)`, "An empty p= means this key was withdrawn on purpose. Remove the record if it is no longer needed.", rec.slice(0, 200));
        else if (key.length < 300 && /k=rsa|^v=DKIM1/i.test(rec) && !/k=ed25519/i.test(rec)) add("dns:dkim-weak", "medium", `DKIM key "${sel}" is 1024-bit or shorter`, "Short RSA keys can be broken; use a 2048-bit key (rotate it at your mail provider and publish the new record).", `${sel}._domainkey: key of ${key.length} characters`);
      }),
    );
    checked.push(`DKIM: ${found.length ? `found for ${found.sort().join(", ")}` : "no common selector found"}`);
    if (!found.length) add("dns:dkim-not-found", "low", "No DKIM key found on the usual selectors", `None of the ${DKIM_SELECTORS.length} common DKIM selectors (google, selector1, default, k1, hostingermail1…) has a key. If your mail service signs with another selector this is fine; otherwise turn on DKIM signing at your mail provider, because DMARC needs SPF or DKIM to pass.`);
  }

  // MTA-STS and TLS-RPT: mail between servers must use encryption.
  if (sendsMail) {
    const sts = stsTxt.find((t) => /^v=STSv1/i.test(t));
    checked.push(`MTA-STS: ${sts ?? "none"}`);
    if (!sts) add("dns:no-mta-sts", "low", "No MTA-STS: incoming email can be downgraded to plain text", `Without MTA-STS, an attacker on the path can strip the encryption from email sent to ${domain}. Publish _mta-sts.${domain} and a policy file at https://mta-sts.${domain}/.well-known/mta-sts.txt.`);
    else if (fetchPolicy) {
      const policy = await fetchPolicy(`https://mta-sts.${domain}/.well-known/mta-sts.txt`);
      if (!policy || !/version:\s*STSv1/i.test(policy)) add("dns:mta-sts-policy-missing", "medium", "MTA-STS is announced but its policy file is missing", `The TXT record exists, but https://mta-sts.${domain}/.well-known/mta-sts.txt does not answer with a valid policy, so senders ignore it.`);
      else if (/mode:\s*testing/i.test(policy)) add("dns:mta-sts-testing", "low", "MTA-STS is only in testing mode", "mode: testing reports problems but does not protect email. Switch to mode: enforce once TLS-RPT reports are clean.", policy.slice(0, 200));
    }
    if (!rptTxt.some((t) => /^v=TLSRPTv1/i.test(t))) add("dns:no-tls-rpt", "info", "No TLS-RPT reports", `A TXT record at _smtp._tls.${domain} ("v=TLSRPTv1; rua=mailto:…") sends you reports when other servers cannot deliver email securely.`);
  }
  if (dmarc.policy && ["quarantine", "reject"].includes(dmarc.policy) && !bimiTxt.some((t) => /^v=BIMI1/i.test(t))) {
    add("dns:no-bimi", "info", "No BIMI logo record", "With DMARC enforced you can publish BIMI (default._bimi) so Gmail and Yahoo show your logo next to your emails.");
  }

  // DNSSEC and CAA
  checked.push(`DNSSEC: ${ds === null ? "could not be checked" : ds > 0 ? "signed" : "not signed"}`);
  if (ds === 0) add("dns:no-dnssec", "low", "The domain is not signed with DNSSEC", "Without DNSSEC, DNS answers for the domain can be forged on the way (cache poisoning). Turn it on at the registrar (most, including Hostinger and Cloudflare, do it in one click).");
  const issue = caa.filter((c) => c.tag === "issue" || c.tag === "issuewild");
  checked.push(`CAA: ${issue.length ? issue.map((c) => `${c.tag} ${c.value}`).join(", ") : "none"}`);
  if (!issue.length) add("dns:no-caa", "low", "No CAA record: any certificate authority may issue certificates", `A CAA record limits who can issue HTTPS certificates for ${domain} (for example 0 issue "letsencrypt.org"). It makes a wrongly issued certificate much harder.`);
  return { findings: out, checked };
}

async function emailDnsSiteFindings({ origin, browser, log }: SiteContext, lookup: DnsLookup = systemDns()): Promise<Finding[]> {
  const host = new URL(origin).hostname;
  if (isPrivateHost(host)) {
    log("Email and DNS security: the site is on a private address, so there is no public DNS to check");
    return [];
  }
  const domain = registrableDomain(host);
  let res;
  try {
    res = await mailDnsFindings(domain, lookup, async (url) => (await getText(browser.request, url))?.text ?? null);
  } catch (err) {
    throw new Error(`DNS could not be read for ${domain}: ${(err as Error).message}`);
  }
  log(`Email and DNS security for ${domain}: ${res.checked.join("; ")}`);
  return res.findings.map((f) => finding({ category: "security", rule: f.rule, severity: f.severity, title: `${f.title} (${domain})`, detail: f.detail, pageUrl: `https://${domain}/`, evidence: f.evidence }));
}

export const emailDnsAgent: SiteAgent = {
  id: "sec.email-dns",
  name: "Email and DNS security",
  description:
    "For any domain (not only Hostinger): SPF, DKIM, DMARC (can someone send email in your name?), MTA-STS and TLS-RPT (is mail between servers encrypted?), BIMI, DNSSEC and CAA. Public DNS only.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run: (ctx) => emailDnsSiteFindings(ctx),
};
