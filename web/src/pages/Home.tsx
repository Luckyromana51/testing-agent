import { useMemo, useState } from "react";
import type { ProductType, Schedule } from "../../../src/types.ts";
import { api, type Meta } from "../api.ts";
import { CATEGORY_LABEL, go } from "../lib.ts";
import { Icon } from "../ui.tsx";

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
              {!p.available && <span className="badge">Next update</span>}
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

/** Second screen: the details for the chosen product type. */
export function NewProject({ meta, type }: { meta: Meta; type: ProductType }) {
  const product = meta.products.find((p) => p.type === type);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [maxPages, setMaxPages] = useState(meta.defaultMaxPages);
  const [schedule, setSchedule] = useState<Schedule>("off");
  const [checkLinks, setCheckLinks] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
        <p className="muted">Testing for this product type is coming in the next update.</p>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { run } = await api.createProject({ name, type, url, maxPages, schedule, checkLinks });
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
        <div>
          <div className="eyebrow">New {product.name.toLowerCase()} test</div>
          <h1>{product.name}</h1>
          <p className="muted">{product.description}</p>
        </div>
      </div>

      <form className="card form" onSubmit={submit}>
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
        <label className="form-field">
          <span>Project name (optional)</span>
          <input className="input" placeholder="Client or product name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="form-row">
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
          <label className="form-field">
            <span>Re-test automatically</span>
            <select className="input" value={schedule} onChange={(e) => setSchedule(e.target.value as Schedule)}>
              <option value="off">Only when I ask</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </select>
          </label>
        </div>
        <label className="check dark">
          <input type="checkbox" checked={checkLinks} onChange={(e) => setCheckLinks(e.target.checked)} /> Check every link,
          including links to other websites
        </label>
        {isApp && (
          <div className="note">
            Pages behind a login are tested in the next update. For now the agents test everything visitors can reach
            without signing in.
          </div>
        )}
        <div className="form-actions">
          <button className="btn primary" disabled={busy}>
            {busy ? "Starting…" : `Start testing with ${agents.length} agents`}
          </button>
          {error && <div className="error">{error}</div>}
        </div>
      </form>

      <h2 className="section-title">Agents on this test</h2>
      <div className="agent-chips">
        {agents.map((a) => (
          <div className="agent-chip" key={a.id} title={a.description}>
            <span className={`cat-dot cat-${a.category}`} />
            {a.name}
            <span className="muted"> · {CATEGORY_LABEL[a.category]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
