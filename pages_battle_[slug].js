import { useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { supabase } from "../../supabase";
import BattleCard from "../../BattleCard";
import { logError } from "../../lib/logger";
import { getSiteUrl } from "../../lib/siteUrl";
import { getProductTint, getCoolTint } from "../../lib/categoryIcons";

export async function getServerSideProps({ params, req }) {
  try {
    const { data: battle, error } = await supabase
      .from("battles")
      .select(
        "id, slug, votes_a, votes_b, votes_a_boost, votes_b_boost, status, question, starts_at, ends_at, views, clicks, winner_id, created_by, product_a:product_a_id(id, name, slug, description, logo_url, brand_color, brand_text_color, website_url, category_id, category:category_id(name, slug, icon)), product_b:product_b_id(id, name, slug, description, logo_url, brand_color, brand_text_color, website_url, category_id)"
      )
      .eq("slug", params.slug)
      .single();

    if (error || !battle) {
      if (error) {
        logError("pages/battle/[slug].getServerSideProps", error, {
          slug: params.slug,
        });
      }
      return { notFound: true };
    }

    // Boosts (admin-adjusted votes, kept in separate columns — see
    // migration 7) are folded into votes_a/votes_b right here, before
    // ANYTHING downstream reads them — auto-close winner calculation,
    // the percentages shown on BattleCard, etc. A boost is meant to
    // look identical to an organic vote everywhere the public can see
    // it; only the admin dashboard queries the real and boost columns
    // separately.
    battle.votes_a = (battle.votes_a ?? 0) + (battle.votes_a_boost ?? 0);
    battle.votes_b = (battle.votes_b ?? 0) + (battle.votes_b_boost ?? 0);

    // Lazily expire this battle if its time is up, even if a stale "live"
    // status is still sitting on the row (mirrors the bulk closer on the
    // homepage, scoped to just this one battle since that's all we have).
    if (
      battle.status === "live" &&
      battle.ends_at &&
      new Date(battle.ends_at) <= new Date()
    ) {
      const winnerId =
        battle.votes_a === battle.votes_b
          ? null
          : battle.votes_a > battle.votes_b
          ? battle.product_a.id
          : battle.product_b.id;
      const { error: closeError } = await supabase
        .from("battles")
        .update({ status: "completed", winner_id: winnerId })
        .eq("id", battle.id);
      if (closeError) {
        logError("pages/battle/[slug].getServerSideProps.autoClose", closeError, {
          battleId: battle.id,
        });
      } else {
        battle.status = "completed";
        battle.winner_id = winnerId;
      }
    }

    // Count this as a view. Best-effort — a failed increment shouldn't
    // block the page from rendering, just gets logged.
    const newViews = (battle.views ?? 0) + 1;
    const { error: viewsError } = await supabase
      .from("battles")
      .update({ views: newViews })
      .eq("id", battle.id);
    if (viewsError) {
      logError("pages/battle/[slug].getServerSideProps.incrementViews", viewsError, {
        battleId: battle.id,
      });
    } else {
      battle.views = newViews;
    }

    // Related battles: other live/completed battles involving either
    // product's category, excluding this one. Uses product_a's category
    // only (battles don't have their own category field — see README).
    let related = [];
    if (battle.product_a.category_id) {
      const { data: relatedProducts, error: relatedProductsError } = await supabase
        .from("products")
        .select("id")
        .eq("category_id", battle.product_a.category_id)
        .eq("status", "active");

      if (relatedProductsError) {
        logError(
          "pages/battle/[slug].getServerSideProps.relatedProducts",
          relatedProductsError,
          { battleId: battle.id }
        );
      } else {
        const relatedIds = (relatedProducts ?? []).map((p) => p.id);
        if (relatedIds.length > 0) {
          const orFilter = relatedIds
            .map((id) => `product_a_id.eq.${id},product_b_id.eq.${id}`)
            .join(",");
          const { data: relatedBattles, error: relatedBattlesError } = await supabase
            .from("battles")
            .select(
              "id, slug, votes_a, votes_b, votes_a_boost, votes_b_boost, product_a:product_a_id(name, logo_url, brand_color, brand_text_color), product_b:product_b_id(name, logo_url, brand_color, brand_text_color)"
            )
            .or(orFilter)
            .neq("id", battle.id)
            .order("created_at", { ascending: false })
            .limit(3);

          if (relatedBattlesError) {
            logError(
              "pages/battle/[slug].getServerSideProps.relatedBattles",
              relatedBattlesError,
              { battleId: battle.id }
            );
          } else {
            related = (relatedBattles ?? []).map((b) => ({
              ...b,
              votes_a: (b.votes_a ?? 0) + (b.votes_a_boost ?? 0),
              votes_b: (b.votes_b ?? 0) + (b.votes_b_boost ?? 0),
            }));
          }
        }
      }
    }

    return { props: { battle, related, siteUrl: getSiteUrl(req) } };
  } catch (err) {
    logError("pages/battle/[slug].getServerSideProps", err, {
      slug: params?.slug,
    });
    // A thrown/network-level error is treated the same as "not found" —
    // the alternative (crashing to Next's default 500 page) hides the
    // real cause from anyone but someone tailing server logs.
    return { notFound: true };
  }
}

function ShareButton({ battle }) {
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    const url = typeof window !== "undefined" ? window.location.href : "";
    const shareData = {
      title: `${battle.product_a.name} vs ${battle.product_b.name}`,
      text: battle.question || `Vote: ${battle.product_a.name} vs ${battle.product_b.name}`,
      url,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      // AbortError just means the person closed the native share sheet —
      // not a real failure, don't log it as one.
      if (err?.name !== "AbortError") {
        logError("pages/battle/[slug].ShareButton", err, { battleId: battle.id });
      }
    }
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      className="flex-1 rounded-lg border border-line bg-white px-4 py-2.5 text-center font-mono text-[11px] font-bold text-ink hover:border-cornerA"
    >
      {copied ? "Link copied" : "Share result"}
    </button>
  );
}

