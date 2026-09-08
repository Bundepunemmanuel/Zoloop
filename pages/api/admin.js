import { supabaseAdmin } from "../../supabase-admin";
import { requireAdmin } from "../../lib/requireAdmin";
import { generateBattleQuestion } from "../../lib/gemini";
import { extractBrandColor } from "../../lib/brandColor";
import { logError, logWarn } from "../../lib/logger";

// Every request here — GET or POST — must carry a valid, allowlisted
// Supabase session in the Authorization header ("Bearer <access_token>").
// This is the REAL gate: pages/emmybund.js hiding the UI behind a login
// screen is just convenience, not security.
//
// GET  ?action=products&q=&status=&sort=
// GET  ?action=battles&q=&status=
// GET  ?action=categories
// GET  ?action=stats
// GET  ?action=rating-history&productId=
// GET  ?action=activity
// GET  ?action=fraud
// POST { type: "product-rating", productId, rating }
// POST { type: "product-status", productId, status }         active|suspended
// POST { type: "product-details", productId, name, description, websiteUrl, categoryId }
// POST { type: "product-clicks-boost", productId, clicksBoost }
// POST { type: "battle-votes-boost", battleId, votesABoost, votesBBoost }
// POST { type: "battle-create", productAId, productBId, duration, question? }
// POST { type: "battle-edit", battleId, question, status }    status: live|cancelled

const ADMIN_DURATION_HOURS = { "1h": 1, "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

// ---------- GET handlers ----------

async function handleListProducts(req, res) {
  const { q, status, sort } = req.query;
  try {
    let query = supabaseAdmin
      .from("products")
      .select(
        "id, name, slug, description, website_url, status, rating, wins, losses, clicks, clicks_boost, logo_url, brand_color, brand_text_color, category_id, category:category_id(name, slug)"
      )
      .limit(50);

    if (status === "active" || status === "suspended" || status === "pending") {
      query = query.eq("status", status);
    }
    if (q && String(q).trim()) {
      query = query.ilike("name", `%${String(q).trim()}%`);
    }

    if (sort === "newest") {
      query = query.order("created_at", { ascending: false });
    } else if (sort === "clicks") {
      query = query.order("clicks", { ascending: false });
    } else {
      query = query.order("rating", { ascending: false });
    }

    const { data, error } = await query;
    if (error) {
      logError("api/admin.listProducts", error, { q, status, sort });
      return res.status(500).json({ error: "Could not load products" });
    }
    return res.status(200).json({ products: data ?? [] });
  } catch (err) {
    logError("api/admin.listProducts", err, { q, status, sort });
    return res.status(500).json({ error: "Could not load products" });
  }
}

async function handleListBattles(req, res) {
  const { q, status } = req.query;
  try {
    let query = supabaseAdmin
      .from("battles")
      .select(
        "id, slug, status, votes_a, votes_b, votes_a_boost, votes_b_boost, clicks, question, created_by, created_at, ends_at, product_a:product_a_id(id, name), product_b:product_b_id(id, name)"
      )
      .order("created_at", { ascending: false })
      .limit(50);

    if (status === "live" || status === "completed" || status === "cancelled") {
      query = query.eq("status", status);
    }

    const { data, error } = await query;
    if (error) {
      logError("api/admin.listBattles", error, { q, status });
      return res.status(500).json({ error: "Could not load battles" });
    }

    const term = q && String(q).trim().toLowerCase();
    const battles = term
      ? (data ?? []).filter(
          (b) =>
            b.product_a?.name?.toLowerCase().includes(term) ||
            b.product_b?.name?.toLowerCase().includes(term)
        )
      : data ?? [];

    return res.status(200).json({ battles });
  } catch (err) {
    logError("api/admin.listBattles", err, { q, status });
    return res.status(500).json({ error: "Could not load battles" });
  }
}

async function handleListCategories(req, res) {
  try {
    const { data, error } = await supabaseAdmin
      .from("categories")
      .select("id, name, slug, icon")
      .order("name", { ascending: true });
    if (error) {
      logError("api/admin.listCategories", error);
      return res.status(500).json({ error: "Could not load categories" });
    }
    return res.status(200).json({ categories: data ?? [] });
  } catch (err) {
    logError("api/admin.listCategories", err);
    return res.status(500).json({ error: "Could not load categories" });
  }
}

async function handleStats(req, res) {
  try {
    const [
      { count: productCount, error: productCountError },
      { count: battleCount, error: battleCountError },
      { count: liveBattleCount, error: liveBattleCountError },
    ] = await Promise.all([
      supabaseAdmin.from("products").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("battles").select("id", { count: "exact", head: true }),
      supabaseAdmin
        .from("battles")
        .select("id", { count: "exact", head: true })
        .eq("status", "live"),
    ]);

    if (productCountError) logError("api/admin.stats.products", productCountError);
    if (battleCountError) logError("api/admin.stats.battles", battleCountError);
    if (liveBattleCountError) logError("api/admin.stats.liveBattles", liveBattleCountError);

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const { count: votesToday, error: votesTodayError } = await supabaseAdmin
      .from("votes")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since.toISOString());
    if (votesTodayError) logError("api/admin.stats.votesToday", votesTodayError);

    // Top category by number of active products.
    const { data: categoryCounts, error: categoryCountsError } = await supabaseAdmin
      .from("products")
      .select("category:category_id(name)")
      .eq("status", "active");
    if (categoryCountsError) logError("api/admin.stats.categoryCounts", categoryCountsError);

    let topCategory = null;
    if (categoryCounts?.length) {
      const tally = {};
      for (const row of categoryCounts) {
        const name = row.category?.name;
        if (!name) continue;
        tally[name] = (tally[name] ?? 0) + 1;
      }
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      if (sorted.length) topCategory = { name: sorted[0][0], count: sorted[0][1] };
    }

    return res.status(200).json({
      productCount: productCount ?? 0,
      battleCount: battleCount ?? 0,
      liveBattleCount: liveBattleCount ?? 0,
      votesToday: votesToday ?? 0,
      topCategory,
    });
  } catch (err) {
    logError("api/admin.stats", err);
    return res.status(500).json({ error: "Could not load stats" });
  }
}

