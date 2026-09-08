import { useEffect, useState } from "react";
import Link from "next/link";
import { logError, logWarn } from "./lib/logger";
import { getProductTint } from "./lib/categoryIcons";

// battle shape expected:
// {
//   id, slug, votes_a, votes_b, status, question, starts_at, ends_at,
//   views, winner_id, created_by,
//   product_a: { id, name, slug, logo_url },
//   product_b: { id, name, slug, logo_url },
// }
//
// mode: "full" (battle detail page — larger, richer post-vote panel),
// "compact" (Battles page grids — smaller, Share/Visit/Details always
// visible rather than gated behind voting), or "featured" (homepage
// Top 1/2/3 — full-size visuals like "full", but with compact's
// always-visible action row instead of the post-vote-only panel, since
// these are meant to be browsable showcase cards, not just a voting
// widget).
//
// theme: optional { bg, border } override for the card's own
// background/border color (medal-tinted Top 1/2/3 cards, per-battle
// cool-tint cards on the Battles page). Doesn't affect product avatars,
// which always use their own identity-based tint regardless of theme.
//
// badge: optional { label, bg, text, extra } rendered as a small ribbon
// in the card's top-left corner (e.g. "1ST" plus a category chip).

const EARLY_RESULT_THRESHOLD = 20; // below this many votes, flag result as early/unreliable
const VOTED_STORAGE_PREFIX = "zl_voted_";

// Persists "I already voted on battle X, for side Y" in localStorage so
// the button greys out immediately on return visits — not just after a
// failed duplicate-vote request round-trip to the server. The server's
// cookie-based check (see pages/api/vote.js) is still the real
// enforcement; this is purely a faster/friendlier client-side reflection
// of the same fact.
function getStoredVote(battleId) {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(`${VOTED_STORAGE_PREFIX}${battleId}`);
  } catch (err) {
    return null; // localStorage can throw in private-browsing/storage-blocked contexts
  }
}

function storeVote(battleId, side) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${VOTED_STORAGE_PREFIX}${battleId}`, side);
  } catch (err) {
    // Non-fatal — worst case this device just relies on the server's
    // cookie-based rejection instead of the instant client-side grey-out.
  }
}

function formatTimeRemaining(endsAtIso) {
  if (!endsAtIso) return null;
  try {
    const diffMs = new Date(endsAtIso).getTime() - Date.now();
    if (diffMs <= 0) return null;
    const hours = Math.floor(diffMs / (60 * 60 * 1000));
    const days = Math.floor(hours / 24);
    if (days >= 1) return `Ends in ${days}d ${hours % 24}h`;
    if (hours >= 1) return `Ends in ${hours}h`;
    const minutes = Math.max(1, Math.floor(diffMs / (60 * 1000)));
    return `Ends in ${minutes}m`;
  } catch (err) {
    logError("BattleCard.formatTimeRemaining", err, { endsAtIso });
    return null;
  }
}

function formatEndedDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch (err) {
    logError("BattleCard.formatEndedDate", err, { iso });
    return null;
  }
}

function Avatar({ product, size, tint }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line font-display ${size}`}
      style={product.logo_url ? undefined : { background: tint.bg, color: tint.text }}
    >
      {product.logo_url ? (
        <img src={product.logo_url} alt="" className="h-full w-full object-cover" />
      ) : (
        product.name[0]
      )}
    </div>
  );
}

