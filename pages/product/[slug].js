import { supabase } from "../../supabase";
import Link from "next/link";
import { CategoryIcon, getAvatarTint } from "../../lib/categoryIcons";
import { logError } from "../../lib/logger";

function formatDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch (err) {
    logError("pages/product/[slug].formatDate", err, { iso });
    return null;
  }
}

export async function getServerSideProps({ params }) {
  try {
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("*, category:category_id(name, icon, slug)")
      .eq("slug", params.slug)
      .single();

    if (productError || !product) {
      if (productError) {
        logError("pages/product/[slug].getServerSideProps.product", productError, {
          slug: params.slug,
        });
      }
      return { notFound: true };
    }

    // clicks_boost (admin-adjusted, see migration 7) folded into clicks
    // right here so it displays identically to an organic click.
    product.clicks = (product.clicks ?? 0) + (product.clicks_boost ?? 0);

    // Rank = how many active products currently sit above this one, +1.
    // Cheap enough at MVP scale; revisit if the product count grows large.
    const { count: aboveCount, error: rankError } = await supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .gt("rating", product.rating);

    if (rankError) {
      logError("pages/product/[slug].getServerSideProps.rank", rankError, {
        productId: product.id,
      });
    }

    // Category rank ("#2 of 3") — same idea as overall rank, scoped to
    // just this product's category. Shown as "#X of Y" rather than
    // hidden below some "big enough category" threshold: "#1 of 1" is
    // an honest, self-evidently meaningful stat on its own, not a
    // misleading one that needs gating.
    let categoryRank = null;
    let categoryTotal = null;
    if (product.category_id) {
      const [{ count: categoryAboveCount, error: categoryRankError }, { count: categoryTotalCount, error: categoryTotalError }] =
        await Promise.all([
          supabase
            .from("products")
            .select("id", { count: "exact", head: true })
            .eq("status", "active")
            .eq("category_id", product.category_id)
            .gt("rating", product.rating),
          supabase
            .from("products")
            .select("id", { count: "exact", head: true })
            .eq("status", "active")
            .eq("category_id", product.category_id),
        ]);

      if (categoryRankError) {
        logError("pages/product/[slug].getServerSideProps.categoryRank", categoryRankError, {
          productId: product.id,
        });
      }
      if (categoryTotalError) {
        logError("pages/product/[slug].getServerSideProps.categoryTotal", categoryTotalError, {
          productId: product.id,
        });
      }
      if (!categoryRankError && !categoryTotalError) {
        categoryRank = (categoryAboveCount ?? 0) + 1;
        categoryTotal = categoryTotalCount ?? 0;
      }
    }

    const { data: battles, error: battlesError } = await supabase
      .from("battles")
      .select(
        "id, slug, status, votes_a, votes_b, votes_a_boost, votes_b_boost, views, winner_id, starts_at, ends_at, product_a_id, product_b_id, product_a:product_a_id(name, slug, logo_url), product_b:product_b_id(name, slug, logo_url)"
      )
      .or(`product_a_id.eq.${product.id},product_b_id.eq.${product.id}`)
      .order("created_at", { ascending: false })
      .limit(20);

    if (battlesError) {
      logError("pages/product/[slug].getServerSideProps.battles", battlesError, {
        productId: product.id,
      });
    }

    const boostedBattles = (battles ?? []).map((b) => ({
      ...b,
      votes_a: (b.votes_a ?? 0) + (b.votes_a_boost ?? 0),
      votes_b: (b.votes_b ?? 0) + (b.votes_b_boost ?? 0),
    }));

    return {
      props: {
        product,
        battles: boostedBattles,
        rank: rankError ? null : (aboveCount ?? 0) + 1,
        categoryRank,
        categoryTotal,
      },
    };
  } catch (err) {
    logError("pages/product/[slug].getServerSideProps", err, {
      slug: params?.slug,
    });
    return { notFound: true };
  }
}

