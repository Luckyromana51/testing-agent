import { useMemo, useState } from "react";
import type { ProductType, Schedule } from "../../../src/types.ts";
import { api, type Meta, type TargetFields, type Upload } from "../api.ts";
import { go } from "../lib.ts";
import { Icon } from "../ui.tsx";
import { LOGIN_QUESTION, LoginFields, loginKind, type LoginDraft } from "./LoginFields.tsx";
import { ToolTabs, toolChoices, toolDraft, type ToolDraft } from "./ToolTabs.tsx";

/** First screen: what kind of product do you want to test? */
export function Home({ meta }: { meta: Meta }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">New test</div>
          <h1>What do you want to test?</h1>
          <p className="muted">Pick the kind of product. Each one gets its own team of specialist agents.</p>
        </div>
      </div>
      <div className="product-grid">
        {meta.products.map((p) => (
          <button
            key={p.type}
            className={`product-card ${p.available ? "" : "soon"}`}
            onClick={() => p.available && go(`#/new/${p.type}`)}
            disabled={!p.available}
          >
            <div className="product-top">
              <span className={`product-icon pi-${p.type}`}>
                <Icon name={p.type} size={22} />
              </span>
              {!p.available && <span className="badge">Coming soon</span>}
            </div>
            <div className="product-name">{p.name}</div>
            <div className="product-desc">{p.description}</div>
            <ul className="product-tests">
              {p.tests.slice(0, 4).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Picks a file and uploads it straight away, showing progress. */
export function FilePicker({
  accept,
  label,
  hint,
  value,
  onChange,
}: {
  accept: string;
  label: string;
  hint: string;
  value: Upload | null;
  onChange: (u: Upload | null) => void;
}) {
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState("");
  async function pick(file: File | undefined) {
    if (!file) return;
    setError("");
    setPct(0);
    onChange(null);
    try {
      onChange(await api.upload(file, setPct));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPct(null);
    }
  }
  return (
    <div className="form-field">
      <span>{label}</span>
      <label className={`file-drop ${value ? "has-file" : ""}`}>
        <input type="file" accept={accept} onChange={(e) => pick(e.target.files?.[0])} />
        <Icon name="upload" size={20} />
        {pct !== null ? (
          <span>Uploading… {pct}%</span>
        ) : value ? (
          <span>
            <strong>{value.fileName}</strong>{value.size ? ` · ${value.size < 1e6 ? `${Math.max(1, Math.round(value.size / 1e3))} KB` : `${(value.size / 1e6).toFixed(1)} MB`}` : ""} · <u>change</u>
          </span>
        ) : (
          <span>
            <strong>Choose a file</strong> <span className="muted">{hint}</span>
          </span>
        )}
      </label>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

const WEB_TYPES: ProductType[] = ["website", "ecommerce", "webapp", "saas", "crm"];

/** Second screen: the details for the chosen product type. */
export function NewProject({ meta, type }: { meta: Meta; type: ProductType }) {
  const product = meta.products.find((p) => p.type === type);
  const [url, setUrl] = useState("");
  const [specUrl, setSpecUrl] = useState("");
  const [apiKind, setApiKind] = useState<"rest" | "graphql">("rest");
  const [graphqlUrl, setGraphqlUrl] = useState("");
  const [testServer, setTestServer] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [name, setName] = useState("");
  const [maxPages, setMaxPages] = useState(meta.defaultMaxPages);
  const [schedule, setSchedule] = useState<Schedule>("off");
  const [checkLinks, setCheckLinks] = useState(true);
  const [withLogin, setWithLogin] = useState(false);
  const [login, setLogin] = useState<LoginDraft>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<ToolDraft>(() => toolDraft(meta, type));
  const isWeb = WEB_TYPES.includes(type);
  const agents = useMemo(
    () => meta.agents.filter((a) => a.products.includes(type) && a.enabled && (checkLinks || a.id !== "web.links")),
    [meta, type, checkLinks],
  );

  if (!product || !product.available) {
    return (
      <div className="page">
        <a href="#/" className="back">
          ← All product types
        </a>
        <h1>{product?.name ?? "Unknown product"}</h1>
        <p className="muted">Testing for this product type is coming in a later update.</p>
      </div>
    );
  }

  const file = upload ? { file: upload.file, fileName: upload.fileName } : {};
  const fields: TargetFields = isWeb
    ? { url, maxPages, checkLinks }
    : type === "api"
      ? apiKind === "graphql"
        ? { graphqlUrl, testServer }
        : { specUrl: specUrl || undefined, url: url || undefined, testServer, ...file }
      : type === "code"
        ? { repoUrl: repoUrl || undefined, branch: branch || undefined, ...file }
        : file;
  const ready = isWeb ? Boolean(url) : type === "api" ? (apiKind === "graphql" ? Boolean(graphqlUrl) : Boolean(specUrl || upload || url)) : type === "code" ? Boolean(repoUrl || upload) : Boolean(upload);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const kind = loginKind(type);
      const { run } = await api.createProject({
        name,
        type,
        schedule,
        tools: toolChoices(meta, tools),
        ...fields,
        ...(withLogin && kind ? { login: { ...login, kind } } : {}),
      });
      go(`#/run/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const isApp = type === "saas" || type === "crm" || type === "webapp";
  return (
    <div className="page narrow">
      <a href="#/" className="back">
        ← All product types
      </a>
      <div className="page-head">
        <span className={`product-icon big pi-${type}`}>
          <Icon name={type} size={26} />
        </span>
        <div className="grow">
          <div className="eyebrow">New {product.name.toLowerCase()} test</div>
          <h1>{product.name}</h1>
          <p className="muted">{product.description}</p>
        </div>
      </div>

      <form className="card form" onSubmit={submit}>
        {isWeb && (
          <label className="form-field">
            <span>{isApp ? "App address (opens in a real cloud browser)" : "Website address"}</span>
            <input
              className="input"
              placeholder={type === "ecommerce" ? "https://shop.example.com" : "https://example.com"}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              autoFocus
            />
          </label>
        )}

        {type === "api" && (
          <>
            <div className="tabs" role="tablist" aria-label="Kind of API">
              <button type="button" role="tab" aria-selected={apiKind === "rest"} className={apiKind === "rest" ? "active" : ""} onClick={() => setApiKind("rest")}>
                REST API
              </button>
              <button type="button" role="tab" aria-selected={apiKind === "graphql"} className={apiKind === "graphql" ? "active" : ""} onClick={() => setApiKind("graphql")}>
                GraphQL
              </button>
            </div>
            {apiKind === "graphql" ? (
              <label className="form-field">
                <span>GraphQL address</span>
                <input className="input" placeholder="https://api.example.com/graphql" value={graphqlUrl} onChange={(e) => setGraphqlUrl(e.target.value)} required autoFocus />
              </label>
            ) : (
              <>
                <label className="form-field">
                  <span>Address of the OpenAPI (Swagger) file</span>
                  <input
                    className="input"
                    placeholder="https://api.example.com/openapi.json"
                    value={specUrl}
                    onChange={(e) => setSpecUrl(e.target.value)}
                    autoFocus
                  />
                </label>
                <div className="or">or</div>
                <FilePicker
                  accept=".json,.yaml,.yml,.har,.txt"
                  label="Upload the API file"
                  hint="OpenAPI 3 or Swagger 2, a Postman collection, a HAR file from Chrome, or cURL commands in a .txt"
                  value={upload}
                  onChange={setUpload}
                />
                <label className="form-field">
                  <span>API base address {specUrl || upload ? "(optional)" : "(the test looks for the API file there)"}</span>
                  <input className="input" placeholder={specUrl || upload ? "Taken from the file's servers list" : "https://api.example.com"} value={url} onChange={(e) => setUrl(e.target.value)} />
                </label>
              </>
            )}
            <label className="check">
              <input type="checkbox" checked={testServer} onChange={(e) => setTestServer(e.target.checked)} />
              <span>
                This is a <b>test server</b>: the test may create, change and delete records (it deletes what it made)
              </span>
            </label>
            <div className="note">
              {testServer
                ? "POST, PUT, PATCH and DELETE endpoints are tested too: a record of each kind is created from the file's example, read back, changed and deleted, with mass assignment and input checks. Never tick this for a live server."
                : apiKind === "graphql"
                  ? "Only queries are sent, made from the schema. Mutations are counted but never sent."
                  : "Only read-only GET requests are sent. Operations that change data (POST, PUT, PATCH, DELETE) are counted but never called."}
            </div>
          </>
        )}

        {type === "code" && (
          <>
            <div className="form-row">
              <label className="form-field grow">
                <span>Git repository (https)</span>
                <input
                  className="input"
                  placeholder="https://github.com/company/project"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  autoFocus
                />
              </label>
              <label className="form-field">
                <span>Branch (optional)</span>
                <input className="input" placeholder="main" value={branch} onChange={(e) => setBranch(e.target.value)} />
              </label>
            </div>
            <div className="or">or</div>
            <FilePicker accept=".zip" label="Upload a zip of the code" hint="up to 300 MB; node_modules and vendor are skipped" value={upload} onChange={setUpload} />
            <div className="note">
              The code is read on GLV's server and deleted after the test. Package names and versions are looked up in the free OSV database
              (osv.dev).
            </div>
          </>
        )}

        {type === "android" && (
          <>
            <FilePicker accept=".apk" label="The app's APK file" hint="the release build you would upload to Play" value={upload} onChange={setUpload} />
            <div className="note">
              The app is unpacked and read on GLV's server; it is never installed or run. For an app bundle (.aab),
              upload a universal APK made with bundletool.
            </div>
          </>
        )}

        {type === "ios" && (
          <>
            <FilePicker accept=".ipa,.zip" label="The app's IPA file" hint="exported from Xcode (Development or Ad Hoc), or a zip of the .app" value={upload} onChange={setUpload} />
            <div className="note">
              The app is unpacked and read on GLV's server; it is never installed or run. An IPA downloaded from the App Store has
              its code encrypted, so export one from Xcode's Organizer for a full test.
            </div>
          </>
        )}

        <label className="form-field">
          <span>Project name (optional)</span>
          <input className="input" placeholder="Client or product name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="form-row">
          {isWeb && (
            <label className="form-field">
              <span>Pages to test</span>
              <input
                className="input"
                type="number"
                min={1}
                max={200}
                value={maxPages}
                onChange={(e) => setMaxPages(Number(e.target.value))}
              />
            </label>
          )}
          <label className="form-field">
            <span>Re-test automatically</span>
            <select className="input" value={schedule} onChange={(e) => setSchedule(e.target.value as Schedule)}>
              <option value="off">Only when I ask</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </select>
          </label>
        </div>
        {isWeb && (
          <label className="check dark">
            <input type="checkbox" checked={checkLinks} onChange={(e) => setCheckLinks(e.target.checked)} /> Check every
            link, including links to other websites
          </label>
        )}
        {loginKind(type) && (
          <div className="login-section">
            <label className="check dark">
              <input type="checkbox" checked={withLogin} onChange={(e) => setWithLogin(e.target.checked)} />{" "}
              {LOGIN_QUESTION[loginKind(type)!]}
            </label>
            {withLogin && <LoginFields kind={loginKind(type)!} value={login} onChange={setLogin} />}
          </div>
        )}
        <div className="form-field">
          <span>What runs in this test</span>
          <ToolTabs meta={meta} type={type} agents={agents} draft={tools} onChange={setTools} />
        </div>
        <div className="form-actions">
          <button className="btn primary" disabled={busy || !ready}>
            {busy ? "Starting…" : startLabel(agents.length, toolChoices(meta, tools).length)}
          </button>
          {error && <div className="error">{error}</div>}
        </div>
      </form>
    </div>
  );
}

function startLabel(agents: number, tools: number): string {
  return `Start testing with ${agents} agents${tools ? ` and ${tools} tool${tools === 1 ? "" : "s"}` : ""}`;
}