async function handleRatingHistory(req, res) {
  const { productId } = req.query;
  if (!productId) return res.status(400).json({ error: "productId is required" });
  try {
    const { data, error } = await supabaseAdmin
      .from("rating_history")
      .select("id, rating, battle_id, created_at")
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      logError("api/admin.ratingHistory", error, { productId });
      return res.status(500).json({ error: "Could not load rating history" });
    }
    return res.status(200).json({ history: data ?? [] });
  } catch (err) {
    logError("api/admin.ratingHistory", err, { productId });
    return res.status(500).json({ error: "Could not load rating history" });
  }
}

async function handleActivity(req, res) {
  try {
    const [
      { data: recentProducts, error: productsError },
      { data: recentVotes, error: votesError },
      { data: recentBattles, error: battlesError },
    ] = await Promise.all([
      supabaseAdmin
        .from("products")
        .select("id, name, slug, created_at")
        .order("created_at", { ascending: false })
        .limit(8),
      supabaseAdmin
        .from("votes")
        .select("id, created_at, battle:battle_id(slug), product:product_id(name)")
        .order("created_at", { ascending: false })
        .limit(8),
      supabaseAdmin
        .from("battles")
        .select("id, slug, question, created_by, created_at")
        .order("created_at", { ascending: false })
        .limit(8),
    ]);

    if (productsError) logError("api/admin.activity.products", productsError);
    if (votesError) logError("api/admin.activity.votes", votesError);
    if (battlesError) logError("api/admin.activity.battles", battlesError);

    return res.status(200).json({
      recentProducts: recentProducts ?? [],
      recentVotes: recentVotes ?? [],
      recentBattles: recentBattles ?? [],
    });
  } catch (err) {
    logError("api/admin.activity", err);
    return res.status(500).json({ error: "Could not load activity" });
  }
}

// Simple, transparent fraud SIGNAL (not enforcement): looks at votes
// from the last 24h, groups by ip_hash, and flags any IP behind more
// than FRAUD_VOTER_THRESHOLD distinct voter_hash values — i.e. a lot of
// "different browsers" all coming from one network in a short window.
// This is a lead for a human to look at, not an automatic block.
const FRAUD_VOTER_THRESHOLD = 5;

