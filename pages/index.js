import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../supabase";
import BattleCard from "../BattleCard";
import LeaderboardTable from "../LeaderboardTable";
import Link from "next/link";
import { CategoryIcon } from "../lib/categoryIcons";
import { logError, logWarn } from "../lib/logger";

const MAX_DESCRIPTION_LENGTH = 280;

// Gold/silver/bronze for the Top Live Battles section — kept as the
// traditional medal colors for instant recognizability (the whole point
// of a badge is to read at a glance; a "cool-toned" reinterpretation of
// gold/silver/bronze would undercut that). Tied to CURRENT rank, not to
// any specific battle — since topBattles is recomputed fresh from live
// vote totals on every page load, whichever battle happens to be #1
// right now gets gold; if a different battle overtakes it later, the
// color moves with the rank, not a fixed hardcoded battle.
const TOP_BATTLE_MEDALS = [
  {
    label: "1ST",
    bg: "#E8B84B",
    text: "#4A3A0E",
    theme: { bg: "#FDF3D9", border: "#E8B84B" },
  },
  {
    label: "2ND",
    bg: "#D9DBE0",
    text: "#3A3B44",
    theme: { bg: "#E9EAEF", border: "#AEB1BD" },
  },
  {
    label: "3RD",
    bg: "#E7B27B",
    text: "#4A2E10",
    theme: { bg: "#FBE7D2", border: "#E7B27B" },
  },
];

// Lazily flips any "live" battle whose ends_at has passed to "completed",
// setting winner_id from whichever side has more votes (null if tied).
// No cron job for the MVP — this just runs whenever the homepage loads.
// Winner is decided on real + boost votes together (a boost is meant to
// look identical to an organic vote everywhere public, including here —
// see migration 7 / pages/battle/[slug].js for the fuller explanation).
async function closeExpiredBattles(supabaseClient) {
  const nowIso = new Date().toISOString();
  const { data: expired, error: fetchError } = await supabaseClient
    .from("battles")
    .select("id, votes_a, votes_b, votes_a_boost, votes_b_boost, product_a_id, product_b_id")
    .eq("status", "live")
    .lt("ends_at", nowIso);

  if (fetchError) {
    logError("pages/index.closeExpiredBattles.fetch", fetchError);
    return;
  }
  if (!expired || expired.length === 0) return;

  for (const b of expired) {
    const totalA = (b.votes_a ?? 0) + (b.votes_a_boost ?? 0);
    const totalB = (b.votes_b ?? 0) + (b.votes_b_boost ?? 0);
    const winnerId = totalA === totalB ? null : totalA > totalB ? b.product_a_id : b.product_b_id;
    const { error: updateError } = await supabaseClient
      .from("battles")
      .update({ status: "completed", winner_id: winnerId })
      .eq("id", b.id);
    if (updateError) {
      logError("pages/index.closeExpiredBattles.update", updateError, {
        battleId: b.id,
      });
    }
  }
}

