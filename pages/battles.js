import Link from "next/link";
import { supabase } from "../supabase";
import { CategoryIcon, getProductTint, getCoolTint } from "../lib/categoryIcons";
import { logError } from "../lib/logger";

// Page size is user-selectable (Top 10 / Top 20 tabs) rather than fixed
// — Prev/Next pagination still works beyond whichever size is picked,
// paging in increments of that size.
const SIZE_OPTIONS = [10, 20];
const DEFAULT_SIZE = 10;

export async function getServerSideProps({ query }) {
  const status = query?.status === "completed" ? "completed" : "live";
  const categorySlug = query?.category || null;
  const page = Math.max(1, parseInt(query?.page, 10) || 1);
  const size = SIZE_OPTIONS.includes(parseInt(query?.size, 10)) ? parseInt(query.size, 10) : DEFAULT_SIZE;

  try {
    const { data: categories, error: categoriesError } = await supabase
      .from("categories")
      .select("id, name, slug")
      .order("name", { ascending: true });
    if (categoriesError) {
      logError("pages/battles.getServerSideProps.categories", categoriesError);
    }

    let battlesQuery = supabase
      .from("battles")
      .select(
        "id, slug, votes_a, votes_b, votes_a_boost, votes_b_boost, status, question, clicks, created_by, created_at, ends_at, product_a:product_a_id(id, name, logo_url, brand_color, brand_text_color, category:category_id(name, slug)), product_b:product_b_id(id, name, logo_url, brand_color, brand_text_color)",
        { count: "exact" }
      )
      .eq("status", status);

    // Filtering battles by category means "either product in this
    // battle belongs to this category" — battles don't have a category
    // column of their own, only products do. PostgREST can't filter an
    // outer table by a joined table's column directly (embedded-resource
    // filters only narrow what's shown *within* the join, not which
    // outer rows match), so this resolves the category to its product
    // IDs first, then filters battles by product_a_id/product_b_id.
    let categoryName = null;
    if (categorySlug) {
      const { data: cat, error: catError } = await supabase
        .from("categories")
        .select("id, name")
        .eq("slug", categorySlug)
        .single();
      if (catError) {
        logError("pages/battles.getServerSideProps.category", catError, { categorySlug });
      }
      if (cat) {
        categoryName = cat.name;
        const { data: catProducts, error: catProductsError } = await supabase
          .from("products")
          .select("id")
          .eq("category_id", cat.id);
        if (catProductsError) {
          logError("pages/battles.getServerSideProps.categoryProducts", catProductsError, {
            categorySlug,
          });
        }
        const ids = (catProducts ?? []).map((p) => p.id);
        if (ids.length === 0) {
          // Category exists but has no products in it — nothing can
          // match, and an empty .in.() filter is invalid PostgREST
          // syntax, so short-circuit here instead of querying.
          return {
            props: {
              battles: [],
              status,
              categorySlug,
              categoryName,
              categories: categories ?? [],
              page,
              size,
              totalCount: 0,
              loadError: null,
            },
          };
        }
        battlesQuery = battlesQuery.or(
          `product_a_id.in.(${ids.join(",")}),product_b_id.in.(${ids.join(",")})`
        );
      }
    }

    const from = (page - 1) * size;
    const { data: battles, error, count } = await battlesQuery
      .order("created_at", { ascending: false })
      .range(from, from + size - 1);

    if (error) {
      logError("pages/battles.getServerSideProps", error, { status, categorySlug, page, size });
      return {
        props: {
          battles: [],
          status,
          categorySlug,
          categoryName,
          categories: categories ?? [],
          page,
          size,
          totalCount: 0,
          loadError: "Couldn't load battles right now.",
        },
      };
    }

    const boosted = (battles ?? []).map((b) => ({
      ...b,
      votes_a: (b.votes_a ?? 0) + (b.votes_a_boost ?? 0),
      votes_b: (b.votes_b ?? 0) + (b.votes_b_boost ?? 0),
    }));

    // Highest total votes first within the page — "all battles" defaults
    // to showing the most active ones up top, same spirit as the
    // homepage sections, just without the uniqueness constraint (this is
    // the full list, not a curated preview row).
    boosted.sort((a, b) => b.votes_a + b.votes_b - (a.votes_a + a.votes_b));

    return {
      props: {
        battles: boosted,
        status,
        categorySlug,
        categoryName,
        categories: categories ?? [],
        page,
        size,
        totalCount: count ?? 0,
        loadError: null,
      },
    };
  } catch (err) {
    logError("pages/battles.getServerSideProps", err, { status, categorySlug, page, size });
    return {
      props: {
        battles: [],
        status,
        categorySlug,
        categoryName: null,
        categories: [],
        page,
        size,
        totalCount: 0,
        loadError: "Couldn't load battles right now.",
      },
    };
  }
}

function buildHref({ status, categorySlug, page, size }) {
  const params = new URLSearchParams();
  params.set("status", status);
  if (categorySlug) params.set("category", categorySlug);
  if (size && size !== DEFAULT_SIZE) params.set("size", String(size));
  if (page && page > 1) params.set("page", String(page));
  return `/battles?${params.toString()}`;
}