async function handleFraudSignals(req, res) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from("votes")
      .select("ip_hash, voter_hash, battle_id, created_at")
      .gte("created_at", since)
      .not("ip_hash", "is", null)
      .limit(5000);

    if (error) {
      logError("api/admin.fraudSignals", error);
      return res.status(500).json({ error: "Could not load fraud signals" });
    }

    const byIp = {};
    for (const row of data ?? []) {
      if (!byIp[row.ip_hash]) byIp[row.ip_hash] = { voterHashes: new Set(), battleIds: new Set() };
      byIp[row.ip_hash].voterHashes.add(row.voter_hash);
      byIp[row.ip_hash].battleIds.add(row.battle_id);
    }

    const flagged = Object.entries(byIp)
      .map(([ipHash, info]) => ({
        ipHash,
        distinctVoters: info.voterHashes.size,
        distinctBattles: info.battleIds.size,
      }))
      .filter((row) => row.distinctVoters >= FRAUD_VOTER_THRESHOLD)
      .sort((a, b) => b.distinctVoters - a.distinctVoters)
      .slice(0, 20);

    return res.status(200).json({ flagged, windowHours: 24, threshold: FRAUD_VOTER_THRESHOLD });
  } catch (err) {
    logError("api/admin.fraudSignals", err);
    return res.status(500).json({ error: "Could not load fraud signals" });
  }
}

// ---------- POST handlers ----------

async function handleUpdateProductRating(req, res, { email }) {
  const { productId, rating } = req.body || {};
  const parsedRating = Number(rating);
  if (!productId || !Number.isFinite(parsedRating)) {
    return res.status(400).json({ error: "productId and a numeric rating are required" });
  }
  if (parsedRating < 0) {
    return res.status(400).json({ error: "Rating can't go below 0" });
  }

  try {
    const { data: product, error: updateError } = await supabaseAdmin
      .from("products")
      .update({ rating: Math.round(parsedRating) })
      .eq("id", productId)
      .select("id, name, rating")
      .single();

    if (updateError) {
      logError("api/admin.updateProductRating", updateError, { productId, rating });
      return res.status(500).json({ error: "Could not update rating" });
    }

    const { error: historyError } = await supabaseAdmin.from("rating_history").insert({
      product_id: productId,
      battle_id: null,
      rating: Math.round(parsedRating),
    });
    if (historyError) {
      logError("api/admin.updateProductRating.history", historyError, {
        productId,
        rating,
        adminEmail: email,
      });
    }

    return res.status(200).json({ product });
  } catch (err) {
    logError("api/admin.updateProductRating", err, { productId, rating });
    return res.status(500).json({ error: "Could not update rating" });
  }
}

async function handleUpdateProductStatus(req, res, { email }) {
  const { productId, status } = req.body || {};
  if (!productId || !["active", "suspended"].includes(status)) {
    return res.status(400).json({ error: "productId and a valid status (active|suspended) are required" });
  }
  try {
    const { data: product, error } = await supabaseAdmin
      .from("products")
      .update({ status })
      .eq("id", productId)
      .select("id, name, status")
      .single();
    if (error) {
      logError("api/admin.updateProductStatus", error, { productId, status });
      return res.status(500).json({ error: "Could not update status" });
    }
    logWarn("api/admin.updateProductStatus", "Product status changed", {
      productId,
      status,
      adminEmail: email,
    });
    return res.status(200).json({ product });
  } catch (err) {
    logError("api/admin.updateProductStatus", err, { productId, status });
    return res.status(500).json({ error: "Could not update status" });
  }
}

