import type { APIRequestContext } from "playwright";
import { finding } from "../../runner/finding.js";
import type { Finding } from "../../types.js";

/**
 * Finds Firebase Realtime Database addresses in an app's code and checks, with one read of the top
 * level (GET, shallow), that the database does not answer anyone without a login. Shared by the
 * Android and iOS engines.
 */
export async function openFirebaseFindings(strings: { file: string; text: string }[], request: APIRequestContext, rule: string, unpack: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const urls = new Set<string>();
  for (const s of strings) {
    for (const m of s.text.matchAll(/https:\/\/[a-z0-9-]+\.(?:firebaseio\.com|[a-z0-9-]+\.firebasedatabase\.app)/gi)) urls.add(m[0].toLowerCase());
  }
  for (const url of [...urls].slice(0, 3)) {
    try {
      const res = await request.get(`${url}/.json?shallow=true`, { timeout: 15_000, failOnStatusCode: false });
      const body = (await res.text()).trim();
      if (res.status() === 200) {
        const hasData = body !== "null" && body !== "{}";
        out.push(
          finding({
            category: "security",
            rule,
            severity: hasData ? "critical" : "medium",
            title: "The Firebase database can be read by anyone",
            detail: hasData
              ? `${url} answered a request with no login with data. Anyone who ${unpack} finds this address. Change the database rules so reads need auth (".read": "auth != null") and check the data is not already copied.`
              : `${url} allows reads with no login (it is empty right now). Change the rules so reads need auth.`,
            pageUrl: url,
            evidence: `GET /.json -> 200${hasData ? ", data returned" : ", empty"}`,
          }),
        );
      }
    } catch {
      /* unreachable from here: nothing to report */
    }
  }
  return out;
}
