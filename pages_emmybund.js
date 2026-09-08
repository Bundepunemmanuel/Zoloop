import { useEffect, useState } from "react";
import Head from "next/head";
import { supabase } from "../supabase";
import { logError, logWarn } from "../lib/logger";

// Deliberately NOT linked from Header.js, the footer, or anywhere else
// in the UI — reachable only by typing/bookmarking it directly.
// `noindex, nofollow` keeps it out of search engines too. Neither of
// those is real security on its own; the actual gate is the Supabase
// login + email allowlist enforced server-side in pages/api/admin.js
// via lib/requireAdmin.js — this page re-checks the same way so the UI
// never shows admin data it couldn't also legitimately fetch.

async function authedFetch(path, options = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return fetch(path, { ...options, headers });
}

function LoginForm({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("loading");
    setError(null);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;
      onSignedIn(data.session);
    } catch (err) {
      logWarn("emmybund.LoginForm", "Sign-in failed", { error: err?.message });
      setStatus("error");
      setError("Couldn't sign in — check your email and password.");
    }
  }

  return (
    <div className="mx-auto max-w-sm px-5 py-16">
      <h1 className="font-display text-xl uppercase tracking-wide">Admin</h1>
      <p className="mt-1 font-mono text-xs text-grayText">Sign in to continue.</p>
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="username"
          className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-ink outline-none placeholder:text-grayText"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-ink outline-none placeholder:text-grayText"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="rounded-lg bg-ink px-4 py-2.5 font-display text-[11px] uppercase tracking-wide text-white disabled:opacity-60"
        >
          {status === "loading" ? "Signing in…" : "Sign in"}
        </button>
        {error && <div className="font-mono text-[10px] text-cornerA">{error}</div>}
      </form>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase text-grayText">{label}</div>
      <div className="mt-0.5 font-display text-xl">{value}</div>
    </div>
  );
}

