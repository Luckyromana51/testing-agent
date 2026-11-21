#!/usr/bin/env node
// A stand-in for OpenSSH's ssh client, for tests on machines without a real server to sign in to.
// It checks the key or the password, writes the server's key into UserKnownHostsFile like ssh does,
// answers the fixed server-check script with a planted server, and for -D opens a small SOCKS5
// proxy that sends *.internal names to 127.0.0.1 (as if the client's server resolved them).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";

const args = process.argv.slice(2);
if (args[0] === "-V") {
  process.stderr.write("OpenSSH_9.6p1 (fake)\n");
  process.exit(0);
}
const opts = {};
let dyn;
let i = 0;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === "--") {
    i++;
    break;
  }
  if (a === "-o") {
    const [k, ...v] = args[++i].split("=");
    opts[k] = v.join("=");
  } else if (a === "-D") dyn = args[++i];
  else if (a === "-p" || a === "-i" || a === "-F") opts[a] = args[++i];
  else if (a === "-N") opts.N = true;
}
const dest = args[i];
const command = args.slice(i + 1).join(" ");
const [user, host] = dest.split("@");
const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(255);
};

if (host === "down.example") fail(`ssh: connect to host ${host} port 22: Connection timed out`);
const KEY_LINE = `${host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeServerKeyForGlvTestsOnly0000000000000`;
const known = opts.UserKnownHostsFile;
if (known && existsSync(known)) {
  const text = readFileSync(known, "utf8");
  if (text.includes(host) && !text.includes(KEY_LINE)) fail("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.");
}

if (opts.PubkeyAuthentication === "no") {
  const pass = opts.BatchMode === "yes" || !process.env.SSH_ASKPASS ? "" : execFileSync(process.env.SSH_ASKPASS, { env: process.env }).toString().trim();
  if (pass !== "right-password") fail(`${user}@${host}: Permission denied (publickey,password).`);
} else {
  const keyFile = opts["-i"];
  const key = keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";
  if (!key.includes("BEGIN OPENSSH PRIVATE KEY") || key.includes("WRONG")) fail(`${user}@${host}: Permission denied (publickey).`);
}
if (known && (!existsSync(known) || !readFileSync(known, "utf8").includes(KEY_LINE))) appendFileSync(known, `${KEY_LINE}\n`);

if (dyn) {
  const [bindHost, bindPort] = dyn.split(":");
  const srv = createServer((sock) => {
    sock.once("data", () => {
      sock.write(Buffer.from([5, 0]));
      sock.once("data", (req) => {
        let name;
        let at = 4;
        if (req[3] === 3) {
          const len = req[4];
          name = req.subarray(5, 5 + len).toString();
          at = 5 + len;
        } else if (req[3] === 1) {
          name = [...req.subarray(4, 8)].join(".");
          at = 8;
        }
        const port = req.readUInt16BE(at);
        const target = /\.internal$|^localhost$/.test(name) ? "127.0.0.1" : name;
        const up = connect(port, target, () => {
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          sock.pipe(up).pipe(sock);
        });
        up.on("error", () => {
          sock.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
        sock.on("error", () => up.destroy());
      });
    });
    sock.on("error", () => {});
  });
  srv.listen(Number(bindPort), bindHost);
  process.on("SIGTERM", () => process.exit(0));
} else if (command.includes("##listen")) {
  const now = Math.floor(Date.now() / 1000);
  process.stdout.write(
    [
      "##os",
      'PRETTY_NAME="Ubuntu 20.04.6 LTS"',
      "ID=ubuntu",
      'VERSION_ID="20.04"',
      "##uname",
      "Linux 5.4.0-200-generic x86_64",
      "##uptime",
      " 10:00:00 up 300 days,  2 users,  load average: 0.10, 0.20, 0.30",
      "##time",
      String(now),
      "##df",
      "Filesystem     1024-blocks      Used Available Capacity Mounted on",
      "/dev/sda1         41152736  38700000   2452736      95% /",
      "tmpfs              1000000         0   1000000       0% /run",
      "##mem",
      "               total        used        free      shared  buff/cache   available",
      "Mem:            3900        3700          50          10         150         120",
      "##listen",
      "LISTEN 0      151          0.0.0.0:3306      0.0.0.0:*",
      "LISTEN 0      511          0.0.0.0:80        0.0.0.0:*",
      "LISTEN 0      511        127.0.0.1:6379      0.0.0.0:*",
      "##sshd",
      "PermitRootLogin yes",
      "PasswordAuthentication yes",
      "##updates",
      "14",
      "##reboot",
      "yes",
      "##web",
      "nginx version: nginx/1.18.0 (Ubuntu)",
      "PHP 7.4.3 (cli) (built: Mar  2 2022 15:36:52) ( NTS )",
      "##end",
      "",
    ].join("\n"),
  );
} else if (command.includes("##whoami")) {
  process.stdout.write(`##os\nPRETTY_NAME="Ubuntu 20.04.6 LTS"\n##uname\nLinux 5.4.0 x86_64\n##whoami\n${user}\n##end\n`);
} else {
  fail("fake ssh: unexpected command");
}
