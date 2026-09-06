import { useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../supabase";
import LeaderboardTable from "../LeaderboardTable";
import { CategoryIcon } from "../lib/categoryIcons";
import { logError, logWarn } from "../lib/logger";

const TIME_RANGES = [
  { value: "today", label: "Today", hours: 24 },
  { value: "week", label: "This week", hours: 24 * 7 },
  { value: "month", label: "This month", hours: 24 * 30 },
  { value: "all", label: "All time", hours: null },
];

const SORTS = [
  { value: "top-rated", label: "Top rated" },
  { value: "rising", label: "Rising" },
  { value: "most-battles", label: "Most battles" },
];

// "Form" (rank movement) compares each product's CURRENT rank to its
// approximate rank ~24h ago, derived from rating_history. This is an
// approximation, not a precise time-series: a product's "rank 24h ago"
// is computed only among products that already had rating_history by
// that point, then compared against today's full current ranking. Good
// enough to show direction/magnitude of movement, not a rigorous
// backtest.
async function computeForm(supabaseClient, products) {
  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const productIds = products.map((p) => p.id);
  if (productIds.length === 0) return {};

  const { data: historyRows, error } = await supabaseClient
    .from("rating_history")
    .select("product_id, rating, created_at")
    .in("product_id", productIds)
    .lte("created_at", cutoffIso)
    .order("created_at", { ascending: false });

  if (error) {
    logError("pages/rankings.computeForm", error);
    return {};
  }

  const ratingAtCutoff = {};
  for (const row of historyRows ?? []) {
    if (!(row.product_id in ratingAtCutoff)) {
      ratingAtCutoff[row.product_id] = row.rating;
    }
  }

  const withCutoff = Object.entries(ratingAtCutoff)
    .map(([id, rating]) => ({ id, rating }))
    .sort((a, b) => b.rating - a.rating);
  const oldRankMap = {};
  withCutoff.forEach((p, i) => {
    oldRankMap[p.id] = i + 1;
  });

  const currentRankMap = {};
  products.forEach((p, i) => {
    currentRankMap[p.id] = i + 1;
  });

  const form = {};
  for (const p of products) {
    form[p.id] = p.id in oldRankMap ? oldRankMap[p.id] - currentRankMap[p.id] : null;
  }
  return form;
}

// Recomputes win/loss/battle counts scoped to a time window, from actual
// completed battles rather than the all-time totals on `products`. The
// product's RATING is always the current overall value regardless of
// window — rebuilding a true point-in-time rating snapshot would need
// replaying the full rating history per window, which is a much bigger
// feature than a windowed win/loss count. Capped at the 500 most recent
// completed battles as a reasonable MVP bound.
async function computeWindowedRecords(supabaseClient, hours) {
  const cutoffIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data: battles, error } = await supabaseClient
    .from("battles")
    .select("product_a_id, product_b_id, winner_id, status")
    .eq("status", "completed")
    .gte("created_at", cutoffIso)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    logError("pages/rankings.computeWindowedRecords", error, { hours });
    return {};
  }

  const records = {};
  function bump(id, field) {
    if (!id) return;
    if (!records[id]) records[id] = { wins: 0, losses: 0 };
    records[id][field] += 1;
  }
  for (const b of battles ?? []) {
    if (!b.winner_id) continue; // tie — doesn't count as a win or loss
    bump(b.winner_id, "wins");
    const loserId = b.winner_id === b.product_a_id ? b.product_b_id : b.product_a_id;
    bump(loserId, "losses");
  }
  return records;
}

export async function getServerSideProps({ query }) {
  const fallbackProps = {
    products: [],
    categories: [],
    activeCategorySlug: null,
    sort: "top-rated",
    range: "all",
    loadError: false,
  };

  try {
    const { data: categories, error: categoriesError } = await supabase
      .from("categories")
      .select("id, name, slug, icon")
      .order("name", { ascending: true });

    if (categoriesError) {
      logError("pages/rankings.getServerSideProps.categories", categoriesError);
    }

    const activeCategorySlug = query?.category || null;
    const activeCategory = categories?.find((c) => c.slug === activeCategorySlug);
    if (activeCategorySlug && !activeCategory) {
      logWarn("pages/rankings.getServerSideProps", "Unknown category slug in query", {
        activeCategorySlug,
      });
    }

    const sort = SORTS.some((s) => s.value === query?.sort) ? query.sort : "top-rated";
    const range = TIME_RANGES.some((r) => r.value === query?.range) ? query.range : "all";
    const selectedRange = TIME_RANGES.find((r) => r.value === range);

    let productsQuery = supabase
      .from("products")
      .select(
        "id, name, slug, rating, wins, losses, category_id, logo_url, clicks, clicks_boost, category:category_id(name, icon, slug)"
      )
      .eq("status", "active")
      .order("rating", { ascending: false });

    if (activeCategory) {
      productsQuery = productsQuery.eq("category_id", activeCategory.id);
    }

    const { data: rawProducts, error: productsError } = await productsQuery;
    if (productsError) {
      logError("pages/rankings.getServerSideProps.products", productsError);
    }
    // clicks_boost (admin-adjusted, see migration 7) is folded into
    // clicks right here so it displays identically to an organic click
    // everywhere downstream — same pattern used for votes elsewhere.
    let products = (rawProducts ?? []).map((p) => ({
      ...p,
      clicks: (p.clicks ?? 0) + (p.clicks_boost ?? 0),
    }));

    // Apply the time-window record recompute if a window narrower than
    // "all time" is selected.
    if (selectedRange?.hours) {
      const windowedRecords = await computeWindowedRecords(supabase, selectedRange.hours);
      products = products.map((p) => ({
        ...p,
        wins: windowedRecords[p.id]?.wins ?? 0,
        losses: windowedRecords[p.id]?.losses ?? 0,
      }));
    }

    const form = await computeForm(supabase, products);

    if (sort === "rising") {
      products = [...products].sort((a, b) => (form[b.id] ?? -Infinity) - (form[a.id] ?? -Infinity));
    } else if (sort === "most-battles") {
      products = [...products].sort(
        (a, b) => (b.wins ?? 0) + (b.losses ?? 0) - ((a.wins ?? 0) + (a.losses ?? 0))
      );
    }
    // "top-rated" keeps the rating-desc order already fetched.

    return {
      props: {
        products,
        categories: categories ?? [],
        activeCategorySlug: activeCategorySlug ?? null,
        form,
        sort,
        range,
        loadError: Boolean(productsError),
      },
    };
  } catch (err) {
    logError("pages/rankings.getServerSideProps", err, { query });
    return { props: { ...fallbackProps, form: {}, loadError: true } };
  }
}

