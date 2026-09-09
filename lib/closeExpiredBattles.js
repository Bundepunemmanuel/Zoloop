import { logError, logInfo } from "./logger";

// BUG FIX (was homepage-only): this used to live only inside
// pages/index.js's getServerSideProps, so it only ever ran when someone
// loaded the homepage. Any other page that queries battles — /battles,
// the battle detail page's related-battles list, etc. — had no way to
// know a battle's time had actually run out, and just trusted whatever
// the `status` column said. That meant a battle could sit expired but
// still marked "live" in the database until someone happened to load
// the homepage, so /battles and the homepage disagreed about which
// battles were actually still live. Every page that queries battles by
// status should call this first.
//
// Lazily flips any "live" battle whose ends_at has passed to
// "completed", setting winner_id from whichever side has more votes
// (null if tied). No cron job for the MVP — this just runs whenever any
// battle-listing page loads. Winner is decided on real + boost votes
// together (a boost is meant to look identical to an organic vote
// everywhere public — see migration 7 / pages/battle/[slug].js for the
// fuller explanation).
export async function closeExpiredBattles(supabaseClient) {
  const nowIso = new Date().toISOString();
  const { data: expired, error: fetchError } = await supabaseClient
    .from("battles")
    .select("id, votes_a, votes_b, votes_a_boost, votes_b_boost, product_a_id, product_b_id")
    .eq("status", "live")
    .lt("ends_at", nowIso);

  if (fetchError) {
    logError("lib/closeExpiredBattles.fetch", fetchError);
    return;
  }
  if (!expired || expired.length === 0) return;

  let closedCount = 0;
  for (const b of expired) {
    const totalA = (b.votes_a ?? 0) + (b.votes_a_boost ?? 0);
    const totalB = (b.votes_b ?? 0) + (b.votes_b_boost ?? 0);
    const winnerId = totalA === totalB ? null : totalA > totalB ? b.product_a_id : b.product_b_id;
    const { error: updateError } = await supabaseClient
      .from("battles")
      .update({ status: "completed", winner_id: winnerId })
      .eq("id", b.id);
    if (updateError) {
      logError("lib/closeExpiredBattles.update", updateError, {
        battleId: b.id,
      });
    } else {
      closedCount++;
    }
  }

  // Deliberately logged even on the happy path (not just failures) —
  // this is exactly the kind of "is this actually running?" question
  // that's impossible to answer from the UI alone; searching Vercel
  // logs for this context shows whether the sweep is finding and
  // closing battles at all, or silently finding zero every time.
  if (closedCount > 0) {
    logInfo("lib/closeExpiredBattles", `Closed ${closedCount} expired battle(s)`, {
      closedCount,
      totalExpiredFound: expired.length,
    });
  }
}