export default function ProductPage({ product, battles, rank, categoryRank, categoryTotal }) {
  if (!product) {
    logError(
      "pages/product/[slug].render",
      new Error("ProductPage rendered without a product prop")
    );
    return (
      <div className="mx-auto max-w-2xl px-5 pb-10 pt-6 text-center font-mono text-sm text-grayText">
        This product couldn't be loaded.
      </div>
    );
  }

  const total = (product.wins ?? 0) + (product.losses ?? 0);
  const winRate = total > 0 ? Math.round((product.wins / total) * 100) : 0;
  const tint = getAvatarTint(product.name);

  return (
    <div className="mx-auto max-w-2xl px-5 pb-10 pt-6 md:px-8 lg:max-w-3xl">
      {/* ---------- hero ---------- */}
      {/* Per-entity dynamic theming (the outbid.lol reference — Pecan
      AI's page is green because Pecan's own identity is green, ZeroRank's
      is black/white). Same tint already used for the logo fallback,
      applied here to the whole hero card so the page visually "belongs"
      to this specific product rather than using one fixed site color. */}
      <div
        className="rounded-2xl border p-5 shadow-[4px_4px_0_#2B2620]"
        style={{ background: tint.bg, borderColor: tint.text }}
      >
        <div className="flex items-start gap-4">
          <div
            className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border font-display text-2xl md:h-24 md:w-24"
            style={product.logo_url ? { borderColor: tint.text } : { background: "#FFFFFF", borderColor: tint.text, color: tint.text }}
          >
            {product.logo_url ? (
              <img
                src={product.logo_url}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              product.name?.[0] ?? "?"
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-xl uppercase leading-tight md:text-2xl">
              {product.name}
            </h1>
            {product.category && (
              <div className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 py-1 font-mono text-[10px] font-bold">
                <CategoryIcon slug={product.category.slug} className="h-3 w-3" />
                {product.category.name}
              </div>
            )}
            {product.website_url && (
              <a
                href={`/api/click?productId=${product.id}`}
                className="mt-2 inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-1 font-mono text-[10px] font-bold text-ink hover:border-cornerB"
              >
                Visit ↗
              </a>
            )}
          </div>
        </div>

        {product.description && (
          <p className="mt-4 text-sm text-grayText md:text-base">
            {product.description}
          </p>
        )}
      </div>

      {/* ---------- stats ---------- */}
      {/* Rating gets visual weight the other five don't — it's the
      headline stat (what actually determines rank), the rest are
      supporting context. 6 tiles total (was 5) fits a clean 3x2 grid on
      mobile and a single row on wider screens, rather than an awkward
      leftover gap. */}
      <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
        <div className="flex flex-col items-center justify-center rounded-xl bg-ink py-3 text-center text-white shadow-[3px_3px_0_#C08552]">
          <div className="font-mono text-2xl font-bold">{product.rating}</div>
          <div className="mt-0.5 font-mono text-[9px] text-[#B9B9C4]">RATING</div>
        </div>
        <div className="rounded-xl border border-line bg-white py-3 text-center shadow-[2px_2px_0_#2B2620]">
          <div className="font-mono text-lg font-bold">
            {product.wins}-{product.losses}
          </div>
          <div className="font-mono text-[10px] text-grayText">RECORD</div>
        </div>
        <div className="rounded-xl border border-line bg-white py-3 text-center shadow-[2px_2px_0_#2B2620]">
          <div className="font-mono text-lg font-bold">{winRate}%</div>
          <div className="font-mono text-[10px] text-grayText">WIN RATE</div>
        </div>
        <div className="rounded-xl border border-line bg-white py-3 text-center shadow-[2px_2px_0_#2B2620]">
          <div className="font-mono text-lg font-bold">
            {rank ? `#${rank}` : "—"}
          </div>
          <div className="font-mono text-[10px] text-grayText">RANK</div>
        </div>
        <div className="rounded-xl border border-line bg-white py-3 text-center shadow-[2px_2px_0_#2B2620]">
          <div className="font-mono text-lg font-bold">
            {categoryRank ? `#${categoryRank} of ${categoryTotal}` : "—"}
          </div>
          <div className="font-mono text-[10px] text-grayText">IN CATEGORY</div>
        </div>
        <div className="rounded-xl border border-line bg-white py-3 text-center shadow-[2px_2px_0_#2B2620]">
          <div className="font-mono text-lg font-bold">
            {(product.clicks ?? 0).toLocaleString()}
          </div>
          <div className="font-mono text-[10px] text-grayText">CLICKS</div>
        </div>
      </div>

      {/* ---------- battle history ---------- */}
      <h2 className="mt-8 mb-3 font-display text-sm uppercase tracking-wide">
        Battle History
      </h2>
      {battles.length === 0 && (
        <p className="font-mono text-xs text-grayText">No battles yet.</p>
      )}
      <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-3">
        {battles.map((b) => {
          if (!b || (!b.product_a && !b.product_b)) {
            logError(
              "pages/product/[slug].render",
              new Error("Malformed battle row in history"),
              { battle: b }
            );
            return null;
          }

          const opponent =
            b.product_a_id === product.id ? b.product_b : b.product_a;

          let resultLabel = b.status.toUpperCase();
          let resultClass = "border-line bg-paper text-grayText";
          if (b.status === "live") {
            resultLabel = "LIVE";
            resultClass = "border-cornerA bg-white text-cornerA";
          } else if (b.status === "completed") {
            if (!b.winner_id) {
              resultLabel = "TIE";
              resultClass = "border-line bg-paper text-grayText";
            } else if (b.winner_id === product.id) {
              resultLabel = "WON";
              resultClass = "border-[#1F9D55] bg-[#1F9D55] text-white";
            } else {
              resultLabel = "LOST";
              resultClass = "border-line bg-paper text-grayText";
            }
          }

          const dateLabel = formatDate(b.starts_at) || formatDate(b.ends_at);
          const opponentTint = getAvatarTint(opponent?.name);

          return (
            <Link
              key={b.id}
              href={`/battle/${b.slug}`}
              className="flex items-center gap-3 rounded-xl border border-line bg-white px-3 py-3 shadow-[2px_2px_0_#2B2620] hover:border-cornerA"
            >
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line font-display text-xs"
                style={opponent?.logo_url ? undefined : { background: opponentTint.bg, color: opponentTint.text }}
              >
                {opponent?.logo_url ? (
                  <img
                    src={opponent.logo_url}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  opponent?.name?.[0] ?? "?"
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold">
                  vs {opponent?.name ?? "Unknown"}
                </div>
                <div className="font-mono text-[10px] text-grayText">
                  {(b.votes_a + b.votes_b).toLocaleString()} votes ·{" "}
                  {(b.views ?? 0).toLocaleString()} views
                  {dateLabel ? ` · ${dateLabel}` : ""}
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold ${resultClass}`}
              >
                {resultLabel}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