async function handleUpdateProductDetails(req, res, { email }) {
  const { productId, name, description, websiteUrl, categoryId, logoUrl } = req.body || {};
  if (!productId) return res.status(400).json({ error: "productId is required" });

  const updates = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof description === "string") updates.description = description.trim().slice(0, 280);
  if (typeof websiteUrl === "string" && websiteUrl.trim()) updates.website_url = websiteUrl.trim();
  if (typeof categoryId === "string" && categoryId) updates.category_id = categoryId;
  // Fixes a real gap: previously there was no way to correct a missing
  // or wrong logo from the admin dashboard at all — e.g. when a
  // product's auto-fetch (Brandfetch/scrape) never found one and it
  // fell back to a letter avatar. A plain URL field, not a file upload
  // (no storage/upload infra wired up here — paste a direct image URL,
  // same as how logos already work everywhere else in the app).
  if (typeof logoUrl === "string") {
    const trimmed = logoUrl.trim();
    updates.logo_url = trimmed || null; // empty string clears it back to letter-avatar fallback

    if (trimmed) {
      // Extract the real brand color from whatever image the admin just
      // pointed at, same as the auto-fetch pipeline does for new
      // products — a logo set by hand should get the same real-color
      // treatment, not silently fall back to the name-hash tint forever.
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const imgRes = await fetch(trimmed, { signal: controller.signal });
        clearTimeout(timeout);
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          const extracted = await extractBrandColor(buffer);
          if (extracted) {
            updates.brand_color = extracted.brandColor;
            updates.brand_text_color = extracted.brandTextColor;
          } else {
            logWarn("api/admin.updateProductDetails.brandColor", "Extraction returned null", {
              productId,
              logoUrl: trimmed,
            });
          }
        } else {
          logWarn("api/admin.updateProductDetails.brandColor", "Could not fetch logo image", {
            productId,
            logoUrl: trimmed,
            status: imgRes.status,
          });
        }
      } catch (err) {
        // Not fatal — the logo URL itself still saves; it just falls
        // back to the hash-based tint instead of a real extracted color.
        logWarn("api/admin.updateProductDetails.brandColor", "Fetch/extraction failed", {
          productId,
          logoUrl: trimmed,
          error: err?.message,
        });
      }
    } else {
      // Logo cleared — no image left to derive a color from.
      updates.brand_color = null;
      updates.brand_text_color = null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  try {
    const { data: product, error } = await supabaseAdmin
      .from("products")
      .update(updates)
      .eq("id", productId)
      .select("id, name, description, website_url, category_id, logo_url, brand_color, brand_text_color")
      .single();
    if (error) {
      logError("api/admin.updateProductDetails", error, { productId, updates });
      return res.status(500).json({ error: "Could not update product" });
    }
    logWarn("api/admin.updateProductDetails", "Product details edited", {
      productId,
      fields: Object.keys(updates),
      adminEmail: email,
    });
    return res.status(200).json({ product });
  } catch (err) {
    logError("api/admin.updateProductDetails", err, { productId, updates });
    return res.status(500).json({ error: "Could not update product" });
  }
}

async function handleUpdateProductClicksBoost(req, res, { email }) {
  const { productId, clicksBoost } = req.body || {};
  const parsed = Number(clicksBoost);
  if (!productId || !Number.isFinite(parsed) || parsed < 0) {
    return res.status(400).json({ error: "productId and a non-negative clicksBoost are required" });
  }
  try {
    const { data: product, error } = await supabaseAdmin
      .from("products")
      .update({ clicks_boost: Math.round(parsed) })
      .eq("id", productId)
      .select("id, name, clicks, clicks_boost")
      .single();
    if (error) {
      logError("api/admin.updateProductClicksBoost", error, { productId, clicksBoost });
      return res.status(500).json({ error: "Could not update clicks" });
    }
    logWarn("api/admin.updateProductClicksBoost", "Clicks boost edited", {
      productId,
      clicksBoost: parsed,
      adminEmail: email,
    });
    return res.status(200).json({ product });
  } catch (err) {
    logError("api/admin.updateProductClicksBoost", err, { productId, clicksBoost });
    return res.status(500).json({ error: "Could not update clicks" });
  }
}

async function handleUpdateBattleVotesBoost(req, res, { email }) {
  const { battleId, votesABoost, votesBBoost } = req.body || {};
  const parsedA = Number(votesABoost);
  const parsedB = Number(votesBBoost);
  if (!battleId || !Number.isFinite(parsedA) || !Number.isFinite(parsedB) || parsedA < 0 || parsedB < 0) {
    return res
      .status(400)
      .json({ error: "battleId and non-negative votesABoost/votesBBoost are required" });
  }
  try {
    const { data: battle, error } = await supabaseAdmin
      .from("battles")
      .update({ votes_a_boost: Math.round(parsedA), votes_b_boost: Math.round(parsedB) })
      .eq("id", battleId)
      .select("id, votes_a, votes_b, votes_a_boost, votes_b_boost")
      .single();
    if (error) {
      logError("api/admin.updateBattleVotesBoost", error, { battleId, votesABoost, votesBBoost });
      return res.status(500).json({ error: "Could not update votes" });
    }
    logWarn("api/admin.updateBattleVotesBoost", "Vote boost edited", {
      battleId,
      votesABoost: parsedA,
      votesBBoost: parsedB,
      adminEmail: email,
    });
    return res.status(200).json({ battle });
  } catch (err) {
    logError("api/admin.updateBattleVotesBoost", err, { battleId, votesABoost, votesBBoost });
    return res.status(500).json({ error: "Could not update votes" });
  }
}