function OverviewTab() {
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState(null);
  const [fraud, setFraud] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    Promise.all([
      authedFetch("/api/admin?action=stats").then((r) => r.json()),
      authedFetch("/api/admin?action=activity").then((r) => r.json()),
      authedFetch("/api/admin?action=fraud").then((r) => r.json()),
    ])
      .then(([s, a, f]) => {
        setStats(s);
        setActivity(a);
        setFraud(f);
      })
      .catch((err) => {
        logError("emmybund.OverviewTab.load", err);
        setLoadError("Couldn't load the overview.");
      });
  }, []);

  if (loadError) return <p className="font-mono text-xs text-cornerA">{loadError}</p>;
  if (!stats) return <p className="font-mono text-xs text-grayText">Loading…</p>;

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="Products" value={stats.productCount} />
        <StatCard label="Battles" value={stats.battleCount} />
        <StatCard label="Live now" value={stats.liveBattleCount} />
        <StatCard label="Votes today" value={stats.votesToday} />
      </div>
      {stats.topCategory && (
        <p className="mt-2 font-mono text-[10px] text-grayText">
          Top category: <span className="font-bold text-ink">{stats.topCategory.name}</span>{" "}
          ({stats.topCategory.count} products)
        </p>
      )}

      {fraud?.flagged?.length > 0 && (
        <div className="mt-6">
          <h3 className="font-display text-xs uppercase tracking-wide text-cornerA">
            Fraud signal — last 24h
          </h3>
          <p className="mt-1 font-mono text-[10px] text-grayText">
            IPs behind {fraud.threshold}+ distinct voter cookies. A lead, not proof.
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {fraud.flagged.map((f) => (
              <div
                key={f.ipHash}
                className="flex items-center justify-between rounded-lg border border-cornerA bg-cornerADim px-3 py-2 font-mono text-[10px] text-paper"
              >
                <span className="truncate">{f.ipHash.slice(0, 16)}…</span>
                <span>
                  {f.distinctVoters} voters · {f.distinctBattles} battles
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activity && (
        <div className="mt-6">
          <h3 className="font-display text-xs uppercase tracking-wide">Recent activity</h3>
          <div className="mt-2 flex flex-col gap-1.5">
            {activity.recentBattles.map((b) => (
              <div key={`b-${b.id}`} className="font-mono text-[10px] text-grayText">
                <span className="text-ink">New battle</span> — {b.question || b.slug}
                {b.created_by === "admin" && <span className="text-cornerA"> · ZOLOOP PICK</span>}
              </div>
            ))}
            {activity.recentProducts.map((p) => (
              <div key={`p-${p.id}`} className="font-mono text-[10px] text-grayText">
                <span className="text-ink">New product</span> — {p.name}
              </div>
            ))}
            {activity.recentVotes.slice(0, 5).map((v) => (
              <div key={`v-${v.id}`} className="font-mono text-[10px] text-grayText">
                <span className="text-ink">Vote</span> — {v.product?.name} in {v.battle?.slug}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RatingHistory({ productId }) {
  const [history, setHistory] = useState(null);
  useEffect(() => {
    authedFetch(`/api/admin?action=rating-history&productId=${productId}`)
      .then((r) => r.json())
      .then((body) => setHistory(body.history || []))
      .catch((err) => logError("emmybund.RatingHistory.load", err, { productId }));
  }, [productId]);

  if (!history) return <p className="font-mono text-[10px] text-grayText">Loading…</p>;
  if (history.length === 0)
    return <p className="font-mono text-[10px] text-grayText">No history yet.</p>;

  return (
    <div className="flex flex-col gap-1">
      {history.map((h) => (
        <div key={h.id} className="flex justify-between font-mono text-[10px] text-grayText">
          <span>{new Date(h.created_at).toLocaleString()}</span>
          <span className="text-ink">
            {h.rating} {h.battle_id === null && "(manual)"}
          </span>
        </div>
      ))}
    </div>
  );
}

function ProductRow({ product, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [ratingDraft, setRatingDraft] = useState(product.rating ?? 0);
  const [clicksBoostDraft, setClicksBoostDraft] = useState(product.clicks_boost ?? 0);
  const [nameDraft, setNameDraft] = useState(product.name ?? "");
  const [descDraft, setDescDraft] = useState(product.description ?? "");
  const [websiteDraft, setWebsiteDraft] = useState(product.website_url ?? "");
  const [logoDraft, setLogoDraft] = useState(product.logo_url ?? "");
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  async function save(type, body, onOk) {
    setSaving(type);
    setError(null);
    try {
      const res = await authedFetch("/api/admin", {
        method: "POST",
        body: JSON.stringify({ type, productId: product.id, ...body }),
      });
      const respBody = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(respBody.error || "Save failed");
      onOk(respBody.product);
    } catch (err) {
      logError("emmybund.ProductRow.save", err, { type, productId: product.id });
      setError(err.message);
    } finally {
      setSaving(null);
    }
  }

  const realClicks = product.clicks ?? 0;
  const boostClicks = product.clicks_boost ?? 0;

  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-paper font-display text-xs">
          {product.logo_url ? (
            <img src={product.logo_url} alt="" className="h-full w-full object-cover" />
          ) : (
            product.name[0]
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-bold">{product.name}</span>
            {product.status === "suspended" && (
              <span className="shrink-0 rounded-full bg-cornerA px-1.5 py-0.5 font-mono text-[9px] text-white">
                SUSPENDED
              </span>
            )}
          </div>
          <div className="font-mono text-[10px] text-grayText">
            {(product.wins ?? 0)}W – {(product.losses ?? 0)}L ·{" "}
            {(realClicks + boostClicks).toLocaleString()} clicks
            {boostClicks > 0 && ` (${realClicks} real + ${boostClicks} boost)`}
          </div>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 font-mono text-[10px] text-grayText hover:text-cornerA"
        >
          {expanded ? "Close" : "Edit"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={ratingDraft}
              onChange={(e) => setRatingDraft(e.target.value)}
              className="w-24 rounded-lg border border-line bg-paper px-2 py-1.5 text-right font-mono text-sm outline-none"
            />
            <span className="font-mono text-[10px] text-grayText">rating</span>
            <button
              onClick={() =>
                save("product-rating", { rating: ratingDraft }, (p) =>
                  onChanged({ ...product, rating: p.rating })
                )
              }
              disabled={saving === "product-rating"}
              className="ml-auto rounded-lg bg-cornerB px-3 py-1.5 font-mono text-[10px] font-bold text-white disabled:opacity-60"
            >
              Save
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="number"
              value={clicksBoostDraft}
              onChange={(e) => setClicksBoostDraft(e.target.value)}
              className="w-24 rounded-lg border border-line bg-paper px-2 py-1.5 text-right font-mono text-sm outline-none"
            />
            <span className="font-mono text-[10px] text-grayText">
              clicks boost (real: {realClicks})
            </span>
            <button
              onClick={() =>
                save("product-clicks-boost", { clicksBoost: clicksBoostDraft }, (p) =>
                  onChanged({ ...product, clicks_boost: p.clicks_boost })
                )
              }
              disabled={saving === "product-clicks-boost"}
              className="ml-auto rounded-lg bg-cornerB px-3 py-1.5 font-mono text-[10px] font-bold text-white disabled:opacity-60"
            >
              Save
            </button>
          </div>

          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="Name"
            className="w-full rounded-lg border border-line bg-paper px-2 py-1.5 text-sm outline-none"
          />
          <textarea
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value.slice(0, 280))}
            placeholder="Description"
            rows={2}
            className="w-full resize-none rounded-lg border border-line bg-paper px-2 py-1.5 text-sm outline-none"
          />
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-paper font-display text-xs">
              {logoDraft ? (
                <img
                  src={logoDraft}
                  alt=""
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : (
                (nameDraft || product.name)[0]
              )}
            </div>
            <input
              value={logoDraft}
              onChange={(e) => setLogoDraft(e.target.value)}
              placeholder="Logo image URL (paste a direct link — leave blank for letter avatar)"
              className="w-full rounded-lg border border-line bg-paper px-2 py-1.5 text-sm outline-none"
            />
          </div>
          <input
            value={websiteDraft}
            onChange={(e) => setWebsiteDraft(e.target.value)}
            placeholder="Website URL"
            className="w-full rounded-lg border border-line bg-paper px-2 py-1.5 text-sm outline-none"
          />
          <button
            onClick={() =>
              save(
                "product-details",
                { name: nameDraft, description: descDraft, websiteUrl: websiteDraft, logoUrl: logoDraft },
                (p) => onChanged({ ...product, ...p })
              )
            }
            disabled={saving === "product-details"}
            className="self-start rounded-lg border border-line bg-white px-3 py-1.5 font-mono text-[10px] font-bold hover:border-cornerA disabled:opacity-60"
          >
            Save details
          </button>

          <button
            onClick={() =>
              save(
                "product-status",
                { status: product.status === "suspended" ? "active" : "suspended" },
                (p) => onChanged({ ...product, status: p.status })
              )
            }
            disabled={saving === "product-status"}
            className={`self-start rounded-lg px-3 py-1.5 font-mono text-[10px] font-bold text-white disabled:opacity-60 ${
              product.status === "suspended" ? "bg-cornerB" : "bg-cornerA"
            }`}
          >
            {product.status === "suspended" ? "Reactivate" : "Suspend"}
          </button>

          <details>
            <summary className="cursor-pointer font-mono text-[10px] uppercase text-grayText">
              Rating history
            </summary>
            <div className="mt-2">
              <RatingHistory productId={product.id} />
            </div>
          </details>

          {error && <div className="font-mono text-[10px] text-cornerA">{error}</div>}
        </div>
      )}
    </div>
  );
}

function ProductsEditor() {
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState("top-rated");
  const [products, setProducts] = useState([]);
  const [loadError, setLoadError] = useState(null);

  async function load() {
    try {
      const params = new URLSearchParams({ action: "products", q, status: statusFilter, sort });
      const res = await authedFetch(`/api/admin?${params.toString()}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to load products");
      setProducts(body.products || []);
      setLoadError(null);
    } catch (err) {
      logError("emmybund.ProductsEditor.load", err, { q, statusFilter, sort });
      setLoadError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, sort]);

  function updateProduct(updated) {
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="Search products…"
          className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none placeholder:text-grayText"
        />
        <button
          onClick={load}
          className="shrink-0 rounded-lg border border-line bg-white px-3 py-2 text-xs font-bold hover:border-cornerA"
        >
          Search
        </button>
      </div>
      <div className="mt-2 flex gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-[10px] outline-none"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-[10px] outline-none"
        >
          <option value="top-rated">Top rated</option>
          <option value="newest">Newest</option>
          <option value="clicks">Most clicks</option>
        </select>
      </div>

      {loadError && <div className="mt-3 font-mono text-[10px] text-cornerA">{loadError}</div>}

      <div className="mt-4 flex flex-col gap-2">
        {products.map((p) => (
          <ProductRow key={p.id} product={p} onChanged={updateProduct} />
        ))}
        {products.length === 0 && !loadError && (
          <p className="py-6 text-center font-mono text-xs text-grayText">No products found.</p>
        )}
      </div>
    </div>
  );
}

function ProductPicker({ label, onPick, picked }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      authedFetch(`/api/admin?action=products&q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((body) => setResults(body.products || []))
        .catch((err) => logError("emmybund.ProductPicker.search", err, { q }));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  if (picked) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-line bg-paper px-3 py-2">
        <span className="text-sm font-bold">{picked.name}</span>
        <button
          onClick={() => onPick(null)}
          className="font-mono text-[10px] text-grayText hover:text-cornerA"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={label}
        className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none placeholder:text-grayText"
      />
      {results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-line bg-white shadow-md">
          {results.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                onPick(p);
                setQ("");
                setResults([]);
              }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-paper"
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateBattleForm({ onCreated }) {
  const [productA, setProductA] = useState(null);
  const [productB, setProductB] = useState(null);
  const [duration, setDuration] = useState("24h");
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  async function handleCreate() {
    if (!productA || !productB) {
      setError("Pick both products first.");
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const res = await authedFetch("/api/admin", {
        method: "POST",
        body: JSON.stringify({
          type: "battle-create",
          productAId: productA.id,
          productBId: productB.id,
          duration,
          question: question.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not create battle");
      setProductA(null);
      setProductB(null);
      setQuestion("");
      setStatus("idle");
      onCreated();
    } catch (err) {
      logError("emmybund.CreateBattleForm.handleCreate", err);
      setStatus("error");
      setError(err.message);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-white p-3">
      <div className="font-mono text-[10px] uppercase text-grayText">
        Create a battle — tagged ZOLOOP PICK
      </div>
      <div className="mt-2 flex flex-col gap-2">
        <ProductPicker label="Product A" picked={productA} onPick={setProductA} />
        <ProductPicker label="Product B" picked={productB} onPick={setProductB} />
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Question (leave blank to let Gemini write one)"
          className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none placeholder:text-grayText"
        />
        <select
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          className="w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs outline-none"
        >
          <option value="1h">1 hour</option>
          <option value="24h">24 hours</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
        </select>
        <button
          onClick={handleCreate}
          disabled={status === "loading"}
          className="rounded-lg bg-ink px-4 py-2.5 font-display text-[11px] uppercase tracking-wide text-white disabled:opacity-60"
        >
          {status === "loading" ? "Creating…" : "Create battle"}
        </button>
        {error && <div className="font-mono text-[10px] text-cornerA">{error}</div>}
      </div>
    </div>
  );
}

function BattleRow({ battle, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [questionDraft, setQuestionDraft] = useState(battle.question ?? "");
  const [boostADraft, setBoostADraft] = useState(battle.votes_a_boost ?? 0);
  const [boostBDraft, setBoostBDraft] = useState(battle.votes_b_boost ?? 0);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  async function save(type, body, onOk) {
    setSaving(type);
    setError(null);
    try {
      const res = await authedFetch("/api/admin", {
        method: "POST",
        body: JSON.stringify({ type, battleId: battle.id, ...body }),
      });
      const respBody = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(respBody.error || "Save failed");
      onOk(respBody.battle);
    } catch (err) {
      logError("emmybund.BattleRow.save", err, { type, battleId: battle.id });
      setError(err.message);
    } finally {
      setSaving(null);
    }
  }

  const realA = battle.votes_a ?? 0;
  const realB = battle.votes_b ?? 0;
  const boostA = battle.votes_a_boost ?? 0;
  const boostB = battle.votes_b_boost ?? 0;

  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">
            {battle.product_a?.name} <span className="font-normal text-grayText">vs</span>{" "}
            {battle.product_b?.name}
            {battle.created_by === "admin" && (
              <span className="ml-1.5 font-mono text-[9px] text-cornerA">ZOLOOP PICK</span>
            )}
          </div>
          {battle.question && (
            <div className="truncate font-mono text-[10px] text-grayText">{battle.question}</div>
          )}
          <div className="font-mono text-[10px] text-grayText">
            {(realA + boostA).toLocaleString()} – {(realB + boostB).toLocaleString()} votes
            {(boostA > 0 || boostB > 0) &&
              ` (real ${realA}–${realB}, boost ${boostA}–${boostB})`}{" "}
            · {battle.status}
          </div>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 font-mono text-[10px] text-grayText hover:text-cornerA"
        >
          {expanded ? "Close" : "Edit"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={boostADraft}
              onChange={(e) => setBoostADraft(e.target.value)}
              className="w-20 rounded-lg border border-line bg-paper px-2 py-1.5 text-right font-mono text-sm outline-none"
            />
            <span className="font-mono text-[10px] text-grayText">boost A (real {realA})</span>
            <input
              type="number"
              value={boostBDraft}
              onChange={(e) => setBoostBDraft(e.target.value)}
              className="w-20 rounded-lg border border-line bg-paper px-2 py-1.5 text-right font-mono text-sm outline-none"
            />
            <span className="font-mono text-[10px] text-grayText">boost B (real {realB})</span>
            <button
              onClick={() =>
                save(
                  "battle-votes-boost",
                  { votesABoost: boostADraft, votesBBoost: boostBDraft },
                  (b) => onChanged({ ...battle, votes_a_boost: b.votes_a_boost, votes_b_boost: b.votes_b_boost })
                )
              }
              disabled={saving === "battle-votes-boost"}
              className="ml-auto rounded-lg bg-cornerB px-3 py-1.5 font-mono text-[10px] font-bold text-white disabled:opacity-60"
            >
              Save
            </button>
          </div>

          <input
            value={questionDraft}
            onChange={(e) => setQuestionDraft(e.target.value)}
            className="w-full rounded-lg border border-line bg-paper px-2 py-1.5 text-sm outline-none"
          />
          <button
            onClick={() =>
              save("battle-edit", { question: questionDraft }, (b) =>
                onChanged({ ...battle, question: b.question })
              )
            }
            disabled={saving === "battle-edit"}
            className="self-start rounded-lg border border-line bg-white px-3 py-1.5 font-mono text-[10px] font-bold hover:border-cornerA disabled:opacity-60"
          >
            Save question
          </button>

          {battle.status !== "cancelled" && (
            <button
              onClick={() =>
                save("battle-edit", { status: "cancelled" }, (b) =>
                  onChanged({ ...battle, status: b.status })
                )
              }
              disabled={saving === "battle-edit"}
              className="self-start rounded-lg bg-cornerA px-3 py-1.5 font-mono text-[10px] font-bold text-white disabled:opacity-60"
            >
              Cancel battle
            </button>
          )}

          {error && <div className="font-mono text-[10px] text-cornerA">{error}</div>}
        </div>
      )}
    </div>
  );
}

function BattlesEditor() {
  const [battles, setBattles] = useState([]);
  const [statusFilter, setStatusFilter] = useState("live");
  const [loadError, setLoadError] = useState(null);

  async function load() {
    try {
      const res = await authedFetch(`/api/admin?action=battles&status=${statusFilter}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to load battles");
      setBattles(body.battles || []);
      setLoadError(null);
    } catch (err) {
      logError("emmybund.BattlesEditor.load", err);
      setLoadError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  function updateBattle(updated) {
    setBattles((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
  }

  return (
    <div>
      <CreateBattleForm onCreated={load} />

      <div className="mt-4 flex gap-2">
        {["live", "completed", "cancelled"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-full border px-3 py-1.5 text-xs font-bold capitalize ${
              statusFilter === s
                ? "border-cornerA bg-cornerA text-white"
                : "border-line bg-white text-ink"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {loadError && <div className="mt-3 font-mono text-[10px] text-cornerA">{loadError}</div>}

      <div className="mt-3 flex flex-col gap-2">
        {battles.map((b) => (
          <BattleRow key={b.id} battle={b} onChanged={updateBattle} />
        ))}
        {battles.length === 0 && !loadError && (
          <p className="py-6 text-center font-mono text-xs text-grayText">No battles found.</p>
        )}
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [tab, setTab] = useState("overview");
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUnauthorized(false);
    });
    return () => listener?.subscription?.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    authedFetch("/api/admin?action=products")
      .then((res) => {
        if (res.status === 403) {
          setUnauthorized(true);
          supabase.auth.signOut();
        }
      })
      .catch((err) => logError("emmybund.checkAuthorized", err));
  }, [session]);

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "products", label: "Products" },
    { id: "battles", label: "Battles" },
  ];

  return (
    <>
      <Head>
        <meta name="robots" content="noindex, nofollow" />
        <title>Admin</title>
      </Head>
      <div className="mx-auto max-w-2xl px-5 pb-16">
        {session === undefined ? null : !session ? (
          <LoginForm onSignedIn={setSession} />
        ) : unauthorized ? (
          <div className="mx-auto max-w-sm py-16 text-center">
            <h1 className="font-display text-xl uppercase tracking-wide">Not authorized</h1>
            <p className="mt-2 font-mono text-xs text-grayText">
              This account isn't on the admin list.
            </p>
          </div>
        ) : (
          <div className="pt-8">
            <div className="flex items-center justify-between">
              <h1 className="font-display text-xl uppercase tracking-wide">Admin</h1>
              <button
                onClick={() => supabase.auth.signOut()}
                className="font-mono text-[10px] text-grayText hover:text-cornerA"
              >
                Sign out
              </button>
            </div>

            <div className="mt-4 flex gap-2">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                    tab === t.id
                      ? "border-cornerA bg-cornerA text-white"
                      : "border-line bg-white text-ink"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="mt-4">
              {tab === "overview" && <OverviewTab />}
              {tab === "products" && <ProductsEditor />}
              {tab === "battles" && <BattlesEditor />}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
