import Link from "next/link";
import { supabase } from "../supabase";
import BattleCard from "../BattleCard";
import { CategoryIcon, getCoolTint } from "../lib/categoryIcons";
import { logError } from "../lib/logger";

const PAGE_SIZE = 12;

export async function getServerSideProps({ query }) {
  const status = query?.status === "completed" ? "completed" : "live";
  const categorySlug = query?.category || null;
  const page = Math.max(1, parseInt(query?.page, 10) || 1);

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
        "id, slug, votes_a, votes_b, votes_a_boost, votes_b_boost, status, question, clicks, created_by, created_at, ends_at, product_a:product_a_id(id, name, logo_url, category:category_id(name, slug)), product_b:product_b_id(id, name, logo_url)",
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

    const from = (page - 1) * PAGE_SIZE;
    const { data: battles, error, count } = await battlesQuery
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      logError("pages/battles.getServerSideProps", error, { status, categorySlug, page });
      return {
        props: {
          battles: [],
          status,
          categorySlug,
          categoryName,
          categories: categories ?? [],
          page,
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
        totalCount: count ?? 0,
        loadError: null,
      },
    };
  } catch (err) {
    logError("pages/battles.getServerSideProps", err, { status, categorySlug, page });
    return {
      props: {
        battles: [],
        status,
        categorySlug,
        categoryName: null,
        categories: [],
        page,
        totalCount: 0,
        loadError: "Couldn't load battles right now.",
      },
    };
  }
}

function buildHref({ status, categorySlug, page }) {
  const params = new URLSearchParams();
  params.set("status", status);
  if (categorySlug) params.set("category", categorySlug);
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
  totalCount,
  loadError,
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-5xl px-5 pb-16 pt-8 md:px-8">
      <h1 className="font-display text-2xl uppercase tracking-wide">All battles</h1>
      <p className="mt-1 font-mono text-xs text-grayText">
        Every product battle on Zoloop, ranked by total votes.
        {categoryName && <> Filtered to <span className="font-bold text-ink">{categoryName}</span>.</>}
      </p>

      <div className="mt-4 flex gap-2">
        <Link
          href={buildHref({ status: "live", categorySlug })}
          className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
            status === "live"
              ? "border-cornerA bg-cornerA text-white"
              : "border-line bg-white text-ink"
          }`}
        >
          Live
        </Link>
        <Link
          href={buildHref({ status: "completed", categorySlug })}
          className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
            status === "completed"
              ? "border-cornerA bg-cornerA text-white"
              : "border-line bg-white text-ink"
          }`}
        >
          Completed
        </Link>
      </div>

      {/* Category pills — moved here from the homepage's old Categories
      nav panel, since filtering BATTLES by category is what this
      actually is; it never belonged as a site-wide nav destination. */}
      {categories.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          <Link
            href={buildHref({ status, categorySlug: null })}
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
              href={buildHref({ status, categorySlug: c.slug })}
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

      <div className="mt-5 flex flex-col gap-4">
        {battles.map((b) => (
          <BattleCard key={b.id} battle={b} mode="compact" theme={getCoolTint(b.id)} />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="mt-8 flex items-center justify-center gap-3 font-mono text-xs">
          {page > 1 && (
            <Link
              href={buildHref({ status, categorySlug, page: page - 1 })}
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
              href={buildHref({ status, categorySlug, page: page + 1 })}
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