async function handleCreateBattle(req, res, { email }) {
  const { productAId, productBId, duration, question } = req.body || {};
  if (!productAId || !productBId) {
    return res.status(400).json({ error: "productAId and productBId are required" });
  }
  if (productAId === productBId) {
    return res.status(400).json({ error: "A product can't battle itself" });
  }
  const durationHours = ADMIN_DURATION_HOURS[duration];
  if (!durationHours) {
    return res.status(400).json({ error: "Invalid duration" });
  }

  try {
    const { data: productA, error: productAError } = await supabaseAdmin
      .from("products")
      .select("id, name, slug, description, category:category_id(name)")
      .eq("id", productAId)
      .single();
    const { data: productB, error: productBError } = await supabaseAdmin
      .from("products")
      .select("id, name, slug, description")
      .eq("id", productBId)
      .single();

    if (productAError || !productA || productBError || !productB) {
      logError("api/admin.createBattle.lookup", productAError || productBError, {
        productAId,
        productBId,
      });
      return res.status(404).json({ error: "One or both products couldn't be found" });
    }

    let finalQuestion = question?.trim();
    if (!finalQuestion) {
      finalQuestion = await generateBattleQuestion({
        productAName: productA.name,
        productADescription: productA.description,
        productBName: productB.name,
        productBDescription: productB.description,
        categoryName: productA.category?.name,
      });
    }

    const baseSlug =
      slugify(`${productA.slug}-vs-${productB.slug}`) || `battle-${Date.now()}`;
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + durationHours * 60 * 60 * 1000);

    let insertResult = await supabaseAdmin
      .from("battles")
      .insert({
        slug: baseSlug,
        product_a_id: productA.id,
        product_b_id: productB.id,
        status: "live",
        question: finalQuestion,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        created_by: "admin",
      })
      .select("id, slug")
      .single();

    if (insertResult.error?.code === "23505") {
      const retrySlug = `${baseSlug}-${Date.now().toString(36)}`;
      insertResult = await supabaseAdmin
        .from("battles")
        .insert({
          slug: retrySlug,
          product_a_id: productA.id,
          product_b_id: productB.id,
          status: "live",
          question: finalQuestion,
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          created_by: "admin",
        })
        .select("id, slug")
        .single();
    }

    if (insertResult.error) {
      logError("api/admin.createBattle.insert", insertResult.error, {
        productAId,
        productBId,
      });
      return res.status(500).json({ error: "Could not create battle" });
    }

    logWarn("api/admin.createBattle", "Battle created by admin", {
      battleId: insertResult.data.id,
      slug: insertResult.data.slug,
      adminEmail: email,
    });

    return res.status(200).json({ battle: insertResult.data });
  } catch (err) {
    logError("api/admin.createBattle", err, { productAId, productBId });
    return res.status(500).json({ error: "Could not create battle" });
  }
}

async function handleEditBattle(req, res, { email }) {
  const { battleId, question, status } = req.body || {};
  if (!battleId) return res.status(400).json({ error: "battleId is required" });

  const updates = {};
  if (typeof question === "string" && question.trim()) updates.question = question.trim();
  if (status && ["live", "cancelled"].includes(status)) updates.status = status;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  try {
    const { data: battle, error } = await supabaseAdmin
      .from("battles")
      .update(updates)
      .eq("id", battleId)
      .select("id, slug, question, status")
      .single();
    if (error) {
      logError("api/admin.editBattle", error, { battleId, updates });
      return res.status(500).json({ error: "Could not update battle" });
    }
    logWarn("api/admin.editBattle", "Battle edited", {
      battleId,
      fields: Object.keys(updates),
      adminEmail: email,
    });
    return res.status(200).json({ battle });
  } catch (err) {
    logError("api/admin.editBattle", err, { battleId, updates });
    return res.status(500).json({ error: "Could not update battle" });
  }
}

