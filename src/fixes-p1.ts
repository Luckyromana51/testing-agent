import type { Fix } from "./fixes.js";

/**
 * Written fixes for the checks added in wave 1 of the 2026 gap report: AI chatbots, hacked sites,
 * DNS and email, the attack surface, blind holes, documents, GEO, India (DPDP, GIGW), dark patterns,
 * mobile runtime, the browser matrix, record-and-replay and mutation testing.
 */
export const P1_FIXES: Record<string, Fix> = {
  // security.txt (RFC 9116)
  "sec:no-security-txt": { steps: "Publish /.well-known/security.txt so researchers know where to report a hole. Contact and Expires are required; renew Expires every year.", code: [{ label: "/.well-known/security.txt", snippet: "Contact: mailto:security@example.com\nExpires: 2027-11-30T00:00:00Z\nPreferred-Languages: en, hi\nPolicy: https://example.com/security-policy\nCanonical: https://example.com/.well-known/security.txt" }], effort: "minutes" },
  "sec:security-txt-no-contact": { steps: "Add a Contact line (mailto: or https:) to security.txt.", code: [{ label: "security.txt", snippet: "Contact: mailto:security@example.com" }], effort: "minutes" },
  "sec:security-txt-bad-contact": { steps: "Write Contact as a full mailto:, https: or tel: address.", effort: "minutes" },
  "sec:security-txt-no-expires": { steps: "Add an Expires line with a date less than a year away, in ISO 8601 format.", code: [{ label: "security.txt", snippet: "Expires: 2027-11-30T00:00:00Z" }], effort: "minutes" },
  "sec:security-txt-bad-expires": { steps: "Write Expires as an ISO 8601 date and time, e.g. 2027-11-30T00:00:00Z.", effort: "minutes" },
  "sec:security-txt-expired": { steps: "The file has expired, so reporters will not trust it: set Expires to a date within the next year, and put a yearly reminder to renew it.", effort: "minutes" },
  "sec:security-txt-far-expires": { steps: "Set Expires to less than a year away, so the file is reviewed every year.", effort: "minutes" },
  "sec:security-txt-legacy": { steps: "Move the file from /security.txt to /.well-known/security.txt (keep a redirect from the old place).", effort: "minutes" },
  "sec:security-txt-not-https": { steps: "Serve security.txt over HTTPS only.", effort: "minutes" },
  "sec:security-txt-type": { steps: "Serve security.txt as text/plain; charset=utf-8.", code: [{ label: "Apache / LiteSpeed (.htaccess)", snippet: '<Files "security.txt">\n  ForceType "text/plain; charset=utf-8"\n</Files>' }], effort: "minutes" },
  "sec:security-txt-no-policy": { steps: "Add a Policy line pointing to a page that says what may be tested and how reports are handled.", effort: "minutes" },

  // GEO and AI search
  "geo:ai-search-blocked": { steps: "robots.txt blocks the bots AI search answers come from, so the site cannot be quoted or linked in ChatGPT search, Perplexity or Google AI answers. Allow the search bots (you can still block training bots).", code: [{ label: "robots.txt", snippet: "User-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: Claude-SearchBot\nAllow: /\n\n# Training only: block if you prefer\nUser-agent: GPTBot\nDisallow: /" }], effort: "minutes" },
  "geo:ai-training-blocked": { steps: "This is a choice, not a fault: training bots are blocked. Keep it if the content should not train AI models; the search bots above still work.", effort: "minutes" },
  "geo:ai-bot-firewall": { steps: "The firewall or CDN refuses AI bots even though robots.txt allows them. In Cloudflare, Security > Bots > turn off 'Block AI bots' for the search bots, or add a WAF skip rule for their verified user agents.", effort: "minutes" },
  "geo:no-llms-txt": { steps: "Add /llms.txt: a short Markdown summary of the site with links to its key pages, which AI assistants read.", code: [{ label: "/llms.txt", snippet: "# GLV Infotech\n\n> Web, CRM and mobile app development in India.\n\n## Services\n- [Web development](https://example.com/services/web): websites and web apps\n- [Pricing](https://example.com/pricing)\n\n## Contact\n- [Contact us](https://example.com/contact)" }], effort: "minutes" },
  "geo:llms-txt-format": { steps: "Start llms.txt with one '# Site name' heading, then a '> summary' line, then '## Section' lists of [links](url).", effort: "minutes" },
  "geo:no-organization-schema": { steps: "Add Organization (or LocalBusiness) JSON-LD to the home page so AI answers know who runs the site.", code: [{ label: "HTML <head>", snippet: '<script type="application/ld+json">\n{"@context":"https://schema.org","@type":"Organization","name":"GLV Infotech","url":"https://example.com","logo":"https://example.com/logo.png","sameAs":["https://www.linkedin.com/company/example"]}\n</script>' }], effort: "minutes" },
  "geo:no-same-as": { steps: "List the organisation's official profiles (LinkedIn, X, YouTube, Wikipedia) in the Organization markup's sameAs, so AI tools tie them together.", effort: "minutes" },
  "geo:no-author": { steps: "Show a named author with a short bio on articles, and add author to the Article markup.", code: [{ label: "JSON-LD", snippet: '"author": {"@type": "Person", "name": "Asha Rao", "url": "https://example.com/team/asha"}' }], effort: "minutes" },
  "geo:no-dates": { steps: "Show when the page was published and last updated, and add datePublished and dateModified to its markup. AI answers prefer fresh, dated sources.", effort: "minutes" },
  "geo:no-answer-headings": { steps: "Use question headings (What is…? How much does…?) followed by a direct two or three sentence answer, so AI search can quote the page.", effort: "hours" },

  // Hacked site, malware, SEO spam
  "hack:hidden-spam-links": { steps: "The site has been hacked: hidden casino, pharma or loan links were injected. Find the injected code (theme footer, functions.php, database wp_options and wp_posts), remove it, change every password (hosting, FTP, database, admin), update all plugins, then ask Google to review in Search Console > Security issues.", code: [{ label: "Shell (on the server)", snippet: "grep -rniE 'casino|viagra|slot gacor|payday' --include='*.php' --include='*.js' /path/to/site | head\nwp db query \"SELECT option_name FROM wp_options WHERE option_value LIKE '%display:none%<a %'\"" }], effort: "hours" },
  "hack:hidden-links": { steps: "Check who added these hidden links and why; remove them unless they are a real, intended feature (hidden links can get the site penalised).", effort: "minutes" },
  "hack:spam-text": { steps: "Spam text was injected into the page: treat the site as hacked. Restore the affected files from a clean backup, remove unknown admin users, update everything and change all passwords.", effort: "hours" },
  "hack:hidden-iframe": { steps: "Remove the invisible iframe and find what added it (a theme file, a plugin, or a database field). A hidden iframe to another site is a classic drive-by malware sign.", effort: "hours" },
  "hack:suspicious-script": { steps: "Read this script: it decodes and runs hidden code. If nobody on the team wrote it, the site is hacked: remove it, find the entry point, and change all passwords.", effort: "hours" },
  "hack:skimmer": { steps: "A card skimmer reads the payment form and sends it elsewhere. Take checkout offline, remove the script, restore from a clean backup, inform the payment provider, and add a Content-Security-Policy that limits where scripts can send data.", code: [{ label: "Header", snippet: "Content-Security-Policy: script-src 'self' https://checkout.razorpay.com; connect-src 'self' https://api.razorpay.com" }], effort: "days" },
  "hack:cryptominer": { steps: "Remove the crypto-mining script (it uses visitors' processors) and find how it got in.", effort: "hours" },
  "hack:defaced": { steps: "The page was defaced: put the clean version back from backup now, then find the hole (outdated plugin, weak password, writable files) before the attacker returns.", effort: "hours" },
  "hack:cloaking": { steps: "The site shows Google different content from visitors, which is a sign of an SEO-spam hack. Look for code that checks the user agent for Googlebot (in index.php, .htaccess, wp-config.php or a plugin), remove it, then request a review in Search Console.", code: [{ label: "Shell (on the server)", snippet: "grep -rniE 'googlebot|HTTP_USER_AGENT' --include='*.php' /path/to/site | grep -v wp-includes | head\ngrep -niE 'googlebot|RewriteCond.*HTTP_REFERER' .htaccess" }], effort: "hours" },
  "hack:search-redirect": { steps: "Visitors coming from Google are redirected to another site: remove the redirect rule (often in .htaccess, or a script checking document.referrer), then change all passwords.", code: [{ label: "Shell", snippet: "grep -niE 'HTTP_REFERER|google' .htaccess\ngrep -rn 'document.referrer' --include='*.js' /path/to/site | head" }], effort: "hours" },
  "clamav:malware": { steps: "ClamAV matched known malware. Delete or restore the file from a clean backup, scan the whole server (clamscan -ri /var/www), and change passwords.", effort: "hours" },
  "server:webshell": { steps: "A web shell lets an attacker run commands on the server. Move the file out of the web folder (keep a copy for evidence), look for others, check the access logs for who used it, update the CMS and plugins, and change all passwords and keys.", code: [{ label: "Shell", snippet: "grep -rlE 'eval\\(base64_decode|eval\\(gzinflate|assert\\(\\$_(POST|GET)|system\\(\\$_' /var/www | head\ngrep -E 'POST .*(shell|cmd|wso)\\.php' /var/log/nginx/access.log | tail" }], effort: "hours" },

  // DNS and email
  "dns:no-spf": { steps: "Add an SPF record that lists who may send the domain's email, ending in -all (or ~all while testing).", code: [{ label: "DNS TXT (@)", snippet: "v=spf1 include:_spf.google.com include:_spf.mail.hostinger.com -all" }], effort: "minutes" },
  "dns:no-spf-parked": { steps: "This domain sends no email: say so, so nobody can send in its name.", code: [{ label: "DNS TXT (@)", snippet: "v=spf1 -all" }, { label: "DNS TXT (_dmarc)", snippet: "v=DMARC1; p=reject" }], effort: "minutes" },
  "dns:spf-pass-all": { steps: "+all lets anyone send as the domain. Replace it with -all after listing the real senders.", effort: "minutes" },
  "dns:spf-neutral": { steps: "?all gives no protection. Use ~all, then -all once DMARC reports show all senders pass.", effort: "minutes" },
  "dns:spf-multiple": { steps: "A domain may have only one SPF record: merge them into one v=spf1 line.", effort: "minutes" },
  "dns:spf-too-many-lookups": { steps: "SPF allows at most 10 DNS lookups and this record needs more, so it fails. Remove senders you no longer use, or replace include: with the senders' ip4:/ip6: ranges.", effort: "hours" },
  "dns:spf-near-limit": { steps: "SPF is close to its 10-lookup limit: one more include will break it. Remove unused senders now.", effort: "minutes" },
  "dns:no-dmarc": { steps: "Add DMARC so receivers know what to do with mail that fails SPF and DKIM. Start at p=none with reports, then move to quarantine and reject.", code: [{ label: "DNS TXT (_dmarc)", snippet: "v=DMARC1; p=none; rua=mailto:dmarc@example.com; adkim=s; aspf=s" }], effort: "minutes" },
  "dns:dmarc-none": { steps: "p=none only watches. Once reports show your real senders pass, move to p=quarantine, then p=reject. Gmail and Yahoo require DMARC for bulk senders.", code: [{ label: "DNS TXT (_dmarc)", snippet: "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@example.com" }], effort: "minutes" },
  "dns:dmarc-invalid": { steps: "Fix the DMARC record: it must start with v=DMARC1; and have a p= tag.", effort: "minutes" },
  "dns:dmarc-partial": { steps: "pct below 100 leaves part of the spoofed mail through: raise it to 100.", effort: "minutes" },
  "dns:dmarc-subdomains-open": { steps: "sp=none leaves subdomains open to spoofing: set sp=quarantine or sp=reject.", effort: "minutes" },
  "dns:dmarc-no-reports": { steps: "Add rua=mailto:… so you receive DMARC reports and can see who sends as you.", effort: "minutes" },
  "dns:dkim-not-found": { steps: "Turn on DKIM signing in the mail service (Google Workspace, Microsoft 365, Hostinger) and publish the key it gives you. If DKIM is already on with an unusual selector, this can be ignored.", effort: "minutes" },
  "dns:dkim-weak": { steps: "The DKIM key is shorter than 2048 bits: create a new 2048-bit key in the mail service and publish it.", effort: "minutes" },
  "dns:dkim-revoked": { steps: "This DKIM selector has an empty key (revoked). Remove it, or publish the current key if mail still uses it.", effort: "minutes" },
  "dns:no-mta-sts": { steps: "MTA-STS makes other mail servers use encryption when sending to you. Publish the policy file and the DNS record.", code: [{ label: "https://mta-sts.example.com/.well-known/mta-sts.txt", snippet: "version: STSv1\nmode: enforce\nmx: *.mail.example.com\nmax_age: 604800" }, { label: "DNS TXT (_mta-sts)", snippet: "v=STSv1; id=20261122" }], effort: "hours" },
  "dns:mta-sts-policy-missing": { steps: "The MTA-STS DNS record exists but the policy file is not served at https://mta-sts.<domain>/.well-known/mta-sts.txt: publish it.", effort: "minutes" },
  "dns:mta-sts-testing": { steps: "MTA-STS is in testing mode: once TLS reports are clean, change mode to enforce and update the id.", effort: "minutes" },
  "dns:no-tls-rpt": { steps: "Add TLS-RPT so mail servers report encryption failures to you.", code: [{ label: "DNS TXT (_smtp._tls)", snippet: "v=TLSRPTv1; rua=mailto:tls-reports@example.com" }], effort: "minutes" },
  "dns:no-bimi": { steps: "Optional: BIMI shows your logo next to your mail in Gmail and Yahoo. It needs DMARC at quarantine or reject and an SVG Tiny PS logo.", code: [{ label: "DNS TXT (default._bimi)", snippet: "v=BIMI1; l=https://example.com/logo.svg" }], effort: "hours" },
  "dns:no-dnssec": { steps: "Turn on DNSSEC at the DNS host (Cloudflare: DNS > Settings > DNSSEC; Hostinger: Domains > DNSSEC) and add the DS record at the registrar.", effort: "minutes" },
  "dns:no-caa": { steps: "Add CAA records so only your certificate authorities can issue certificates for the domain.", code: [{ label: "DNS CAA (@)", snippet: '0 issue "letsencrypt.org"\n0 issue "pki.goog"\n0 iodef "mailto:security@example.com"' }], effort: "minutes" },

  // Attack surface
  "surface:subdomain-takeover": { steps: "This subdomain points to a service account that no longer exists, so anyone can claim it and serve pages on your domain. Delete the DNS record now (or claim the service name back first if you still need it).", effort: "minutes" },
  "surface:dangling-cname": { steps: "The CNAME points to a name that does not exist. Remove the record, or point it at a live host.", effort: "minutes" },
  "surface:default-page": { steps: "A server's default page is public: remove the site, or put the real site or a login in front of it.", effort: "minutes" },
  "surface:exposed-non-production": { steps: "A staging, test or admin host is reachable from the internet. Put it behind a login, VPN or IP allow-list, and add noindex.", code: [{ label: "Nginx", snippet: "allow 203.0.113.10;  # office\ndeny all;\nadd_header X-Robots-Tag \"noindex, nofollow\" always;" }], effort: "hours" },
  "ports:dangerous-open": { steps: "Close this port to the internet with the firewall (it serves databases, remote desktop or admin tools). Reach it over SSH or a VPN instead.", code: [{ label: "Ubuntu (ufw)", snippet: "sudo ufw deny 3306/tcp\nsudo ufw allow from 203.0.113.10 to any port 3306 proto tcp" }], effort: "minutes" },
  "ports:open": { steps: "Check this port should be public; close it in the firewall if not.", effort: "minutes" },

  // Blind (out-of-band) holes
  "attack:blind-ssrf": { steps: "The server fetched a GLV address it was given, so an attacker can make it call internal systems (cloud metadata, admin panels). Allow only a list of known hosts, and block private and link-local addresses after DNS resolution.", code: [{ label: "Node.js", snippet: 'const u = new URL(input);\nif (!ALLOWED_HOSTS.has(u.hostname)) throw new Error("Host not allowed");' }], effort: "hours" },
  "attack:blind-xss": { steps: "Text saved by a visitor ran as script in another screen (an admin panel or email). Escape output in every place the stored value is shown, and add a Content-Security-Policy.", effort: "hours" },
  "attack:log4shell": { steps: "A Java service looked up a JNDI address from a request header (Log4Shell). Upgrade log4j-core to 2.17.1 or later now, and block outbound LDAP/RMI from the server.", effort: "hours" },
  "attack:blind-header-fetch": { steps: "The server fetches addresses it finds in request headers (Referer, X-Forwarded-Host). Stop fetching them, or allow only known hosts.", effort: "hours" },

  // Documents
  "doc:pdf-untagged": { steps: "The PDF has no tags, so screen readers read it as one jumble. Export it again with tags on (Word: File > Save as PDF > Options > Document structure tags; InDesign: Create Tagged PDF), or fix it in Acrobat > Accessibility > Autotag.", effort: "hours" },
  "doc:pdf-scanned": { steps: "The PDF is a scan with no text: publish the original document, or run OCR (Acrobat: Scan & OCR; free: ocrmypdf) and then tag it.", code: [{ label: "Shell", snippet: "ocrmypdf --language eng+hin in.pdf out.pdf" }], effort: "hours" },
  "doc:pdf-no-language": { steps: "Set the PDF's language (Acrobat: File > Properties > Advanced > Language), or set the language in Word before exporting.", effort: "minutes" },
  "doc:pdf-no-title": { steps: "Give the PDF a title (Word: File > Info > Title; Acrobat: File > Properties > Title).", effort: "minutes" },
  "doc:pdf-title-hidden": { steps: "Make the PDF show its title, not its file name, in the window (Acrobat: File > Properties > Initial View > Show: Document Title).", effort: "minutes" },
  "doc:pdf-figure-no-alt": { steps: "Give each image in the PDF alt text (add it in Word before exporting, or Acrobat > Accessibility > Set Alternate Text).", effort: "hours" },
  "doc:pdf-not-pdfua": { steps: "To meet PDF/UA, export with PDF/UA on (Word: Save as PDF > Options > PDF/UA compliant) and check it with veraPDF or PAC.", effort: "hours" },
  "doc:pdf-locked": { steps: "The PDF's security stops screen readers copying its text: remove the restriction, or allow content access for accessibility.", effort: "minutes" },
  "doc:office-no-title": { steps: "Set the document's title in File > Info > Properties > Title.", effort: "minutes" },
  "doc:docx-no-headings": { steps: "Use Word's Heading 1, Heading 2 styles for headings instead of big bold text, so screen reader users can move by heading.", effort: "minutes" },
  "doc:office-no-language": { steps: "Set the document's language (Review > Language > Set Proofing Language).", effort: "minutes" },
  "doc:pptx-untitled-slides": { steps: "Give every slide a title (use a layout with a title box; it can be hidden off-slide if needed).", effort: "minutes" },
  "doc:xlsx-default-sheet-names": { steps: "Rename sheets from Sheet1, Sheet2 to what they hold.", effort: "minutes" },
  "doc:office-image-no-alt": { steps: "Add alt text to every picture (right-click > View Alt Text), or mark it decorative.", effort: "minutes" },
  "doc:not-pdf": { steps: "The link says PDF but the server returns something else (a login or error page): fix the link or the file.", effort: "minutes" },
  "doc:office-broken": { steps: "The file cannot be opened: upload it again.", effort: "minutes" },
  "doc:more-not-checked": { steps: "Only the first documents were checked: run the veraPDF tool, or check the rest the same way.", effort: "minutes" },
  "verapdf:pdfua-fails": { steps: "Fix the PDF/UA rules veraPDF lists (most come from missing tags, alt text and language): export again from the source with tags and PDF/UA on.", effort: "hours" },

  // India: DPDP
  "dpdp:no-notice": { steps: "Publish a privacy notice (DPDP Act 2023 and Rules 2025) linked from every page and every form that collects personal data. It must say what is collected and why, how to withdraw consent, the person's rights, and how to complain to you and to the Data Protection Board.", effort: "days" },
  "dpdp:notice-broken": { steps: "Fix the privacy link: it does not open the notice.", effort: "minutes" },
  "dpdp:notice-gdpr-only": { steps: "The notice is written for GDPR (Europe) only. Add the DPDP items: the Data Protection Board of India, a grievance officer with contact details, the right to nominate, and how to withdraw consent.", effort: "hours" },
  "dpdp:notice-too-long": { steps: "DPDP asks for a notice people can understand on its own: put a short summary (what, why, how to withdraw, how to complain) above the full text.", effort: "hours" },
  "dpdp:english-only": { steps: "DPDP lets people ask for the notice in any of the 22 languages of the Eighth Schedule: offer it at least in Hindi and the region's language, or say how to get it in one.", effort: "days" },
  "dpdp:form-no-notice": { steps: "Next to the form, link the privacy notice and say in one line what the data is for, before it is sent.", code: [{ label: "HTML", snippet: '<p class="small">We use your phone number only to call you back about this enquiry. <a href="/privacy">Privacy notice</a> · <a href="/privacy#withdraw">Withdraw consent</a></p>' }], effort: "minutes" },
  "dpdp:pre-ticked-consent": { steps: "Consent must be a clear action: leave consent boxes unticked, one box per purpose (marketing separately from the service).", code: [{ label: "HTML", snippet: '<label><input type="checkbox" name="marketing"> Send me offers by WhatsApp (optional)</label>' }], effort: "minutes" },

  // Dark patterns (CCPA guidelines 2023)
  "dark:pre-ticked": { steps: "Leave add-ons, insurance, donations and newsletters unticked; the buyer must choose them.", effort: "minutes" },
  "dark:basket-sneaking": { steps: "Do not add items, insurance or donations to the cart the buyer did not choose (CCPA basket sneaking). Offer them as an unticked option.", effort: "hours" },
  "dark:confirm-shaming": { steps: 'Use a neutral "No thanks" for the decline option, not words that shame the user.', effort: "minutes" },
  "dark:false-urgency": { steps: 'Show "only N left" or "X people are viewing" only when it is true, from live stock or traffic data, or remove it.', effort: "hours" },
  "dark:trick-question": { steps: "Write consent questions plainly with one meaning, no double negatives (\"Send me offers\", not \"Untick if you do not want to not receive…\").", effort: "minutes" },
  "dark:drip-pricing": { steps: "Show the full price, including fees and taxes, on the product page, not only at the last step (CCPA drip pricing).", effort: "hours" },
  "dark:no-reject": { steps: 'Give "Reject all" the same size and place as "Accept all" on the consent banner.', effort: "minutes" },
  "dark:trial-needs-card": { steps: "Say clearly before sign-up that a card is needed, when it will be charged and how to cancel, or allow the trial without a card.", effort: "hours" },
  "dark:countdown": { steps: "A countdown is fine when the offer really ends then. Make sure it does not restart on reload.", effort: "minutes" },
  "dark:fake-timer": { steps: "The countdown restarts when the page is opened again, so the deadline is false (CCPA false urgency). Tie it to the real end date of the offer, or remove it.", effort: "minutes" },

  // Mobile runtime
  "runtime:log-leak": { steps: "Remove logging of tokens, passwords and personal data; strip Log calls from release builds.", code: [{ label: "proguard-rules.pro", snippet: "-assumenosideeffects class android.util.Log {\n  public static *** d(...);\n  public static *** v(...);\n  public static *** i(...);\n}" }], effort: "hours" },
  "runtime:debuggable": { steps: "The installed build is debuggable: build the release variant (debuggable false) for testers and the store.", effort: "minutes" },
  "runtime:plain-storage": { steps: "Store tokens in EncryptedSharedPreferences or the Android Keystore, not plain SharedPreferences or files.", code: [{ label: "Kotlin", snippet: 'val prefs = EncryptedSharedPreferences.create(context, "secure", MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(), EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)' }], effort: "hours" },
  "runtime:external-storage": { steps: "Keep personal files in the app's private storage (context.filesDir), not shared storage other apps can read.", effort: "hours" },
  "runtime:no-flag-secure": { steps: "Set FLAG_SECURE on screens with payment, OTP or personal data so they are hidden in screenshots and the recent-apps view.", code: [{ label: "Kotlin", snippet: "window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)" }], effort: "minutes" },
  "runtime:no-root-detection": { steps: "For banking, payment or health apps, use the Play Integrity API to detect rooted or modified phones and limit risky actions on them.", effort: "days" },
  "runtime:no-pinning": { steps: "The app accepted GLV's test certificate, so a network attacker could read its traffic. Pin the API's certificate public key with a network security config.", code: [{ label: "res/xml/network_security_config.xml", snippet: '<network-security-config>\n  <domain-config>\n    <domain includeSubdomains="true">api.example.com</domain>\n    <pin-set expiration="2027-12-31">\n      <pin digest="SHA-256">base64-of-key-hash=</pin>\n      <pin digest="SHA-256">base64-of-backup-key-hash=</pin>\n    </pin-set>\n  </domain-config>\n</network-security-config>' }], effort: "hours" },

  // Browser matrix
  "matrix:page-fails": { steps: "The page does not open in this older browser. Check the error shown for it, and set your build's browserslist to the versions you support.", code: [{ label: "package.json", snippet: '"browserslist": ["chrome >= 109", "firefox >= 115", "safari >= 15", "edge >= 120"]' }], effort: "hours" },
  "matrix:blank-page": { steps: "The page is blank in this browser, usually a script syntax it does not know (optional chaining, top-level await). Lower the build target or add the needed polyfills.", code: [{ label: "vite.config.ts", snippet: 'build: { target: ["chrome109", "firefox115", "safari15"] }' }], effort: "hours" },
  "matrix:js-error": { steps: "Fix the script error shown for this browser: often a newer function (structuredClone, Array.prototype.at) that needs a polyfill.", effort: "hours" },
  "matrix:css-unsupported": { steps: "This browser does not support the CSS feature listed. Add a fallback before it, or wrap it in @supports.", code: [{ label: "CSS", snippet: ".card { margin-top: 1rem; }\n@supports (selector(:has(*))) {\n  .card:has(img) { margin-top: 0; }\n}" }], effort: "hours" },

  // Self-healing, replay, mutation
  "journey:healed": { steps: "The journey's button or field was found by a close match, not its exact words. Update the step to the words now on screen so it does not depend on healing.", effort: "minutes" },
  "replay:now-fails": { steps: "This call worked when the session was recorded and fails now. Compare the release's changes to this route, or record the session again if the change was meant.", effort: "hours" },
  "replay:breaking-change": { steps: "Fields were removed or changed type, which breaks apps reading them. Keep the old fields for one release (mark them deprecated), or publish the change as a new API version.", effort: "hours" },
  "replay:slower": { steps: "This call is much slower than when recorded. Compare its database queries (EXPLAIN), missing indexes and caching against the last release.", effort: "hours" },
  "mutation:survived": { steps: "Write a test that checks this line's result, including its edge cases (equal values, empty input, false). Run mutation testing again: the change should now be caught.", effort: "hours" },
  "mutation:low-score": { steps: "Most planted bugs were not caught. Add assertions on results, not just calls, starting with the files that have the most surviving changes. Aim for 70% or more on business logic.", effort: "days" },
};

