// Examples for the GLV JavaScript rules: "ruleid" lines must be found, "ok" lines must not.
const { exec, execFile } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

app.get("/user", (req, res) => {
  // ruleid: glv.js.sql-injection
  db.query("SELECT * FROM users WHERE id = " + req.query.id);
  // ok: glv.js.sql-injection
  db.query("SELECT * FROM users WHERE id = ?", [req.query.id]);
  // ok: glv.js.sql-injection
  db.query("SELECT * FROM users WHERE id = " + parseInt(req.query.id));
  const name = req.body.name;
  // ruleid: glv.js.sql-injection
  pool.execute(`SELECT * FROM users WHERE name = '${name}'`);
});

app.get("/ping", (req, res) => {
  // ruleid: glv.js.command-injection
  exec("ping -c 1 " + req.query.host);
  // ok: glv.js.command-injection
  execFile("ping", ["-c", "1", req.query.host]);
  // ok: glv.js.command-injection
  exec("uptime");
});

app.post("/calc", (req, res) => {
  // ruleid: glv.js.eval-input
  res.send(String(eval(req.body.expr)));
  // ok: glv.js.eval-input
  eval("1 + 1");
});

app.get("/proxy", async (req, res) => {
  // ruleid: glv.js.ssrf
  const r = await fetch(req.query.url);
  // ok: glv.js.ssrf
  await fetch("https://api.example.com/items?q=" + encodeURIComponent("x"));
  // ruleid: glv.js.open-redirect
  res.redirect(req.query.next);
  // ok: glv.js.open-redirect
  res.redirect("/home");
});

app.get("/file", (req, res) => {
  // ruleid: glv.js.path-traversal
  fs.readFile("uploads/" + req.query.name, (e, d) => res.send(d));
  // ok: glv.js.path-traversal
  fs.readFile("uploads/" + path.basename(req.query.name), (e, d) => res.send(d));
});

function show() {
  // ruleid: glv.js.dom-xss
  document.getElementById("out").innerHTML = location.hash.slice(1);
  // ok: glv.js.dom-xss
  document.getElementById("out").textContent = location.hash.slice(1);
  // ok: glv.js.dom-xss
  document.getElementById("out").innerHTML = DOMPurify.sanitize(location.hash);
}

// ruleid: glv.js.tls-verify-off
const agent = new https.Agent({ rejectUnauthorized: false });
// ok: glv.js.tls-verify-off
const agent2 = new https.Agent({ rejectUnauthorized: true });
// ruleid: glv.js.tls-verify-off
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ruleid: glv.js.hardcoded-jwt-secret
const token = jwt.sign({ id: 1 }, "supersecret");
// ok: glv.js.hardcoded-jwt-secret
const token2 = jwt.sign({ id: 1 }, process.env.JWT_SECRET);

// ruleid: glv.js.cors-any-origin-credentials
app.use(cors({ origin: true, credentials: true }));
// ok: glv.js.cors-any-origin-credentials
app.use(cors({ origin: ["https://shop.example.com"], credentials: true }));

// ruleid: glv.js.weak-password-hash
const h = crypto.createHash("md5").update(password).digest("hex");
// ok: glv.js.weak-password-hash
const etag = crypto.createHash("md5").update(body).digest("hex");