// Existing products (created before this feature, or whose logo was
// never re-saved through the admin editor) have logo_url but no
// brand_color yet — this doesn't fix itself retroactively just by
// shipping the extraction code, someone has to actually run it once per
// product. Batched (not all-at-once) since fetching + processing N
// images sequentially inside a single serverless function risks hitting
// execution time limits — call this repeatedly (the dashboard button
// does) until remaining hits 0.
const BACKFILL_BATCH_SIZE = 15;

async function handleBackfillBrandColors(req, res, { email }) {
  try {
    const { data: candidates, error: fetchError } = await supabaseAdmin
      .from("products")
      .select("id, logo_url")
      .not("logo_url", "is", null)
      .is("brand_color", null)
      .limit(BACKFILL_BATCH_SIZE);

    if (fetchError) {
      logError("api/admin.backfillBrandColors.fetch", fetchError);
      return res.status(500).json({ error: "Could not load candidates" });
    }

    let succeeded = 0;
    let failed = 0;

    for (const p of candidates ?? []) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const imgRes = await fetch(p.logo_url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!imgRes.ok) {
          failed++;
          continue;
        }
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const extracted = await extractBrandColor(buffer);
        if (!extracted) {
          failed++;
          continue;
        }
        const { error: updateError } = await supabaseAdmin
          .from("products")
          .update({ brand_color: extracted.brandColor, brand_text_color: extracted.brandTextColor })
          .eq("id", p.id);
        if (updateError) {
          logError("api/admin.backfillBrandColors.update", updateError, { productId: p.id });
          failed++;
        } else {
          succeeded++;
        }
      } catch (err) {
        logWarn("api/admin.backfillBrandColors.item", "Failed on one product", {
          productId: p.id,
          error: err?.message,
        });
        failed++;
      }
    }

    const { count: remaining, error: remainingError } = await supabaseAdmin
      .from("products")
      .select("id", { count: "exact", head: true })
      .not("logo_url", "is", null)
      .is("brand_color", null);
    if (remainingError) {
      logError("api/admin.backfillBrandColors.remaining", remainingError);
    }

    logWarn("api/admin.backfillBrandColors", "Batch complete", {
      succeeded,
      failed,
      remaining: remaining ?? null,
      adminEmail: email,
    });

    return res.status(200).json({
      processed: (candidates ?? []).length,
      succeeded,
      failed,
      remaining: remaining ?? 0,
    });
  } catch (err) {
    logError("api/admin.backfillBrandColors", err);
    return res.status(500).json({ error: "Backfill failed" });
  }
}

export default async function handler(req, res) {
  const auth = await requireAdmin(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    if (req.method === "GET") {
      switch (req.query.action) {
        case "battles":
          return handleListBattles(req, res);
        case "categories":
          return handleListCategories(req, res);
        case "stats":
          return handleStats(req, res);
        case "rating-history":
          return handleRatingHistory(req, res);
        case "activity":
          return handleActivity(req, res);
        case "fraud":
          return handleFraudSignals(req, res);
        default:
          return handleListProducts(req, res);
      }
    }

    if (req.method === "POST") {
      const { type } = req.body || {};
      switch (type) {
        case "product-rating":
          return handleUpdateProductRating(req, res, auth);
        case "product-status":
          return handleUpdateProductStatus(req, res, auth);
        case "product-details":
          return handleUpdateProductDetails(req, res, auth);
        case "product-clicks-boost":
          return handleUpdateProductClicksBoost(req, res, auth);
        case "battle-votes-boost":
          return handleUpdateBattleVotesBoost(req, res, auth);
        case "battle-create":
          return handleCreateBattle(req, res, auth);
        case "battle-edit":
          return handleEditBattle(req, res, auth);
        case "backfill-brand-colors":
          return handleBackfillBrandColors(req, res, auth);
        default:
          return res.status(400).json({ error: "Unknown update type" });
      }
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    logError("api/admin", err, { method: req.method });
    return res.status(500).json({ error: "Something went wrong" });
  }
}