const AI_FAMILY_FIXES: Record<string, Fix> = {
  inj: { steps: "The chatbot follows instructions hidden in the user's message. Keep the system prompt separate from user text, tell the model user text is data, check replies against the bot's allowed topics, and never let a reply alone trigger an action.", effort: "hours" },
  jb: { steps: "The chatbot can be talked out of its rules (role-play, encoding, other languages). Add a moderation check on both the question and the answer (an open guard model such as Llama Guard, or the provider's moderation), and refuse when it flags.", effort: "hours" },
  sys: { steps: "The chatbot reveals its instructions. Do not put secrets, prices or internal links in the system prompt; add an output check that blocks replies quoting it.", effort: "hours" },
  leak: { steps: "The chatbot reveals data it should not. Give it access only to the signed-in user's own records (filter in the tool or retrieval, never in the prompt), and mask personal data in answers.", effort: "days" },
  ind: { steps: "The chatbot obeys instructions hidden in a page, email or file it reads (indirect prompt injection). Treat fetched content as untrusted data, strip hidden text, and require a human or a fixed rule before any action that came from it.", effort: "days" },
  out: { steps: "The chatbot's reply can carry HTML, links or images that send data out. Render replies as plain text or sanitise them, and allow links only to your own domains.", effort: "hours" },
  agency: { steps: "The chatbot takes actions (refunds, admin changes, code) on the user's word alone. Give its tools the user's own permissions only, cap amounts, and ask the user to confirm on a normal screen before acting.", effort: "days" },
  mis: { steps: "The chatbot invents products, prices or policies. Answer from your own documents (retrieval) and tell it to say it does not know when they do not cover the question.", effort: "hours" },
  dos: { steps: "The chatbot can be made to write endlessly. Cap reply length (max tokens) and requests per user per minute.", effort: "minutes" },
  harm: { steps: "The chatbot writes harmful or off-brand content (phishing, attacks on competitors). Narrow it to your topics and add a moderation check on replies.", effort: "hours" },
};

