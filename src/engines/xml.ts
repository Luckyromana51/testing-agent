/*
 * A small XML reader for WSDL files and SOAP answers: elements, attributes and text, with
 * namespace prefixes kept on names and also stripped (local). No DTDs or entities beyond the five
 * standard ones are read, so a file cannot make the server fetch anything (no XXE).
 */

export interface XmlNode {
  name: string;
  /** The name without its namespace prefix. */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()]));
const localOf = (n: string) => n.slice(n.indexOf(":") + 1);

export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: "#root", local: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (++n > 200_000) throw new Error("The XML is too big.");
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1 && top.name === m[2]) stack.pop();
      else {
        const at = stack.map((x) => x.name).lastIndexOf(m[2]);
        if (at > 0) stack.length = at;
      }
    } else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? "");
      const node: XmlNode = { name: m[3], local: localOf(m[3]), attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (!root.children.length) throw new Error("No XML elements found.");
  return root.children[0];
}

/** Every element below (and including) a node with this local name. */
export function findAll(node: XmlNode, local: string, out: XmlNode[] = []): XmlNode[] {
  if (node.local === local) out.push(node);
  for (const c of node.children) findAll(c, local, out);
  return out;
}

export const find = (node: XmlNode, local: string): XmlNode | undefined => findAll(node, local)[0];
export const kids = (node: XmlNode, local: string) => node.children.filter((c) => c.local === local);
export const textOf = (node: XmlNode | undefined): string => (node ? (node.text + node.children.map(textOf).join(" ")).replace(/\s+/g, " ").trim() : "");

export const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