export default function Rankings({
  products,
  categories,
  activeCategorySlug,
  form,
  sort,
  range,
  loadError,
}) {
  const router = useRouter();
  const [openDropdown, setOpenDropdown] = useState(null); // null | "category" | "range"
  const activeCategory = categories.find((c) => c.slug === activeCategorySlug);
  const activeRange = TIME_RANGES.find((r) => r.value === range);

  function updateQuery(changes) {
    try {
      const nextQuery = { ...router.query, ...changes };
      Object.keys(nextQuery).forEach((k) => {
        if (!nextQuery[k]) delete nextQuery[k];
      });
      router.push({ pathname: "/rankings", query: nextQuery });
      setOpenDropdown(null);
    } catch (err) {
      logError("pages/rankings.updateQuery", err, { changes });
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-5 pb-10 pt-6 md:px-8">
      <h1 className="mb-1 font-display text-2xl uppercase tracking-wide md:text-3xl">
        Rankings
      </h1>
      <p className="mb-4 font-mono text-[11px] text-grayText">
        Ratings reflect battle results and become more reliable as
        products compete in more battles.
      </p>

      {/* Category + time-range: inline-expand selectors, never a popup */}
      <div className="mb-3 flex flex-col gap-2">
        <div className="w-full">
          <button
            type="button"
            onClick={() => setOpenDropdown((d) => (d === "category" ? null : "category"))}
            aria-expanded={openDropdown === "category"}
            className="rounded-lg border border-line bg-white px-3 py-2 font-mono text-[11px] font-bold text-ink"
          >
            {activeCategory ? (
              <span className="inline-flex items-center gap-1.5">
                <CategoryIcon slug={activeCategory.slug} className="h-3.5 w-3.5" />
                {activeCategory.name}
              </span>
            ) : (
              "All categories"
            )}{" "}
            ▾
          </button>
          {openDropdown === "category" && (
            <div className="mt-2 w-full min-w-0 flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => updateQuery({ category: undefined })}
                className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-bold ${
                  !activeCategorySlug
                    ? "border-cornerB bg-cornerB text-white"
                    : "border-line bg-white text-ink"
                }`}
              >
                All
              </button>
              {categories.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  onClick={() => updateQuery({ category: c.slug })}
                  className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-bold ${
                    activeCategorySlug === c.slug
                      ? "border-cornerB bg-cornerB text-white"
                      : "border-line bg-white text-ink"
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <CategoryIcon slug={c.slug} className="h-3.5 w-3.5" />
                    {c.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-full">
          <button
            type="button"
            onClick={() => setOpenDropdown((d) => (d === "range" ? null : "range"))}
            aria-expanded={openDropdown === "range"}
            className="rounded-lg border border-line bg-white px-3 py-2 font-mono text-[11px] font-bold text-ink"
          >
            {activeRange?.label ?? "All time"} ▾
          </button>
          {openDropdown === "range" && (
            <div className="mt-2 w-full min-w-0 flex gap-2 overflow-x-auto pb-1">
              {TIME_RANGES.map((r) => (
                <button
                  type="button"
                  key={r.value}
                  onClick={() => updateQuery({ range: r.value })}
                  className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-bold ${
                    range === r.value
                      ? "border-cornerB bg-cornerB text-white"
                      : "border-line bg-white text-ink"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Sort tabs */}
      <div className="mb-6 flex gap-4 border-b border-line">
        {SORTS.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => updateQuery({ sort: s.value })}
            className={`border-b-2 pb-2 font-mono text-[11px] font-bold uppercase tracking-wide ${
              sort === s.value
                ? "border-cornerB text-ink"
                : "border-transparent text-grayText hover:text-ink"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="mb-6 rounded-lg border border-cornerA bg-cornerADim px-4 py-3 font-mono text-xs text-paper">
          We couldn't load the full rankings right now. Please refresh.
        </div>
      )}
      {products.length === 0 && !loadError && (
        <p className="font-mono text-xs text-grayText">
          {activeCategory ? `No products in ${activeCategory.name} yet.` : "No products yet."}
        </p>
      )}
      <LeaderboardTable products={products} mode="full" form={form} />
    </div>
  );
}