export async function getServerSideProps({ query }) {
  // Safe fallback props returned any time something in here fails, so a
  // Supabase hiccup degrades to an empty-but-working homepage instead of
  // a hard 500. The real cause still gets logged via logError below.
  const fallbackProps = {
    topBattles: [],
    happeningNow: [],
    products: [],
    categories: [],
    activeCategorySlug: null,
    loadError: null,
  };

  try {
    await closeExpiredBattles(supabase);

    const nowIso = new Date().toISOString();
    // Battles created before the duration feature shipped have no
    // ends_at (null) — treat those as never-expiring rather than hiding
    // them.
    const { data: battles, error: battlesError } = await supabase
      .from("battles")
      .select(
        "id, slug, votes_a, votes_b, votes_a_boost, votes_b_boost, status, question, starts_at, ends_at, views, winner_id, clicks, created_by, product_a:product_a_id(id, name, slug, logo_url, category:category_id(name, slug)), product_b:product_b_id(id, name, slug, logo_url, category:category_id(name, slug))"
      )
      .eq("status", "live")
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(15);

    // Boosts folded in right here so every downstream read (hero card,
    // Happening Now ranking, individual card display) sees a single
    // consistent votes_a/votes_b — same pattern as the battle detail
    // page (see pages/battle/[slug].js for the fuller explanation).
    if (battlesError) {
      logError("pages/index.getServerSideProps.battles", battlesError);
    }

    const boostedBattles = (battles ?? []).map((b) => ({
      ...b,
      votes_a: (b.votes_a ?? 0) + (b.votes_a_boost ?? 0),
      votes_b: (b.votes_b ?? 0) + (b.votes_b_boost ?? 0),
    }));

    // No more separate "hero" pick — that used to just be whichever
    // battle was created most recently, which meant a brand new, 0-vote
    // battle could land in the most prominent spot on the page with
    // nothing to show for it. The featured position is now always
    // "Top Battle #1" from the ranking below, same source of truth as
    // the rest of the Top 3.
    //
    // Top 3 are the best-performing LIVE battles by total votes, each
    // featuring a DIFFERENT product on at least one side — once a
    // product appears in an earlier top-3 slot, a later battle
    // involving that same product is skipped, so the same product can't
    // visually dominate all three ranked spots. Whatever's left fills
    // "Happening Now" below, ordered by recency (the query's default
    // order), capped at 10 rows.
    const usedProductIds = new Set();
    const sortedByVotes = [...boostedBattles].sort(
      (a, b) => b.votes_a + b.votes_b - (a.votes_a + a.votes_b)
    );
    const topPerforming = [];
    for (const b of sortedByVotes) {
      if (topPerforming.length >= 3) break;
      if (usedProductIds.has(b.product_a.id) || usedProductIds.has(b.product_b.id)) {
        continue;
      }
      topPerforming.push(b);
      usedProductIds.add(b.product_a.id);
      usedProductIds.add(b.product_b.id);
    }
    const topPerformingIds = new Set(topPerforming.map((b) => b.id));
    const rest = boostedBattles.filter((b) => !topPerformingIds.has(b.id)).slice(0, 10);

    const { data: categories, error: categoriesError } = await supabase
      .from("categories")
      .select("id, name, slug, icon")
      .order("name", { ascending: true });

    if (categoriesError) {
      logError("pages/index.getServerSideProps.categories", categoriesError);
    }

    // Category filter applies to the leaderboard only — a battle pairs two
    // products that can each belong to a different category, so filtering
    // "which battles show" by a single category doesn't map cleanly.
    const activeCategorySlug = query?.category || null;
    const activeCategory = categories?.find(
      (c) => c.slug === activeCategorySlug
    );

    if (activeCategorySlug && !activeCategory) {
      logWarn("pages/index.getServerSideProps", "Unknown category slug in query", {
        activeCategorySlug,
      });
    }

    let productsQuery = supabase
      .from("products")
      .select("id, name, slug, rating, wins, losses, category_id, logo_url, clicks, category:category_id(name, icon, slug)")
      .eq("status", "active")
      .order("rating", { ascending: false })
      .limit(10);

    if (activeCategory) {
      productsQuery = productsQuery.eq("category_id", activeCategory.id);
    }

    const { data: products, error: productsError } = await productsQuery;

    if (productsError) {
      logError("pages/index.getServerSideProps.products", productsError);
    }

    // products.rating exists directly, but "total votes" isn't a stored
    // column — only battles.votes_a/votes_b are. One query, summed in
    // JS: every battle this batch of products appeared in as either
    // side, adding whichever side's vote count belongs to that product.
    let productsWithVotes = products ?? [];
    if (productsWithVotes.length > 0) {
      const productIds = productsWithVotes.map((p) => p.id);
      const { data: voteBattles, error: voteBattlesError } = await supabase
        .from("battles")
        .select("product_a_id, product_b_id, votes_a, votes_b, votes_a_boost, votes_b_boost")
        .or(
          `product_a_id.in.(${productIds.join(",")}),product_b_id.in.(${productIds.join(",")})`
        );

      if (voteBattlesError) {
        logError("pages/index.getServerSideProps.voteBattles", voteBattlesError);
      } else {
        const totals = {};
        for (const b of voteBattles ?? []) {
          if (productIds.includes(b.product_a_id)) {
            totals[b.product_a_id] =
              (totals[b.product_a_id] ?? 0) + (b.votes_a ?? 0) + (b.votes_a_boost ?? 0);
          }
          if (productIds.includes(b.product_b_id)) {
            totals[b.product_b_id] =
              (totals[b.product_b_id] ?? 0) + (b.votes_b ?? 0) + (b.votes_b_boost ?? 0);
          }
        }
        productsWithVotes = productsWithVotes.map((p) => ({
          ...p,
          total_votes: totals[p.id] ?? 0,
        }));
      }
    }

    return {
      props: {
        topBattles: topPerforming,
        happeningNow: rest,
        products: productsWithVotes,
        categories: categories ?? [],
        activeCategorySlug: activeCategorySlug ?? null,
        loadError: null,
      },
    };
  } catch (err) {
    // Anything unexpected (network failure, bad env vars, etc.) lands here.
    logError("pages/index.getServerSideProps", err, { query });
    return {
      props: {
        ...fallbackProps,
        loadError: "We couldn't load the latest battles right now.",
      },
    };
  }
}