export default function BattlePage({ battle, related, siteUrl }) {
  if (!battle) {
    logError(
      "pages/battle/[slug].render",
      new Error("BattlePage rendered without a battle prop")
    );
    return (
      <div className="mx-auto max-w-3xl px-5 pb-10 pt-6 text-center font-mono text-sm text-grayText">
        This battle couldn't be loaded.
      </div>
    );
  }

  const category = battle.product_a.category;
  // Absolute — crawlers (WhatsApp/X/iMessage/Slack) can't reliably
  // resolve a relative og:image path, which is why link previews were
  // showing no image before this fix (see lib/siteUrl.js).
  const ogImageUrl = `${siteUrl}/api/og/${battle.slug}`;
  const pageTitle = `${battle.product_a.name} vs ${battle.product_b.name} — Zoloop`;
  const pageDescription =
    battle.question || `Vote: ${battle.product_a.name} vs ${battle.product_b.name}`;

  return (
    <div className="mx-auto max-w-3xl pb-10 pt-6 lg:max-w-4xl">
      <Head>
        <title>{pageTitle}</title>
        <meta name="description" content={pageDescription} />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={pageDescription} />
        <meta property="og:url" content={`${siteUrl}/battle/${battle.slug}`} />
        <meta property="og:image" content={ogImageUrl} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content={ogImageUrl} />
      </Head>

      <div className="mb-3 px-5 font-mono text-[11px] text-grayText md:px-0">
        <Link href="/" className="hover:text-ink">
          Battles
        </Link>
        {category && (
          <>
            {" / "}
            <Link href={`/rankings?category=${category.slug}`} className="hover:text-ink">
              {category.name}
            </Link>
          </>
        )}
      </div>

      {/* Dynamic color theming only applies while the battle is actually
      open — a live battle stands out as "this one's still being decided",
      an ended battle reads as plain settled history rather than carrying
      the same colorful treatment indefinitely. */}
      <BattleCard
        battle={battle}
        theme={
          battle.status === "live" &&
          (!battle.ends_at || new Date(battle.ends_at) > new Date())
            ? getCoolTint(battle.id)
            : null
        }
      />

      {/* action row */}
      <div className="mx-5 mb-2 flex flex-wrap gap-2 md:mx-8">
        <a
          href={`/api/click?battleId=${battle.id}&productId=${battle.product_a.id}`}
          className="flex-1 rounded-lg border border-cornerA bg-white px-4 py-2.5 text-center font-mono text-[11px] font-bold text-cornerA hover:bg-cornerA hover:text-white"
        >
          Visit {battle.product_a.name} ↗
        </a>
        <ShareButton battle={battle} />
        <a
          href={`/api/click?battleId=${battle.id}&productId=${battle.product_b.id}`}
          className="flex-1 rounded-lg border border-cornerB bg-white px-4 py-2.5 text-center font-mono text-[11px] font-bold text-cornerB hover:bg-cornerB hover:text-white"
        >
          Visit {battle.product_b.name} ↗
        </a>
      </div>

      <div className="mx-5 mb-6 md:mx-8">
        <a
          href={ogImageUrl}
          download={`${battle.slug}.png`}
          className="font-mono text-[10px] text-grayText hover:text-cornerA"
        >
          Download result card ↓
        </a>
      </div>

      {/* stats row */}
      <div className="mx-5 mb-8 flex flex-wrap gap-6 border-y border-line py-4 md:mx-8">
        <div>
          <div className="font-mono text-lg font-bold">
            {(battle.views ?? 0).toLocaleString()}
          </div>
          <div className="font-mono text-[10px] text-grayText">battle views</div>
        </div>
        <div>
          <div className="font-mono text-lg font-bold">
            {(battle.clicks ?? 0).toLocaleString()}
          </div>
          <div className="font-mono text-[10px] text-grayText">website clicks</div>
        </div>
        <div className="ml-auto self-center font-mono text-[10px] text-grayText">
          {battle.created_by === "admin" ? (
            <span className="font-bold text-cornerA">ZOLOOP PICK</span>
          ) : (
            "Community-created by real users"
          )}
        </div>
      </div>

      <div className="mx-auto grid max-w-xl grid-cols-1 gap-6 px-5 sm:grid-cols-2 md:px-8 lg:max-w-2xl">
        {[battle.product_a, battle.product_b].map((p, i) => (
          <div key={p.id}>
            <Link
              href={`/product/${p.slug}`}
              className={`font-display text-sm uppercase ${
                i === 0 ? "text-cornerA" : "text-cornerB"
              }`}
            >
              {p.name}
            </Link>
            <p className="mt-1 text-xs text-grayText md:text-sm">{p.description}</p>
          </div>
        ))}
      </div>

      {related.length > 0 && (
        <div className="mt-10 px-5 md:px-8">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-display text-sm uppercase tracking-wide">
              Related battles
            </h2>
            {category && (
              <Link
                href={`/rankings?category=${category.slug}`}
                className="font-mono text-[11px] text-grayText"
              >
                View all
              </Link>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {related.map((b) => {
              const bTotal = b.votes_a + b.votes_b;
              const bPctA = bTotal > 0 ? Math.round((b.votes_a / bTotal) * 100) : 50;
              const leader = bPctA >= 50 ? b.product_a : b.product_b;
              const leaderPct = bPctA >= 50 ? bPctA : 100 - bPctA;
              const relTintA = getProductTint(b.product_a);
              const relTintB = getProductTint(b.product_b);
              return (
                <Link
                  key={b.id}
                  href={`/battle/${b.slug}`}
                  className="rounded-xl border border-line bg-white p-3 shadow-[2px_2px_0_#2B2620] hover:border-cornerA"
                >
                  <div className="flex items-center justify-center gap-2">
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line font-display text-[10px]"
                      style={b.product_a.logo_url ? undefined : { background: relTintA.bg, color: relTintA.text }}
                    >
                      {b.product_a.logo_url ? (
                        <img src={b.product_a.logo_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        b.product_a.name[0]
                      )}
                    </div>
                    <span className="font-mono text-[9px] text-grayText">vs</span>
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line font-display text-[10px]"
                      style={b.product_b.logo_url ? undefined : { background: relTintB.bg, color: relTintB.text }}
                    >
                      {b.product_b.logo_url ? (
                        <img src={b.product_b.logo_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        b.product_b.name[0]
                      )}
                    </div>
                  </div>
                  <div className="mt-2 text-center font-mono text-[10px] text-grayText">
                    {bTotal.toLocaleString()} votes
                  </div>
                  {bTotal > 0 && (
                    <div className="mt-1 text-center font-mono text-[10px] font-bold text-cornerA">
                      {leader.name} wins {leaderPct}%
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
