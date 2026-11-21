import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { FAKE_AWS_KEY } from "./demo-apk.js";

// Made-up keys, built from parts so this file does not itself look like a leak.
export const FAKE_NPM_TOKEN = ["npm_", "a1B2c3D4e5F6g7H8i9J0", "kLmNoPqRsTuVwXyZ12"].join("");
export const FAKE_OLD_GITHUB = ["ghp_", "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8"].join("");

/**
 * A small project with planted problems for the code tools:
 * - an AWS key in config.js (the platform finds it too, so Gitleaks' copy is folded in)
 * - an npm token in .npmrc (Gitleaks only)
 * - lodash 4.17.15 in package-lock.json (the platform, Trivy and OSV-Scanner: one finding)
 * - Django 3.2.0 and PyYAML 5.3 in requirements.txt (Trivy and OSV-Scanner)
 * - golang.org/x/text v0.3.0 in go.mod (Trivy and OSV-Scanner)
 * - a Dockerfile that runs as root from an unpinned image, and a Kubernetes file with a privileged container (Trivy)
 * - an AGPL package in the lockfile (Trivy's licence check)
 * - risky code for the GLV Opengrep rules: SQL built from the request, a shell command with
 *   request input, yaml.load, TLS checks turned off, PHP unserialize of input, innerHTML
 */
export function demoCodeFiles(): Record<string, string> {
  return {
    "README.md": "# Shop\n\nDemo project.\n",
    "config.js": `module.exports = { awsKey: "${FAKE_AWS_KEY}", region: "ap-south-1" };\n`,
    ".npmrc": `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}\n`,
    "package.json": JSON.stringify({ name: "shop", version: "1.0.0", dependencies: { lodash: "^4.17.15", "agpl-widget": "1.0.0" } }, null, 2),
    "package-lock.json": JSON.stringify(
      {
        name: "shop",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "shop", version: "1.0.0", dependencies: { lodash: "^4.17.15", "agpl-widget": "1.0.0" } },
          "node_modules/lodash": { version: "4.17.15", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz", license: "MIT" },
          "node_modules/agpl-widget": { version: "1.0.0", resolved: "https://registry.npmjs.org/agpl-widget/-/agpl-widget-1.0.0.tgz", license: "AGPL-3.0" },
        },
      },
      null,
      2,
    ),
    "requirements.txt": "Django==3.2.0\nPyYAML==5.3\n",
    "go.mod": "module example.com/shop\n\ngo 1.21\n\nrequire golang.org/x/text v0.3.0\n",
    "go.sum": "",
    Dockerfile: "FROM node:latest\nWORKDIR /app\nADD . /app\nRUN npm install\nCMD [\"node\", \"server.js\"]\n",
    "k8s/deploy.yaml": [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: shop",
      "spec:",
      "  selector:",
      "    matchLabels: { app: shop }",
      "  template:",
      "    metadata:",
      "      labels: { app: shop }",
      "    spec:",
      "      containers:",
      "        - name: shop",
      "          image: shop:latest",
      "          securityContext:",
      "            privileged: true",
      "",
    ].join("\n"),
    "server.js": [
      `const express = require("express");`,
      `const { exec } = require("child_process");`,
      `const https = require("https");`,
      `const db = require("./db");`,
      `const app = express();`,
      `app.get("/user", (req, res) => {`,
      `  db.query("SELECT * FROM users WHERE id = " + req.query.id, (err, rows) => res.json(rows));`,
      `});`,
      `app.get("/ping", (req, res) => {`,
      `  exec("ping -c 1 " + req.query.host, (err, out) => res.send(out));`,
      `});`,
      `const agent = new https.Agent({ rejectUnauthorized: false });`,
      `app.listen(3000);`,
      ``,
    ].join("\n"),
    "web/app.js": `function show(name) {\n  document.getElementById("out").innerHTML = location.hash.slice(1);\n}\n`,
    "tools/load.py": [
      "import yaml",
      "import requests",
      "import subprocess",
      "",
      "def load(path):",
      "    with open(path) as f:",
      "        return yaml.load(f)",
      "",
      "def fetch(url):",
      "    return requests.get(url, verify=False)",
      "",
      "def run(cmd):",
      "    return subprocess.call(cmd, shell=True)",
      "",
    ].join("\n"),
    "cart.php": "<?php\n$cart = unserialize($_COOKIE['cart']);\n$r = mysqli_query($conn, \"SELECT * FROM items WHERE id = \" . $_GET['id']);\n",
    "utils.js": "export const add = (a, b) => a + b;\n",
  };
}

/** The demo project as a zip, with one top folder as most uploaded zips have. */
export function demoCodeZip(): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(demoCodeFiles()).map(([name, text]) => [`shop/${name}`, strToU8(text)])));
}

/**
 * The demo project as a Git repository, with a GitHub token that was committed and then removed:
 * still in the history, which only a full-history scan finds.
 */
export async function demoCodeRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  await writeFile(path.join(dir, "deploy.sh"), `#!/bin/sh\nexport GITHUB_TOKEN=${FAKE_OLD_GITHUB}\n./deploy\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "Add deploy script");
  await writeFile(path.join(dir, "deploy.sh"), "#!/bin/sh\n./deploy\n");
  for (const [name, text] of Object.entries(demoCodeFiles())) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "Remove the token, add the shop");
  return dir;
}