export default function Home({
  topBattles,
  happeningNow,
  products,
  categories,
  activeCategorySlug,
  loadError,
}) {
  const router = useRouter();
  // Header's Challenge link navigates here with ?panel=battle instead of
  // showing its own toggle button on the page itself. Categories used to
  // work the same way (?panel=categories) but that panel is gone now —
  // category filtering lives on /battles as a permanent pill row instead.
  const openPanel = router.query.panel === "battle" ? router.query.panel : null;

  return (
    <div className="mx-auto max-w-6xl pb-12">
      {loadError && (
        <div className="mx-5 mt-4 rounded-lg border border-cornerA bg-cornerADim px-4 py-3 font-mono text-xs text-paper md:mx-8">
          {loadError} Please refresh, or check back shortly.
        </div>
      )}

      <ExpandablePanels openPanel={openPanel} categories={categories} />

      <section className="px-5 pt-8 pb-2 text-center md:px-8">
        <h1 className="font-display text-3xl uppercase leading-none tracking-wide md:text-5xl lg:text-6xl">
          The internet picks the winner.
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm text-grayText md:text-base">
          Discover products through real battles. Vote, compare, and
          challenge competitors.
        </p>
      </section>

      {/* Top 1/2/3 by total votes — this REPLACES the old "hero" slot,
      which used to just show whichever battle was created most
      recently (sometimes a brand new, 0-vote battle with nothing to
      show for it). Each is full-size, stacked, never compressed
      side-by-side, with its own medal badge and tint. */}
      {topBattles.length > 0 ? (
        <section className="flex flex-col gap-8 px-5 pt-4 md:px-8">
          {topBattles.map((b, i) => {
            const medal = TOP_BATTLE_MEDALS[i];
            const category = b.product_a?.category || b.product_b?.category || null;
            return (
              <BattleCard
                key={b.id}
                battle={b}
                mode="featured"
                theme={medal.theme}
                badge={{
                  label: medal.label,
                  bg: medal.bg,
                  text: medal.text,
                  extra: category?.slug && (
                    <span className="flex items-center gap-1 border-l border-black/10 pl-1.5">
                      <CategoryIcon slug={category.slug} className="h-3 w-3" />
                      {category.name}
                    </span>
                  ),
                }}
              />
            );
          })}
        </section>
      ) : (
        <p className="mx-5 my-6 text-center font-mono text-sm text-grayText md:mx-8">
          No live battles right now — check back soon.
        </p>
      )}

      {/* "Happening now": a dense, tap-through list (not cards, no
      inline voting) for battles beyond the Top 3 — question + its
      votes/clicks on the left, the two products close together on the
      right with their category underneath, capped at 10 rows. */}
      {happeningNow.length > 0 && (
        <section className="px-5 py-8 md:px-8">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-display text-sm uppercase tracking-wide">
              Happening now
            </h2>
            <Link href="/battles" className="font-mono text-[11px] text-grayText">
              View all
            </Link>
          </div>
          <div className="flex flex-col divide-y divide-line rounded-xl border border-line bg-white shadow-[3px_3px_0_#0B0C10]">
            {happeningNow.map((b) => {
              const total = b.votes_a + b.votes_b;
              const clicks = typeof b.clicks === "number" ? b.clicks : 0;
              const category = b.product_a?.category || b.product_b?.category || null;
              return (
                <Link
                  key={b.id}
                  href={`/battle/${b.slug}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-paper"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-ink">
                      {b.question || `${b.product_a.name} vs ${b.product_b.name}`}
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-grayText">
                      <span className="flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-cornerA" />
                        {total.toLocaleString()} {total === 1 ? "vote" : "votes"}
                      </span>
                      <span>
                        {clicks.toLocaleString()} {clicks === 1 ? "click" : "clicks"}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-center gap-1">
                    <div className="flex items-center">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-paper font-display text-[10px]">
                        {b.product_a.logo_url ? (
                          <img
                            src={b.product_a.logo_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          b.product_a.name[0]
                        )}
                      </div>
                      <div className="-ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-paper font-display text-[10px]">
                        {b.product_b.logo_url ? (
                          <img
                            src={b.product_b.logo_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          b.product_b.name[0]
                        )}
                      </div>
                    </div>
                    {category?.slug && (
                      <div className="flex items-center gap-1 font-mono text-[9px] text-grayText">
                        <CategoryIcon slug={category.slug} className="h-2.5 w-2.5" />
                        {category.name}
                      </div>
                    )}
                  </div>

                  <span className="shrink-0 text-grayText">→</span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      <section className="px-5 md:px-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-sm uppercase tracking-wide">
            Top products
            {activeCategorySlug && (
              <span className="ml-2 font-mono text-[11px] font-normal text-grayText">
                in {categories.find((c) => c.slug === activeCategorySlug)?.name}
              </span>
            )}
          </h2>
          <Link href="/rankings" className="font-mono text-[11px] text-grayText">
            Full ranking →
          </Link>
        </div>
        {products.length === 0 ? (
          <p className="py-6 font-mono text-xs text-grayText">
            No products in this category yet.
          </p>
        ) : (
          <LeaderboardTable products={products} mode="table" />
        )}
      </section>
    </div>
  );
}

// ---------- expandable panel ----------
// Challenge a competitor lives as a link in the header (Header.js),
// routing here with ?panel=battle. This component renders that panel
// inline — never a native <select> or a modal/popup. Categories used to
// be a second panel here (?panel=categories) but that's now a permanent
// scrollable pill row on /battles instead (see pages/battles.js).
function ExpandablePanels({ openPanel, categories }) {
  if (openPanel !== "battle") return null;

  return (
    <section className="border-b border-line bg-white px-5 py-3 md:px-8">
      <StartBattlePanel categories={categories} />
    </section>
  );
}

// ---------- challenge a competitor ----------
// One input, not a multi-step form: "yourproduct.com vs competitor.com".
// No "your product" framing anywhere in the results either — this app
// has no accounts, so nobody actually owns a product listing.
const DURATIONS = [
  { value: "1h", label: "1 Hour" },
  { value: "24h", label: "24 Hours" },
  { value: "7d", label: "7 Days" },
];

function StartBattlePanel({ categories }) {
  const router = useRouter();
  const [combinedInput, setCombinedInput] = useState("");
  const [parseError, setParseError] = useState(null);
  const [sideA, setSideA] = useState(null); // { term, selectedProduct }
  const [sideB, setSideB] = useState(null);
  const [question, setQuestion] = useState("");
  const [questionEdited, setQuestionEdited] = useState(false);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [duration, setDuration] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  // Once both sides are resolved, ask for an AI-generated question
  // grounded in what these two products actually do (see
  // generateBattleQuestion in lib/gemini.js) — never the generic "Which
  // is better?" template unless Gemini genuinely can't produce anything
  // usable. Skipped entirely if the person already started editing it.
  useEffect(() => {
    const productA = sideA?.selectedProduct;
    const productB = sideB?.selectedProduct;
    if (!productA || !productB || questionEdited) return;

    let cancelled = false;
    setQuestionLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({
          action: "suggest-question",
          productAId: productA.id,
          productBId: productB.id,
        });
        const res = await fetch(`/api/submit-product?${params.toString()}`);
        const body = await res.json().catch((parseErr) => {
          logError("StartBattlePanel.suggestQuestion.parseResponse", parseErr);
          return {};
        });
        if (!cancelled) {
          setQuestion(body.question || `Which is better: ${productA.name} or ${productB.name}?`);
        }
      } catch (err) {
        logError("StartBattlePanel.suggestQuestion", err, {
          productAId: productA.id,
          productBId: productB.id,
        });
        if (!cancelled) {
          setQuestion(`Which is better: ${productA.name} or ${productB.name}?`);
        }
      } finally {
        if (!cancelled) setQuestionLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sideA?.selectedProduct, sideB?.selectedProduct, questionEdited]);

  function handleFindMatch(e) {
    e.preventDefault();
    try {
      const parts = combinedInput.split(/\s+vs\.?\s+/i);
      if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
        setParseError('Try: yourproduct.com vs competitor.com');
        return;
      }
      setParseError(null);
      setSideA({ term: parts[0].trim(), selectedProduct: null });
      setSideB({ term: parts[1].trim(), selectedProduct: null });
      setQuestionEdited(false);
    } catch (err) {
      logError("StartBattlePanel.handleFindMatch", err, { combinedInput });
      setParseError("Something went wrong reading that. Try again.");
    }
  }

  function reset() {
    setCombinedInput("");
    setParseError(null);
    setSideA(null);
    setSideB(null);
    setQuestion("");
    setQuestionEdited(false);
    setDuration(null);
    setCreateError(null);
  }

  async function startBattle() {
    const productA = sideA?.selectedProduct;
    const productB = sideB?.selectedProduct;
    if (!productA || !productB || !duration || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          productAId: productA.id,
          productBId: productB.id,
          duration,
          question,
        }),
      });
      const body = await res.json().catch((parseErr) => {
        logError("StartBattlePanel.startBattle.parseResponse", parseErr);
        return {};
      });
      if (!res.ok) throw new Error(body.error || "Could not start battle");
      router.push(`/battle/${body.battle.slug}`);
    } catch (err) {
      logError("StartBattlePanel.startBattle", err, {
        productAId: productA?.id,
        productBId: productB?.id,
        duration,
      });
      setCreateError(err.message || "Something went wrong starting the battle.");
    } finally {
      setCreating(false);
    }
  }

  const bothResolved = sideA?.selectedProduct && sideB?.selectedProduct;

  return (
    <div className="mt-3 rounded-lg border border-line bg-paper p-3">
      {!sideA && !sideB ? (
        <form onSubmit={handleFindMatch} className="flex flex-col gap-2">
          <div className="font-mono text-[10px] uppercase text-grayText">
            Who should your product battle?
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={combinedInput}
              onChange={(e) => setCombinedInput(e.target.value)}
              placeholder="yourproduct.com vs competitor.com"
              className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-ink outline-none placeholder:text-grayText"
            />
            <button
              type="submit"
              className="rounded-lg bg-cornerA px-4 py-2.5 font-display text-xs uppercase tracking-wide text-white"
            >
              Find match
            </button>
          </div>
          {parseError && (
            <div className="font-mono text-[10px] text-cornerA">{parseError}</div>
          )}
        </form>
      ) : (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase text-grayText">
              {combinedInput}
            </div>
            <button
              type="button"
              onClick={reset}
              className="font-mono text-[10px] text-grayText hover:text-cornerA"
            >
              Start over
            </button>
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex-1 min-w-0">
              <ProductSlot
                label="Product A"
                initialTerm={sideA.term}
                selectedProduct={sideA.selectedProduct}
                onSelect={(p) => setSideA({ ...sideA, selectedProduct: p })}
                onClear={() => setSideA({ ...sideA, selectedProduct: null })}
                categories={categories}
                suggestFromProduct={sideB.selectedProduct}
              />
            </div>
            <div className="text-center font-display text-xs text-grayText sm:pt-8">
              VS
            </div>
            <div className="flex-1 min-w-0">
              <ProductSlot
                label="Product B"
                initialTerm={sideB.term}
                selectedProduct={sideB.selectedProduct}
                onSelect={(p) => setSideB({ ...sideB, selectedProduct: p })}
                onClear={() => setSideB({ ...sideB, selectedProduct: null })}
                categories={categories}
                suggestFromProduct={sideA.selectedProduct}
              />
            </div>
          </div>

          {bothResolved && (
            <div className="mt-4 rounded-lg border border-line bg-white p-3">
              <div className="mb-3 text-center text-sm font-bold">
                {sideA.selectedProduct.name} 🆚 {sideB.selectedProduct.name}
              </div>

              <div className="mb-3">
                <div className="mb-1.5 font-mono text-[10px] uppercase text-grayText">
                  Battle question
                </div>
                <input
                  value={question}
                  onChange={(e) => {
                    setQuestion(e.target.value);
                    setQuestionEdited(true);
                  }}
                  className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none"
                />
              </div>

              <div className="mb-3">
                <div className="mb-1.5 text-center font-mono text-[10px] uppercase text-grayText">
                  How long should this battle run?
                </div>
                <div className="flex justify-center gap-2">
                  {DURATIONS.map((d) => (
                    <button
                      type="button"
                      key={d.value}
                      onClick={() => setDuration(d.value)}
                      aria-pressed={duration === d.value}
                      className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition-colors ${
                        duration === d.value
                          ? "border-cornerA bg-cornerA text-white"
                          : "border-line bg-paper text-ink hover:border-cornerA"
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={startBattle}
                disabled={!duration || creating}
                className="w-full rounded-lg bg-cornerA px-4 py-3 font-display text-xs uppercase tracking-wide text-white disabled:opacity-60"
              >
                {creating
                  ? "Starting…"
                  : duration
                  ? "Create Battle"
                  : "Pick a duration to start"}
              </button>
              {createError && (
                <div className="mt-2 text-center font-mono text-[10px] text-cornerA">
                  {createError}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A single "pick a product" slot: pre-searches using the term parsed
// from the combined input, shows results with Select buttons, and offers
// `+ Add "{term}"` to create it inline if nothing matches. Search is
// typo-tolerant (see search_products() in supabase-schema.sql) so
// partial spelling and common misspellings still surface a match.
function ProductSlot({
  label,
  initialTerm,
  selectedProduct,
  onSelect,
  onClear,
  categories,
  suggestFromProduct,
}) {
  const [query, setQuery] = useState(initialTerm || "");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addFormPrefill, setAddFormPrefill] = useState(null); // { name, websiteUrl } | null
  const [hasSearchedInitial, setHasSearchedInitial] = useState(false);
  const [competitors, setCompetitors] = useState(null); // null = not fetched yet
  const [competitorsLoading, setCompetitorsLoading] = useState(false);
  const [competitorsError, setCompetitorsError] = useState(null);
  const abortRef = useRef(null);

  async function runSearch(term) {
    if (abortRef.current) abortRef.current.abort();

    if (!term || term.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(
        `/api/submit-product?q=${encodeURIComponent(term.trim())}`,
        { signal: controller.signal }
      );
      const body = await res.json().catch((parseErr) => {
        logError("ProductSlot.runSearch.parseResponse", parseErr);
        return {};
      });
      if (!res.ok) throw new Error(body.error || "Search failed");
      setResults(body.products || []);
    } catch (err) {
      if (err.name === "AbortError") return;
      logError("ProductSlot.runSearch", err, { term });
      setSearchError("Search failed. Try again.");
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    if (!hasSearchedInitial && initialTerm) {
      setHasSearchedInitial(true);
      runSearch(initialTerm);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTerm, hasSearchedInitial]);

  function handleQueryChange(term) {
    setQuery(term);
    runSearch(term);
  }

  async function fetchCompetitors() {
    if (!suggestFromProduct) return;
    setCompetitorsLoading(true);
    setCompetitorsError(null);
    try {
      const res = await fetch(
        `/api/submit-product?action=suggest-competitors&productId=${suggestFromProduct.id}`
      );
      const body = await res.json().catch((parseErr) => {
        logError("ProductSlot.fetchCompetitors.parseResponse", parseErr);
        return {};
      });
      if (!res.ok) throw new Error(body.error || "Could not load suggestions");
      setCompetitors(body.competitors || []);
    } catch (err) {
      logError("ProductSlot.fetchCompetitors", err, { productId: suggestFromProduct?.id });
      setCompetitorsError("Couldn't load suggestions. Try again.");
      setCompetitors([]);
    } finally {
      setCompetitorsLoading(false);
    }
  }

  function handleAddFromCompetitor(competitor) {
    setAddFormPrefill({ name: competitor.name, websiteUrl: `https://${competitor.domain}` });
    setShowAddForm(true);
  }

  function handleSelect(product) {
    try {
      onSelect(product);
      setShowAddForm(false);
      setAddFormPrefill(null);
    } catch (err) {
      logError("ProductSlot.handleSelect", err, { productId: product?.id });
    }
  }

  if (selectedProduct) {
    return (
      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase text-grayText">
          {label}
        </div>
        <div className="flex items-center justify-between rounded-lg border border-line bg-white px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-paper font-display text-xs">
              {selectedProduct.logo_url ? (
                <img
                  src={selectedProduct.logo_url}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                selectedProduct.name[0]
              )}
            </div>
            <div className="min-w-0 truncate text-sm font-bold">
              {selectedProduct.name}
            </div>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 font-mono text-[11px] text-grayText hover:text-cornerA"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1.5 font-mono text-[10px] uppercase text-grayText">
        {label}
      </div>
      <input
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        placeholder="Search products…"
        className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-ink outline-none placeholder:text-grayText"
      />

      {searching && (
        <div className="mt-1 font-mono text-[10px] text-grayText">Searching…</div>
      )}
      {searchError && (
        <div className="mt-1 font-mono text-[10px] text-cornerA">{searchError}</div>
      )}

      {!searching && results.length > 0 && (
        <div className="mt-2 divide-y divide-line rounded-lg border border-line bg-white">
          {results.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => handleSelect(p)}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-paper"
            >
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-paper font-display text-[10px]">
                  {p.logo_url ? (
                    <img
                      src={p.logo_url}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    p.name[0]
                  )}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold">{p.name}</div>
                  <div className="font-mono text-[10px] text-grayText">
                    {p.category?.name || "Uncategorized"} · {p.rating} rating
                  </div>
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-line px-2.5 py-1 font-mono text-[10px] font-bold">
                Select
              </span>
            </button>
          ))}
        </div>
      )}

      {!searching && query.trim().length >= 2 && results.length === 0 && !searchError && (
        <div className="mt-1 font-mono text-[10px] text-grayText">
          No matches for "{query.trim()}".
        </div>
      )}

      {!showAddForm && (
        <button
          type="button"
          onClick={() => {
            setAddFormPrefill(null);
            setShowAddForm(true);
          }}
          className="mt-2 font-mono text-[11px] font-bold text-cornerB"
        >
          + Add "{query.trim() || "this product"}"
        </button>
      )}

      {showAddForm && (
        <AddProductForm
          initialName={addFormPrefill?.name ?? query.trim()}
          initialWebsiteUrl={addFormPrefill?.websiteUrl}
          categories={categories}
          onCancel={() => {
            setShowAddForm(false);
            setAddFormPrefill(null);
          }}
          onCreated={handleSelect}
        />
      )}

      {/* Gemini-powered — button-triggered only, never automatic. Only
          shown once the OTHER side already has a product to suggest
          against. */}
      {suggestFromProduct && !showAddForm && (
        <div className="mt-4">
          {competitors === null ? (
            <button
              type="button"
              onClick={fetchCompetitors}
              disabled={competitorsLoading}
              className="font-mono text-[11px] font-bold text-cornerA disabled:opacity-60"
            >
              {competitorsLoading ? "Finding competitors…" : "🔍 Suggest competitors"}
            </button>
          ) : (
            <div>
              <div className="mb-2 font-mono text-[10px] uppercase text-grayText">
                🔍 Suggested competitors
              </div>
              {competitorsError && (
                <div className="mb-2 font-mono text-[10px] text-cornerA">{competitorsError}</div>
              )}
              {competitors.length === 0 && !competitorsError && (
                <div className="font-mono text-[10px] text-grayText">
                  No suggestions available.
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {competitors.map((c) =>
                  c.existingProduct ? (
                    <button
                      type="button"
                      key={c.existingProduct.id}
                      onClick={() => handleSelect(c.existingProduct)}
                      className="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-bold hover:border-cornerA"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-paper font-display text-[9px]">
                        {c.existingProduct.logo_url ? (
                          <img
                            src={c.existingProduct.logo_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          c.existingProduct.name[0]
                        )}
                      </span>
                      {c.existingProduct.name}
                      <span className="rounded-full bg-paper px-1.5 py-0.5 text-[9px] text-grayText">
                        on Zoloop
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      key={c.name}
                      onClick={() => handleAddFromCompetitor(c)}
                      className="flex items-center gap-2 rounded-full border border-dashed border-cornerB px-3 py-1.5 text-xs font-bold text-cornerB hover:bg-cornerB hover:text-white"
                    >
                      + Add {c.name}
                    </button>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The inline "+ Add" mini form. Only name, website, and category are
// required — description and logo are optional and auto-filled from the
// website's Open Graph tags server-side if left blank. A manually
// entered description or uploaded logo always overrides auto-fetch.
function AddProductForm({ initialName, initialWebsiteUrl, categories, onCancel, onCreated }) {
  const [name, setName] = useState(initialName || "");
  const [websiteUrl, setWebsiteUrl] = useState(initialWebsiteUrl || "");
  const [categoryId, setCategoryId] = useState("");
  const [categoryAutoSuggested, setCategoryAutoSuggested] = useState(false);
  const [description, setDescription] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState(null);
  const [logoPreview, setLogoPreview] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [message, setMessage] = useState("");

  // Best-effort keyword-based category suggestion (see
  // guessCategorySlug in pages/api/submit-product.js — plain keyword
  // matching, not AI). Only pre-selects if the person hasn't already
  // picked a category themselves; never overrides a manual choice.
  async function handleWebsiteBlur() {
    if (!websiteUrl.trim() || categoryId) return;
    try {
      const res = await fetch(
        `/api/submit-product?action=guess-category&url=${encodeURIComponent(websiteUrl.trim())}`
      );
      const body = await res.json().catch((parseErr) => {
        logError("AddProductForm.handleWebsiteBlur.parseResponse", parseErr);
        return {};
      });
      if (body.category?.id) {
        setCategoryId(body.category.id);
        setCategoryAutoSuggested(true);
      }
    } catch (err) {
      // Never block the form on this — it's a nice-to-have suggestion.
      logError("AddProductForm.handleWebsiteBlur", err, { websiteUrl });
    }
  }

  // If pre-filled from an AI competitor suggestion, there's no blur
  // event to trigger the category guess above — fire it once on mount.
  useEffect(() => {
    if (initialWebsiteUrl) {
      handleWebsiteBlur();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleLogoChange(e) {
    try {
      const file = e.target.files?.[0];
      if (!file) return;

      if (file.type !== "image/png") {
        setStatus("error");
        setMessage("Logo must be a PNG image.");
        logWarn("AddProductForm.handleLogoChange", "Rejected non-PNG file", {
          fileType: file.type,
        });
        return;
      }
      if (file.size > 2_000_000) {
        setStatus("error");
        setMessage("Logo must be smaller than 2MB.");
        logWarn("AddProductForm.handleLogoChange", "Rejected oversized file", {
          fileSize: file.size,
        });
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        setLogoDataUrl(reader.result);
        setLogoPreview(reader.result);
        setStatus("idle");
        setMessage("");
      };
      reader.onerror = () => {
        logError("AddProductForm.handleLogoChange.FileReader", reader.error);
        setStatus("error");
        setMessage("Couldn't read that image file.");
      };
      reader.readAsDataURL(file);
    } catch (err) {
      logError("AddProductForm.handleLogoChange", err);
      setStatus("error");
      setMessage("Something went wrong reading that file.");
    }
  }

  function toggleCategory(id) {
    try {
      setCategoryId((cur) => (cur === id ? "" : id));
      setCategoryAutoSuggested(false);
    } catch (err) {
      logError("AddProductForm.toggleCategory", err, { id });
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !websiteUrl.trim() || !categoryId) {
      setStatus("error");
      setMessage("Product name, website, and category are required.");
      return;
    }

    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/submit-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          websiteUrl,
          categoryId,
          description: description.trim() || undefined,
          logoDataUrl: logoDataUrl || undefined,
        }),
      });
      const body = await res.json().catch((parseErr) => {
        logError("AddProductForm.handleSubmit.parseResponse", parseErr);
        return {};
      });
      if (!res.ok) throw new Error(body.error || "Submission failed");
      onCreated(body.product);
    } catch (err) {
      logError("AddProductForm.handleSubmit", err, {
        name,
        websiteUrl,
        categoryId,
      });
      setStatus("error");
      setMessage(err.message || "Something went wrong. Please try again.");
    }
  }

  const selectedCategory = categories.find((c) => c.id === categoryId);

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-white p-3"
    >
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase text-grayText">
          Add a product
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="font-mono text-[10px] text-grayText hover:text-cornerA"
        >
          Cancel
        </button>
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Product name"
        className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-grayText"
      />

      <input
        value={websiteUrl}
        onChange={(e) => setWebsiteUrl(e.target.value)}
        onBlur={handleWebsiteBlur}
        placeholder="Website URL"
        className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-grayText"
      />

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase text-grayText">
          Category
          {selectedCategory
            ? ` — ${selectedCategory.name}${categoryAutoSuggested ? " (suggested)" : ""}`
            : ""}
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {categories.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => toggleCategory(c.id)}
              aria-pressed={categoryId === c.id}
              className={`shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-bold transition-colors ${
                categoryId === c.id
                  ? "border-cornerB bg-cornerB text-white"
                  : "border-line bg-paper text-ink hover:border-cornerB"
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                <CategoryIcon slug={c.slug} className="h-3.5 w-3.5" />
                {c.name}
              </span>
            </button>
          ))}
        </div>
      </div>

      <details className="rounded-lg border border-dashed border-line bg-paper px-3 py-2">
        <summary className="cursor-pointer font-mono text-[10px] uppercase text-grayText">
          Description &amp; logo (optional — we'll pull these from your
          site automatically if you skip them)
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <label className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-line bg-white text-[9px] text-grayText">
              {logoPreview ? (
                <img
                  src={logoPreview}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                "PNG"
              )}
              <input
                type="file"
                accept="image/png"
                onChange={handleLogoChange}
                className="hidden"
              />
            </label>
            <div className="font-mono text-[10px] text-grayText">
              Upload a PNG (≤2MB) to override the auto-fetched logo
            </div>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 280))}
            placeholder="Short description (leave blank to auto-fetch)"
            rows={2}
            maxLength={280}
            className="w-full resize-none rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none placeholder:text-grayText"
          />
        </div>
      </details>

      <button
        type="submit"
        disabled={status === "loading"}
        className="rounded-lg bg-cornerB px-4 py-2.5 font-display text-[11px] uppercase tracking-wide text-white disabled:opacity-60"
      >
        {status === "loading" ? "Adding…" : "Add & Continue"}
      </button>

      {message && (
        <div
          className={`font-mono text-[10px] ${
            status === "error" ? "text-cornerA" : "text-grayText"
          }`}
        >
          {message}
        </div>
      )}
    </form>
  );
}