export default function BattleCard({ battle, mode = "full", theme = null, badge = null }) {
  const compact = mode === "compact";
  const featured = mode === "featured";
  // "featured" (homepage Top 1/2/3) is full-size like "full" mode, but
  // shares "compact" mode's always-visible Share/Visit/Details row
  // instead of gating those behind voting — these are meant to be
  // browsable showcase cards, not just a voting widget.
  const alwaysShowActions = compact || featured;
  const [votesA, setVotesA] = useState(battle?.votes_a ?? 0);
  const [voted, setVoted] = useState(false);
  const [votedSide, setVotedSide] = useState(null); // "a" | "b" | null
  const [voting, setVoting] = useState(false);
  const [error, setError] = useState(null);
  const [votesB, setVotesB] = useState(battle?.votes_b ?? 0);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    if (!battle?.id) return;
    const stored = getStoredVote(battle.id);
    if (stored === "a" || stored === "b") {
      setVoted(true);
      setVotedSide(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle?.id]);

  // Defensive guard: if a malformed battle object ever makes it this far,
  // fail loudly in the log with useful context instead of crashing render
  // with a cryptic "cannot read property of undefined".
  if (!battle || !battle.product_a || !battle.product_b) {
    logError("BattleCard.render", new Error("Malformed battle prop"), {
      battle,
    });
    return (
      <div className="mx-5 mb-6 rounded-2xl border border-line bg-white px-4 py-6 text-center font-mono text-xs text-grayText">
        This battle couldn't be displayed.
      </div>
    );
  }

  const total = votesA + votesB;
  const pctA = total > 0 ? Math.round((votesA / total) * 100) : 50;
  const pctB = 100 - pctA;

  const hasEnded =
    battle.status !== "live" ||
    (battle.ends_at && new Date(battle.ends_at) <= new Date());
  const timeRemaining = !hasEnded ? formatTimeRemaining(battle.ends_at) : null;
  const endedDateLabel = hasEnded ? formatEndedDate(battle.ends_at) : null;
  const isEarlyResult = !hasEnded && total > 0 && total < EARLY_RESULT_THRESHOLD;

  // BUG FIX: this used to ONLY trust battle.winner_id from the database,
  // showing "Tied — no winner" any time that column was null — even for
  // battles with an obvious, un-tied vote majority (winner_id can be
  // null on completed battles whose close-out never ran, e.g. older
  // seeded/test data). Now it falls back to computing the winner from
  // the actual current vote totals whenever winner_id isn't set but the
  // votes clearly aren't tied.
  const winnerProduct =
    battle.winner_id === battle.product_a.id
      ? battle.product_a
      : battle.winner_id === battle.product_b.id
      ? battle.product_b
      : battle.winner_id === null && votesA !== votesB
      ? votesA > votesB
        ? battle.product_a
        : battle.product_b
      : null;

  const tintA = getProductTint(battle.product_a);
  const tintB = getProductTint(battle.product_b);

  async function castVote(productId, side) {
    if (voted || voting || hasEnded) return;
    setVoting(true);
    setError(null);

    // Optimistic update
    if (side === "a") setVotesA((v) => v + 1);
    else setVotesB((v) => v + 1);

    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ battleId: battle.id, productId }),
      });

      if (!res.ok) {
        const body = await res.json().catch((parseErr) => {
          logWarn("BattleCard.castVote", "Vote error response was not JSON", {
            parseErr: parseErr?.message,
          });
          return {};
        });
        throw new Error(body.error || `Vote failed (${res.status})`);
      }

      setVoted(true);
      setVotedSide(side);
      storeVote(battle.id, side);
    } catch (err) {
      // roll back the optimistic update
      if (side === "a") setVotesA((v) => v - 1);
      else setVotesB((v) => v - 1);
      logError("BattleCard.castVote", err, {
        battleId: battle.id,
        productId,
        side,
      });
      setError(err.message || "Vote failed. Please try again.");
    } finally {
      setVoting(false);
    }
  }

  async function shareResult() {
    const url =
      typeof window !== "undefined" ? `${window.location.origin}/battle/${battle.slug}` : "";
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${battle.product_a.name} vs ${battle.product_b.name}`,
          text: battle.question || undefined,
          url,
        });
        return;
      }
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        logError("BattleCard.shareResult", err, { battleId: battle.id });
      }
    }
  }

  const cardShadow = compact ? "shadow-[3px_3px_0_#2B2620]" : "shadow-[4px_4px_0_#2B2620]";
  const avatarSize = compact ? "h-10 w-10 text-sm" : "h-14 w-14 text-xl md:h-16 md:w-16";
  const pctSize = compact ? "text-xl" : "text-3xl md:text-4xl";

  return (
    <div className={compact || featured ? "" : "mx-5 mb-6 md:mx-8"}>
      <div
        className={`relative mx-auto rounded-2xl border bg-white ${cardShadow} ${
          compact ? "p-3" : "p-4 md:max-w-xl"
        } ${theme ? "" : "border-line"}`}
        style={theme ? { borderColor: theme.border, background: theme.bg } : undefined}
      >
        {badge && (
          <div
            className="absolute -top-3 left-4 z-10 flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[10px] font-bold shadow-[2px_2px_0_#2B2620]"
            style={{ background: badge.bg, color: badge.text }}
          >
            {badge.label}
            {badge.extra}
          </div>
        )}

        {/* status row — only for ended battles now. A still-live battle
        showed "LIVE BATTLE · N votes" here before, which was redundant
        with the percentages/vote counts already visible below; removed.
        The ended/winner badge stays since it's the only place that info
        appears at all. */}
        {hasEnded && (
          <div className="mb-3 flex items-center justify-between font-mono text-[11px] font-bold tracking-wide">
            <span className="text-grayText">
              ENDED{endedDateLabel ? ` · ${endedDateLabel}` : ""}
            </span>
            <span className="rounded-full border border-gold bg-paper px-3 py-1 text-[10px] text-ink">
              {winnerProduct ? `🏆 ${winnerProduct.name} wins` : "Tied — no winner"}
            </span>
          </div>
        )}

        {battle.question && (
          <div className={`mb-3 text-center font-bold text-ink ${compact ? "text-xs" : "text-sm md:text-base mb-4"}`}>
            {battle.question}
          </div>
        )}

        {/* wide row: logo — percent — VS — percent — logo */}
        <div className="flex items-center justify-between gap-1">
          <div className="flex flex-1 flex-col items-center gap-2">
            <Avatar product={battle.product_a} size={avatarSize} tint={tintA} />
            <div className={`text-center font-bold ${compact ? "text-[11px]" : "text-xs md:text-sm"}`}>
              {battle.product_a.name}
            </div>
          </div>

          <div className="flex flex-1 flex-col items-center">
            <div className={`font-mono font-bold text-cornerA ${pctSize}`}>{pctA}%</div>
            <div className="mt-1 font-mono text-[10px] text-grayText">
              {votesA.toLocaleString()} votes
            </div>
          </div>

          <div className="shrink-0 px-1 font-display text-sm text-grayText md:text-base">VS</div>

          <div className="flex flex-1 flex-col items-center">
            <div className={`font-mono font-bold text-cornerB ${pctSize}`}>{pctB}%</div>
            <div className="mt-1 font-mono text-[10px] text-grayText">
              {votesB.toLocaleString()} votes
            </div>
          </div>

          <div className="flex flex-1 flex-col items-center gap-2">
            <Avatar product={battle.product_b} size={avatarSize} tint={tintB} />
            <div className={`text-center font-bold ${compact ? "text-[11px]" : "text-xs md:text-sm"}`}>
              {battle.product_b.name}
            </div>
          </div>
        </div>

        {!compact && total > 0 && (
          <div className="mt-3 text-center font-mono text-[10px] text-grayText">
            {total.toLocaleString()} people have already picked a side
          </div>
        )}

        <div className={`flex h-1.5 overflow-hidden rounded-full bg-line ${compact ? "my-3" : "my-4"}`}>
          <div className="bg-cornerA" style={{ width: `${pctA}%` }} />
          <div className="bg-cornerB" style={{ width: `${pctB}%` }} />
        </div>

        {!hasEnded && (
          <div className="flex items-center gap-2">
            <button
              disabled={voted || voting}
              onClick={() => castVote(battle.product_a.id, "a")}
              className={`flex-1 rounded-lg bg-cornerA font-display uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-60 ${
                compact ? "py-2 text-[10px]" : "py-3 text-[11px]"
              }`}
            >
              Vote {battle.product_a.name} ⚡
            </button>
            {timeRemaining && (
              <span className="shrink-0 font-mono text-[9px] text-grayText">{timeRemaining}</span>
            )}
            <button
              disabled={voted || voting}
              onClick={() => castVote(battle.product_b.id, "b")}
              className={`flex-1 rounded-lg bg-cornerB font-display uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-60 ${
                compact ? "py-2 text-[10px]" : "py-3 text-[11px]"
              }`}
            >
              Vote {battle.product_b.name} ⚡
            </button>
          </div>
        )}

        {alwaysShowActions && error && (
          <div className="mt-2 text-center font-mono text-[10px] text-cornerA">{error}</div>
        )}

        {/* Compact/featured modes: Share, Visit, and Details are ALWAYS
        available here, not gated behind voting first — a listing page
        (or a browsable showcase card) needs those actions reachable
        without forcing a commitment to vote. */}
        {alwaysShowActions && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
            <a
              href={`/api/click?battleId=${battle.id}&productId=${battle.product_a.id}`}
              onClick={(e) => e.stopPropagation()}
              className="rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[9px] font-bold text-ink hover:border-cornerA"
            >
              Visit {battle.product_a.name}
            </a>
            <a
              href={`/api/click?battleId=${battle.id}&productId=${battle.product_b.id}`}
              onClick={(e) => e.stopPropagation()}
              className="rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[9px] font-bold text-ink hover:border-cornerA"
            >
              Visit {battle.product_b.name}
            </a>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                shareResult();
              }}
              className="rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[9px] font-bold text-ink hover:border-cornerA"
            >
              {shareCopied ? "Copied" : "Share"}
            </button>
            <Link
              href={`/battle/${battle.slug}`}
              className="ml-auto rounded-full border border-cornerA bg-cornerA px-2.5 py-1 font-mono text-[9px] font-bold text-white hover:opacity-90"
            >
              See details →
            </Link>
          </div>
        )}
      </div>

      {!alwaysShowActions && error && (
        <div className="mt-2 text-center font-mono text-[10px] text-cornerA">{error}</div>
      )}

      {!alwaysShowActions && voted && !error && (
        <div className="mx-auto mt-3 rounded-2xl border border-line bg-paper p-4 md:max-w-xl">
          <div className="text-center text-sm font-bold text-ink">
            You voted for {votedSide === "a" ? battle.product_a.name : battle.product_b.name}
          </div>
          <div className="mt-1 text-center font-mono text-xs text-grayText">
            {pctA === pctB
              ? "It's currently tied"
              : `${pctA > pctB ? battle.product_a.name : battle.product_b.name} is winning ${Math.max(pctA, pctB)}%–${Math.min(pctA, pctB)}%`}
          </div>
          <div className="mt-1 text-center font-mono text-[10px] text-grayText">
            {total.toLocaleString()} people have voted
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={`/api/click?battleId=${battle.id}&productId=${battle.product_a.id}`}
              className="flex-1 rounded-lg border border-line bg-white px-3 py-2 text-center font-mono text-[10px] font-bold text-ink hover:border-cornerA"
            >
              Visit {battle.product_a.name}
            </a>
            <button
              type="button"
              onClick={shareResult}
              className="flex-1 rounded-lg border border-line bg-white px-3 py-2 text-center font-mono text-[10px] font-bold text-ink hover:border-cornerA"
            >
              {shareCopied ? "Link copied" : "Share result"}
            </button>
            <a
              href={`/api/click?battleId=${battle.id}&productId=${battle.product_b.id}`}
              className="flex-1 rounded-lg border border-line bg-white px-3 py-2 text-center font-mono text-[10px] font-bold text-ink hover:border-cornerA"
            >
              Visit {battle.product_b.name}
            </a>
            <a
              href="/?panel=battle"
              className="flex-1 rounded-lg border border-cornerA bg-cornerA px-3 py-2 text-center font-mono text-[10px] font-bold text-white hover:opacity-90"
            >
              Challenge another
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