/** Fixes for rules made from a name (ai:inj-ignore, gigw:no-hindi, yara:glv_php_webshell). */
export function p1PatternFix(rule: string): Fix | undefined {
  const [tool, id = ""] = rule.split(/:(.*)/s);
  if (tool === "ai") return AI_FAMILY_FIXES[id.split("-")[0]];
  if (tool === "garak") return AI_FAMILY_FIXES[/leak|replay/.test(id) ? "leak" : /latent|inject|promptinj/.test(id) ? "inj" : /xss|markdown|exfil/.test(id) ? "out" : /dan|jailbreak|encoding/.test(id) ? "jb" : "harm"];
  if (tool === "gigw") return { steps: `GIGW 3.0 asks every government (and government-funded) site for this item (${id.replace(/^no-/, "").replace(/-/g, " ")}). Add it to the footer or the page template, so it appears on every page.`, effort: "hours" };
  if (tool === "dpdp" && id.startsWith("notice-no-")) return { steps: `Add the missing DPDP item to the privacy notice (${id.slice(10)}): Rule 3 of the DPDP Rules 2025 asks for the purpose, how to withdraw consent, the person's rights, the grievance contact, and how to complain to the Data Protection Board, in plain words.`, effort: "hours" };
  if (tool === "yara") {
    if (/webshell/.test(id)) return P1_FIXES["server:webshell"];
    if (/skimmer/.test(id)) return P1_FIXES["hack:skimmer"];
    if (/miner/.test(id)) return P1_FIXES["hack:cryptominer"];
    if (/spam/.test(id)) return P1_FIXES["hack:hidden-spam-links"];
    if (/redirect/.test(id)) return P1_FIXES["hack:search-redirect"];
    if (/deface/.test(id)) return P1_FIXES["hack:defaced"];
    return P1_FIXES["hack:suspicious-script"];
  }
  if (tool === "mobsf") return { steps: "Follow the fix MobSF shows for this check (its MASVS link has code examples), then scan the new build again.", effort: "hours" };
  return undefined;
}