export default function AllBattles({
  battles,
  status,
  categorySlug,
  categoryName,
  categories,
  page,
  size,
  totalCount,
  loadError,
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / size));

  return (
    <div className="mx-auto max-w-3xl px-5 pb-16 pt-8 md:px-8">
      <h1 className="font-display text-2xl uppercase tracking-wide">All battles</h1>
      <p className="mt-1 font-mono text-xs text-grayText">
        Every product battle on Zoloop, ranked by total votes.
        {categoryName && <> Filtered to <span className="font-bold text-ink">{categoryName}</span>.</>}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={buildHref({ status: "live", categorySlug, size })}
          className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
            status === "live"
              ? "border-cornerA bg-cornerA text-white"
              : "border-line bg-white text-ink"
          }`}
        >
          Live
        </Link>
        <Link
          href={buildHref({ status: "completed", categorySlug, size })}
          className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
            status === "completed"
              ? "border-cornerA bg-cornerA text-white"
              : "border-line bg-white text-ink"
          }`}
        >
          Completed
        </Link>

        <span className="mx-1 self-center text-line">|</span>

        {SIZE_OPTIONS.map((s) => (
          <Link
            key={s}
            href={buildHref({ status, categorySlug, size: s })}
            className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
              size === s
                ? "border-cornerB bg-cornerB text-white"
                : "border-line bg-white text-ink"
            }`}
          >
            Top {s}
          </Link>
        ))}
      </div>

      {/* Category pills — moved here from the homepage's old Categories
      nav panel, since filtering BATTLES by category is what this
      actually is; it never belonged as a site-wide nav destination. */}
      {categories.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          <Link
            href={buildHref({ status, categorySlug: null, size })}
            className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] font-bold ${
              !categorySlug
                ? "border-cornerB bg-cornerB text-white"
                : "border-line bg-white text-ink hover:border-cornerB"
            }`}
          >
            All
          </Link>
          {categories.map((c) => (
            <Link
              key={c.id}
              href={buildHref({ status, categorySlug: c.slug, size })}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] font-bold ${
                categorySlug === c.slug
                  ? "border-cornerB bg-cornerB text-white"
                  : "border-line bg-white text-ink hover:border-cornerB"
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                <CategoryIcon slug={c.slug} className="h-3.5 w-3.5" />
                {c.name}
              </span>
            </Link>
          ))}
        </div>
      )}

      {loadError && (
        <div className="mt-4 rounded-lg border border-cornerA bg-cornerADim px-4 py-3 font-mono text-xs text-paper">
          {loadError}
        </div>
      )}

      {!loadError && battles.length === 0 && (
        <p className="mt-8 text-center font-mono text-sm text-grayText">
          No {status} battles{categoryName ? ` in ${categoryName}` : ""} right now.
        </p>
      )}

      {/* Dense tap-through row list — same style as the homepage's
      Happening Now section (logos+category on the left, question and
      votes/clicks on the right), rather than the old interactive card
      grid. Each row keeps its own stable "cool" color, same hashing as
      before, just applied as the row's background instead of a card's. */}
      {battles.length > 0 && (
        <div className="mt-5 flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line shadow-[3px_3px_0_#2B2620]">
          {battles.map((b) => {
            const total = b.votes_a + b.votes_b;
            const clicks = typeof b.clicks === "number" ? b.clicks : 0;
            const category = b.product_a?.category || b.product_b?.category || null;
            const tintA = getProductTint(b.product_a);
            const tintB = getProductTint(b.product_b);
            const rowTheme = status === "live" ? getCoolTint(b.id) : null;
            return (
              <Link
                key={b.id}
                href={`/battle/${b.slug}`}
                className="flex items-center gap-3 px-4 py-3"
                style={rowTheme ? { background: rowTheme.bg } : undefined}
              >
                <div className="flex shrink-0 flex-col items-center gap-1">
                  <div className="flex items-center">
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line font-display text-[10px]"
                      style={b.product_a.logo_url ? undefined : { background: tintA.bg, color: tintA.text }}
                    >
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
                    <div
                      className="-ml-1.5 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line font-display text-[10px]"
                      style={b.product_b.logo_url ? undefined : { background: tintB.bg, color: tintB.text }}
                    >
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

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-ink">
                    {b.question || `${b.product_a.name} vs ${b.product_b.name}`}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-grayText">
                    {status === "live" && (
                      <span className="flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-cornerA" />
                        LIVE
                      </span>
                    )}
                    <span>
                      {total.toLocaleString()} {total === 1 ? "vote" : "votes"}
                    </span>
                    <span>
                      {clicks.toLocaleString()} {clicks === 1 ? "click" : "clicks"}
                    </span>
                    {b.created_by === "admin" && (
                      <span className="font-bold text-cornerA">ZOLOOP PICK</span>
                    )}
                  </div>
                </div>

                <span className="shrink-0 text-grayText">→</span>
              </Link>
            );
          })}
        </div>
      )}

      {/* Next/Previous — this is what handles going beyond whichever
      Top 10/20 size is selected; the size tabs above just control how
      many rows load per page. */}
      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3 font-mono text-xs">
          {page > 1 && (
            <Link
              href={buildHref({ status, categorySlug, size, page: page - 1 })}
              className="rounded-lg border border-line bg-white px-3 py-2 font-bold hover:border-cornerA"
            >
              ← Prev
            </Link>
          )}
          <span className="text-grayText">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={buildHref({ status, categorySlug, size, page: page + 1 })}
              className="rounded-lg border border-line bg-white px-3 py-2 font-bold hover:border-cornerA"
            >
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
