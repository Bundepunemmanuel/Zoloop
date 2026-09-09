import sharp from "sharp";
import * as cheerio from "cheerio";
import { supabaseAdmin } from "../../supabase-admin";
import { logError, logWarn, logInfo } from "../../lib/logger";
import { suggestCompetitors, generateBattleQuestion, generateDescription } from "../../lib/gemini";
import { extractBrandColor } from "../../lib/brandColor";
import { searchCompetitors } from "../../lib/tavily";

// Uses the service-role client — writes never go through the anon key, so
// RLS can stay locked down for everyone else.
//
// This file does double duty:
//   GET  ?q=text          -> fuzzy/typo-tolerant product search (the two
//                             search boxes in the "Challenge a competitor"
//                             flow), via the search_products() Postgres
//                             function (see supabase-schema.sql)
//   GET  ?category=id     -> top-rated products in a category, used as
//                             "🔥 Recommended opponents"
//   POST                  -> create a new product (the inline "+ Add" mini
//                             form). Logo and description are OPTIONAL —
//                             if omitted, the server tries to auto-fetch
//                             them from the website's Open Graph tags.
//                             Manual values, when provided, always win.
//
// This route auto-publishes new products (status: "active"). The original
// architecture doc recommended a "pending" review queue instead,
// specifically to stop junk submissions — worth knowing that protection
// is off. If spam becomes a real problem, flipping the default status
// back to "pending" here is a one-line change.

const MAX_LOGO_BYTES = 2_000_000; // 2MB, matches the Supabase "logos" bucket limit
const ALLOWED_LOGO_MIME = "image/png"; // matches the bucket's PNG-only restriction
const METADATA_FETCH_TIMEOUT_MS = 6000;
const JINA_TIMEOUT_MS = 8000;
// Below this many characters of scraped body text, treat cheerio's
// extraction as "too thin to be useful" and try Jina Reader instead —
// covers JS-rendered/SPA sites where the raw server HTML has no real
// content for cheerio to find.
const THIN_TEXT_SNIPPET_THRESHOLD = 200;

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function normalizeUrl(input) {
  const trimmed = input.trim();
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Scraped <title> tags are usually noisy for use as a bare product name
// — "Notion – One workspace. Every team." or "Home | Acme Inc" — so this
// strips the common trailing "site tagline" pattern (a separator
// followed by more text) and keeps just the leading part, which is
// almost always the actual product/company name. Not perfect (some
// sites put the tagline FIRST), but a reasonable default for something
// the user can always edit afterward.
function cleanTitleForName(title) {
  if (!title) return null;
  const cleaned = title.split(/[-–|:]/)[0].trim();
  return cleaned && cleaned.length <= 60 ? cleaned : null;
}

// Absolute last resort if there's no title at all to work with —
// "example.com" -> "Example". Always succeeds for any valid URL, which
// is what makes it a true fallback rather than another "might fail"
// step.
function deriveNameFromDomain(websiteUrl) {
  try {
    const hostname = new URL(websiteUrl).hostname.replace(/^www\./, "");
    const base = hostname.split(".")[0];
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch (err) {
    return "New product";
  }
}

// Best-effort scrape of a page's Open Graph tags (or plain <title>/
// <meta name="description"> as a fallback), plus a guess at a logo image
// (og:image -> twitter:image -> a real <link rel="icon">/apple-touch-icon
// -> /favicon.ico as an absolute last resort). Uses cheerio (a real HTML
// parser) rather than regex — regex was missing/mis-parsing tags on
// enough real-world sites (attribute order variations, self-closing vs
// not, unusual whitespace) that it was worth the dependency.
//
// Also returns a short plain-text snippet of the page's visible body
// text, used ONLY as input to the Gemini description fallback when a
// site has no description meta tag anywhere (see generateDescription in
// lib/gemini.js) — never used to invent a description ourselves.
//
// NOTE: this fetch runs at request time on the server (Vercel), not in
// any sandboxed environment — sites that block bot user agents, have no
// OG tags, or time out will make this return nulls, which callers must
// handle gracefully (never treat auto-fetch failure as a hard error).
async function fetchMetadata(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Some sites refuse requests with no/bot-like user agent.
        "User-Agent":
          "Mozilla/5.0 (compatible; ZoloopBot/1.0; +https://zoloop.vercel.app)",
      },
    });
    if (!res.ok) {
      logWarn("api/submit-product.fetchMetadata", "Non-OK response", {
        url,
        status: res.status,
      });
      return { title: null, description: null, imageUrl: null, textSnippet: null };
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $('meta[name="twitter:title"]').attr("content")?.trim() ||
      $("title").first().text()?.trim() ||
      null;

    const description =
      $('meta[property="og:description"]').attr("content")?.trim() ||
      $('meta[name="twitter:description"]').attr("content")?.trim() ||
      $('meta[name="description"]').attr("content")?.trim() ||
      null;

    let imageUrl =
      $('meta[property="og:image"]').attr("content")?.trim() ||
      $('meta[name="twitter:image"]').attr("content")?.trim() ||
      null;

    if (imageUrl) {
      try {
        imageUrl = new URL(imageUrl, url).toString();
      } catch (err) {
        logWarn("api/submit-product.fetchMetadata", "Invalid image meta URL", {
          url,
          imageUrl,
        });
        imageUrl = null;
      }
    }

    if (!imageUrl) {
      // No og:image/twitter:image — look for a real icon link. Sites
      // sometimes declare several (different sizes); take the first.
      const iconHref = $(
        'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
      )
        .first()
        .attr("href");
      if (iconHref) {
        try {
          imageUrl = new URL(iconHref, url).toString();
        } catch {
          imageUrl = null;
        }
      }
    }

    if (!imageUrl) {
      // Last resort: the conventional default path, even though most
      // modern sites declare an explicit <link rel="icon"> instead.
      try {
        imageUrl = new URL("/favicon.ico", url).toString();
      } catch {
        imageUrl = null;
      }
    }

    // Plain visible text, stripped of scripts/styles/nav chrome as best
    // effort, capped short — only ever used as LLM input, never shown
    // directly to anyone.
    $("script, style, noscript, svg").remove();
    const textSnippet = $("body").text().replace(/\s+/g, " ").trim().slice(0, 2000) || null;

    return { title, description, imageUrl, textSnippet };
  } catch (err) {
    logWarn("api/submit-product.fetchMetadata", "Fetch failed", {
      url,
      error: err?.message,
    });
    return { title: null, description: null, imageUrl: null, textSnippet: null };
  } finally {
    clearTimeout(timeout);
  }
}

// Downloads an image from anywhere and converts it to a PNG under the
// bucket's size limit, using sharp. Returns null (never throws) on any
// failure — callers treat that as "auto-fetch didn't work" and fall back
// to no logo, not a hard error.
async function fetchAndConvertLogo(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;

    const arrayBuffer = await res.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Resize down if huge, always re-encode as PNG regardless of source
    // format (favicons are often .ico, OG images are often .jpg/.webp).
    const pngBuffer = await sharp(inputBuffer)
      .resize(512, 512, { fit: "cover" })
      .png({ compressionLevel: 9 })
      .toBuffer();

    if (pngBuffer.byteLength > MAX_LOGO_BYTES) return null;
    return pngBuffer;
  } catch (err) {
    logWarn("api/submit-product.fetchAndConvertLogo", "Failed", {
      imageUrl,
      error: err?.message,
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Brandfetch Logo API (free tier, ~1M renders/mo) — a curated logo
// database keyed by domain, used as a step UP from raw OG-image/favicon
// scraping (which only finds whatever image tag a site happens to
// declare, if any). Requires a Client ID only, no secret API key — set
// BRANDFETCH_CLIENT_ID in the environment. Returns null (never throws)
// on any failure, same contract as fetchAndConvertLogo below, which this
// delegates the actual download+PNG-conversion to once it has a URL.
function brandfetchLogoUrl(domain) {
  const clientId = process.env.BRANDFETCH_CLIENT_ID;
  if (!clientId) {
    // This used to fail completely silently — no log at all — so if
    // the env var was simply never set, there was no way to tell that
    // from "Brandfetch tried and found nothing." Logged once per call
    // rather than only on startup since this is a low-volume path
    // (product submission), not a hot loop.
    logWarn("api/submit-product.brandfetchLogoUrl", "BRANDFETCH_CLIENT_ID is not set — Brandfetch logo lookup skipped entirely", { domain });
    return null;
  }
  if (!domain) return null;
  return `https://cdn.brandfetch.io/${encodeURIComponent(domain)}?c=${encodeURIComponent(clientId)}`;
}

async function fetchBrandfetchLogo(domain) {
  const cdnUrl = brandfetchLogoUrl(domain);
  if (!cdnUrl) return null;
  try {
    const pngBuffer = await fetchAndConvertLogo(cdnUrl);
    if (!pngBuffer) {
      logWarn("api/submit-product.fetchBrandfetchLogo", "No logo returned", { domain });
    } else {
      logInfo("api/submit-product.fetchBrandfetchLogo", "Logo found via Brandfetch", {
        domain,
        byteLength: pngBuffer.byteLength,
      });
    }
    return pngBuffer;
  } catch (err) {
    logWarn("api/submit-product.fetchBrandfetchLogo", "Failed", {
      domain,
      error: err?.message,
    });
    return null;
  }
}

// Jina Reader (r.jina.ai) — renders a page in a real headless browser and
// returns clean text/markdown, unlike cheerio which only ever sees the
// raw server-sent HTML. Used ONLY as a fallback when the cheerio scrape
// in fetchMetadata() comes back with little/no usable body text (the one
// case cheerio structurally can't solve: JS-rendered/SPA sites). Free,
// no API key required, though JINA_API_KEY (if set) raises the rate
// limit — never a hard requirement. Returns null (never throws) on any
// failure; caller falls back to whatever cheerio already found.
async function fetchJinaRenderedText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);
  try {
    const jinaKey = process.env.JINA_API_KEY;
    const headers = {
      "X-Return-Format": "text",
    };
    if (jinaKey) headers["Authorization"] = `Bearer ${jinaKey}`;

    const res = await fetch(`https://r.jina.ai/${url}`, {
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      logWarn("api/submit-product.fetchJinaRenderedText", "Non-OK response", {
        url,
        status: res.status,
      });
      return null;
    }
    const text = (await res.text()).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 2000) : null;
  } catch (err) {
    logWarn("api/submit-product.fetchJinaRenderedText", "Failed", {
      url,
      error: err?.message,
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Honest, low-tech category guessing: naive keyword matching against the
// site's title + description, NOT an LLM or any ML model. Scores each
// category by how many of its associated keywords appear in the text and
// returns the highest-scoring one, or null if nothing matched at all.
// This is a starting suggestion the person can freely override — it will
// sometimes be wrong or miss entirely for niche products.
const CATEGORY_KEYWORDS = {
  ai: ["ai", "artificial intelligence", "llm", "gpt", "machine learning", "chatbot", "assistant"],
  productivity: ["productivity", "tasks", "todo", "to-do", "organize", "workflow"],
  "developer-tools": ["developer", "code", "api", "sdk", "ide", "programming", "github", "deploy"],
  design: ["design", "figma", "ui", "ux", "prototype", "mockup", "wireframe"],
  "note-taking": ["notes", "note-taking", "notebook", "wiki", "knowledge base"],
  collaboration: ["collaboration", "team", "together", "realtime", "meeting"],
  saas: ["saas", "software as a service", "cloud platform", "subscription"],
  marketing: ["marketing", "campaign", "seo", "ads", "advertising", "growth"],
  finance: ["finance", "banking", "accounting", "invoice", "payments", "budget"],
  business: ["business", "crm", "sales", "enterprise", "operations"],
  "e-commerce": ["ecommerce", "e-commerce", "shop", "store", "shopify", "cart", "retail"],
  "photo-video": ["photo", "video editing", "camera", "image editing"],
  music: ["music", "audio", "song", "playlist", "streaming music"],
  entertainment: ["entertainment", "movies", "tv show", "streaming"],
  games: ["game", "gaming", "play"],
  "health-fitness": ["health", "fitness", "workout", "wellness", "exercise"],
  education: ["education", "learning", "course", "school", "tutor"],
  travel: ["travel", "trip", "flight", "hotel", "booking"],
  shopping: ["shopping", "marketplace", "deals"],
  social: ["social network", "community", "friends", "share with"],
  utilities: ["utility", "converter", "calculator"],
  news: ["news", "articles", "journalism", "headlines"],
};

function guessCategorySlug(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  let bestSlug = null;
  let bestScore = 0;
  for (const [slug, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = keywords.reduce(
      (count, kw) => count + (lower.includes(kw) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      bestSlug = slug;
    }
  }
  return bestSlug;
}

// GET ?action=suggest-question&productAId=X&productBId=Y
// Preview endpoint for the "Start a Battle" confirm step — lets the
// person SEE and edit an AI-generated question before committing,
// rather than only finding out what question they got after the battle
// already exists. Always returns something usable: falls back to the
// generic template server-side too if Gemini fails, same as the actual
// battle-creation path in pages/api/vote.js.
async function handleSuggestQuestion(req, res) {
  const { productAId, productBId } = req.query;
  if (!productAId || !productBId) {
    return res.status(400).json({ error: "productAId and productBId are required" });
  }
  try {
    const { data: products, error } = await supabaseAdmin
      .from("products")
      .select("id, name, description, category:category_id(name)")
      .in("id", [productAId, productBId]);

    if (error || !products || products.length !== 2) {
      if (error) logError("api/submit-product.suggestQuestion", error, { productAId, productBId });
      return res.status(200).json({ question: "Which is better?" });
    }

    const productA = products.find((p) => p.id === productAId);
    const productB = products.find((p) => p.id === productBId);

    const generated = await generateBattleQuestion({
      productAName: productA.name,
      productADescription: productA.description,
      productBName: productB.name,
      productBDescription: productB.description,
      categoryName: productA.category?.name || productB.category?.name,
    });

    return res.status(200).json({
      question: generated || `Which is better: ${productA.name} or ${productB.name}?`,
    });
  } catch (err) {
    logError("api/submit-product.suggestQuestion", err, { productAId, productBId });
    return res.status(200).json({ question: "Which is better?" });
  }
}

// GET ?action=suggest-competitors&productId=X
// Button-triggered (never automatic) — asks Gemini for real competitors
// of the given product, then checks Zoloop's own DB for each one via
// the same fuzzy search used elsewhere. Returns two kinds of results:
// ones already on Zoloop (selectable immediately) and ones that aren't
// (pre-fill the add-product form instead of blind-adding an unverified
// product).
// A product's real competitor set doesn't meaningfully change day to
// day — re-searching every time someone re-triggers suggestions for the
// SAME product would burn the shared Tavily free-tier budget (1,000
// credits/month, shared across every user of this feature) for no real
// benefit. Cache for 30 days before spending another credit on the same
// product.
const COMPETITOR_SEARCH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function handleSuggestCompetitors(req, res) {
  const { productId } = req.query;
  if (!productId) {
    return res.status(400).json({ error: "productId is required" });
  }
  try {
    const { data: product, error: productError } = await supabaseAdmin
      .from("products")
      .select(
        "id, name, description, competitor_search_cache, competitor_search_cached_at, category:category_id(name)"
      )
      .eq("id", productId)
      .single();

    if (productError || !product) {
      if (productError) {
        logError("api/submit-product.suggestCompetitors.fetchProduct", productError, {
          productId,
        });
      }
      return res.status(404).json({ error: "Product not found" });
    }

    let searchResults = [];
    const cacheAge = product.competitor_search_cached_at
      ? Date.now() - new Date(product.competitor_search_cached_at).getTime()
      : Infinity;

    if (product.competitor_search_cache && cacheAge < COMPETITOR_SEARCH_CACHE_TTL_MS) {
      searchResults = product.competitor_search_cache;
      logInfo("api/submit-product.suggestCompetitors", "Using cached Tavily results", {
        productId,
        cacheAgeDays: Math.round(cacheAge / (24 * 60 * 60 * 1000)),
      });
    } else {
      searchResults = await searchCompetitors(product.name);
      if (searchResults.length > 0) {
        // Cache regardless of whether the CALLER ends up using these
        // results (the cache is about not re-spending a Tavily credit on
        // this product again soon, not about this specific request).
        const { error: cacheError } = await supabaseAdmin
          .from("products")
          .update({
            competitor_search_cache: searchResults,
            competitor_search_cached_at: new Date().toISOString(),
          })
          .eq("id", productId);
        if (cacheError) {
          logError("api/submit-product.suggestCompetitors.cacheWrite", cacheError, { productId });
        }
      }
    }

    const { competitors: suggestions, groundedInSearch } = await suggestCompetitors({
      name: product.name,
      description: product.description,
      categoryName: product.category?.name,
      searchResults,
    });

    if (suggestions.length === 0) {
      return res.status(200).json({ competitors: [], groundedInSearch });
    }

    const competitors = await Promise.all(
      suggestions.map(async (s) => {
        try {
          const { data: matches, error: searchError } = await supabaseAdmin.rpc(
            "search_products",
            { search_term: s.name, result_limit: 1 }
          );
          if (searchError) {
            logError("api/submit-product.suggestCompetitors.search", searchError, {
              name: s.name,
            });
          }
          const match = matches?.[0];
          return {
            name: s.name,
            domain: s.domain,
            existingProduct: match
              ? {
                  id: match.id,
                  name: match.name,
                  slug: match.slug,
                  rating: match.rating,
                  category_id: match.category_id,
                  logo_url: match.logo_url,
                }
              : null,
          };
        } catch (err) {
          logError("api/submit-product.suggestCompetitors.matchOne", err, { name: s.name });
          return { name: s.name, domain: s.domain, existingProduct: null };
        }
      })
    );

    return res.status(200).json({ competitors, groundedInSearch });
  } catch (err) {
    logError("api/submit-product.suggestCompetitors", err, { productId });
    return res.status(500).json({ error: "Could not load competitor suggestions" });
  }
}

async function handleGuessCategory(req, res) {
  const { url } = req.query;
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: "url query param is required" });
  }
  try {
    const normalizedUrl = normalizeUrl(String(url));
    const metadata = await fetchMetadata(normalizedUrl);
    const text = [metadata.title, metadata.description].filter(Boolean).join(" ");
    const guessedSlug = guessCategorySlug(text);

    if (!guessedSlug) {
      return res.status(200).json({ categorySlug: null });
    }

    const { data: category, error } = await supabaseAdmin
      .from("categories")
      .select("id, slug, name, icon")
      .eq("slug", guessedSlug)
      .maybeSingle();

    if (error) {
      logError("api/submit-product.guessCategory", error, { guessedSlug });
      return res.status(200).json({ categorySlug: null });
    }

    return res.status(200).json({ category: category ?? null });
  } catch (err) {
    logError("api/submit-product.guessCategory", err, { url });
    // Failure here should never block the form — just no suggestion.
    return res.status(200).json({ category: null });
  }
}

async function handleSearch(req, res) {
  const { q, category, exclude } = req.query;

  try {
    if (q && String(q).trim()) {
      const term = String(q).trim();
      const { data, error } = await supabaseAdmin.rpc("search_products", {
        search_term: term,
        result_limit: 8,
      });

      if (error) {
        logError("api/submit-product.search", error, { term });
        return res.status(500).json({ error: "Search failed" });
      }

      const products = (data ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        rating: r.rating,
        category_id: r.category_id,
        logo_url: r.logo_url,
        category: r.category_name
          ? { name: r.category_name, icon: r.category_icon, slug: r.category_slug }
          : null,
      }));

      return res.status(200).json({ products });
    }

    if (category) {
      let query = supabaseAdmin
        .from("products")
        .select(
          "id, name, slug, rating, category_id, logo_url, category:category_id(name, icon, slug)"
        )
        .eq("status", "active")
        .eq("category_id", category)
        .order("rating", { ascending: false })
        .limit(6);

      if (exclude) query = query.neq("id", exclude);

      const { data, error } = await query;
      if (error) {
        logError("api/submit-product.recommend", error, { category, exclude });
        return res.status(500).json({ error: "Could not load recommendations" });
      }
      return res.status(200).json({ products: data ?? [] });
    }

    logWarn("api/submit-product.search", "Missing q or category query param");
    return res.status(400).json({ error: "q or category query param is required" });
  } catch (err) {
    logError("api/submit-product.search", err, { q, category, exclude });
    return res.status(500).json({ error: "Search failed" });
  }
}

async function handleCreate(req, res) {
  try {
    const { name, websiteUrl, categoryId, description, logoDataUrl } =
      req.body || {};

    // Website URL is the only hard requirement now — name and category
    // both auto-fill (name from the scraped page title, category via
    // Gemini classification alongside the description) as part of the
    // streamlined "just paste a URL" flow. A manually-provided name/
    // category always takes precedence when given, same as logo/
    // description already worked.
    const missing = [];
    if (!websiteUrl || !websiteUrl.trim()) missing.push("website URL");

    if (missing.length > 0) {
      logWarn("api/submit-product.create", "Missing required fields", { missing });
      return res.status(400).json({
        error: `Missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
      });
    }

    const cleanWebsiteUrl = normalizeUrl(websiteUrl);

    // Fetch metadata whenever ANY of name/description/logo/category needs
    // auto-filling — broadened from the old condition (which only
    // covered description/logo) specifically to cover the new
    // streamlined flow where none of those were provided at all.
    let metadata = { title: null, description: null, imageUrl: null, textSnippet: null };
    const needsAutoName = !name || !name.trim();
    const needsAutoDescription = !description || !description.trim();
    const needsAutoLogo = !logoDataUrl;
    const needsAutoCategory = !categoryId;
    if (needsAutoName || needsAutoDescription || needsAutoLogo || needsAutoCategory) {
      metadata = await fetchMetadata(cleanWebsiteUrl);
    }

    // Name: manual > cleaned scraped title > domain-derived fallback
    // (e.g. "example.com" -> "Example"). Only the domain fallback is
    // guaranteed to succeed, so it's the true last resort.
    let cleanName = name?.trim();
    if (!cleanName) {
      cleanName = cleanTitleForName(metadata.title) || deriveNameFromDomain(cleanWebsiteUrl);
    }
    const slug = slugify(cleanName) || `product-${Date.now()}`;

    let finalDescription = description?.trim() || metadata.description || null;
    let aiCategorySlug = null;

    // Categories are only fetched (a small, cheap query) when actually
    // needed for classification — no point querying them for a manually
    // categorized submission.
    let categoriesForClassification = null;
    if (needsAutoCategory) {
      const { data: cats, error: catsError } = await supabaseAdmin
        .from("categories")
        .select("slug, name");
      if (catsError) {
        logError("api/submit-product.create.fetchCategories", catsError, { slug });
      } else {
        categoriesForClassification = cats;
      }
    }

    if (!finalDescription && metadata.title) {
      // Structural gap: this specific site has no og:description,
      // twitter:description, OR plain meta description. cheerio's body
      // text is also our fallback input to Gemini below — but on
      // JS-rendered/SPA sites, the raw server HTML cheerio sees has
      // little or no real content either (everything's injected by
      // client-side JS after load). When that's the case, ask Jina
      // Reader (renders in a real headless browser) for the visible text
      // instead, and feed THAT to Gemini. Free, no API key required.
      let textForGemini = metadata.textSnippet;
      const textIsThin =
        !textForGemini || textForGemini.length < THIN_TEXT_SNIPPET_THRESHOLD;
      if (textIsThin) {
        const jinaText = await fetchJinaRenderedText(cleanWebsiteUrl);
        if (jinaText) textForGemini = jinaText;
      }

      // Still falls through to requiring a manual description if this
      // also fails (no API key set, timeout, unusable response, etc.).
      // Category classification rides along in the SAME call when
      // categoriesForClassification is set — see generateDescription in
      // lib/gemini.js for why this is one combined call instead of two.
      const result = await generateDescription({
        title: metadata.title,
        textSnippet: textForGemini,
        categories: categoriesForClassification || undefined,
      });
      finalDescription = result.description;
      aiCategorySlug = result.categorySlug;
    }

    if (!finalDescription) {
      // Nothing worked — manual, auto-fetch, and the Gemini fallback all
      // came up empty. This is the one place we still ask the person for
      // something, since a product with zero description anywhere makes
      // for a genuinely unhelpful battle page.
      logWarn("api/submit-product.create", "No description available (manual, auto-fetch, or AI)", {
        slug,
      });
      return res.status(400).json({
        error:
          "Couldn't find a description on that site automatically — please add a short one.",
      });
    }
    if (finalDescription.length > 280) {
      finalDescription = finalDescription.slice(0, 280);
    }

    // Resolve the final category: manual selection always wins; then the
    // AI classification that may have run alongside description
    // generation above; then the older naive keyword-matching guesser
    // (guessCategorySlug, defined below) as a last resort for cases
    // where Gemini wasn't invoked at all (e.g. the site already had a
    // real meta description, so the combined call never ran) or failed
    // to classify. Left null if nothing matches — category_id is a
    // nullable column, an uncategorized product isn't a hard error.
    let finalCategoryId = categoryId || null;
    if (!finalCategoryId && aiCategorySlug && categoriesForClassification) {
      const matched = categoriesForClassification.find((c) => c.slug === aiCategorySlug);
      if (matched) {
        const { data: catRow } = await supabaseAdmin
          .from("categories")
          .select("id")
          .eq("slug", aiCategorySlug)
          .single();
        if (catRow) finalCategoryId = catRow.id;
      }
    }
    if (!finalCategoryId && needsAutoCategory) {
      const guessedSlug = guessCategorySlug(`${metadata.title || ""} ${finalDescription || ""}`);
      if (guessedSlug) {
        const { data: catRow } = await supabaseAdmin
          .from("categories")
          .select("id")
          .eq("slug", guessedSlug)
          .single();
        if (catRow) finalCategoryId = catRow.id;
      }
    }

    // Logo: use the manually-uploaded PNG if provided (validated exactly
    // as before). Otherwise, try auto-fetching one from the site — if
    // that also fails, the product just has no logo (falls back to a
    // letter avatar in the UI), which is NOT a hard error per the
    // "don't block creation on a logo" requirement.
    let logoUrl = null;
    let pngBuffer = null;

    if (logoDataUrl) {
      const match = /^data:(image\/\w+);base64,(.+)$/.exec(logoDataUrl);
      if (!match) {
        logWarn("api/submit-product.create", "Malformed logo data URL", { slug });
        return res.status(400).json({ error: "Logo must be a valid image file" });
      }
      const [, mimeType, base64Payload] = match;
      if (mimeType !== ALLOWED_LOGO_MIME) {
        logWarn("api/submit-product.create", "Rejected non-PNG logo", {
          slug,
          mimeType,
        });
        return res.status(400).json({ error: "Logo must be a PNG image" });
      }
      try {
        pngBuffer = Buffer.from(base64Payload, "base64");
      } catch (err) {
        logError("api/submit-product.decodeLogo", err, { slug });
        return res.status(400).json({ error: "Logo could not be decoded" });
      }
      if (pngBuffer.byteLength > MAX_LOGO_BYTES) {
        return res.status(400).json({ error: "Logo must be smaller than 2MB" });
      }
    } else {
      // Auto-fetch order: Brandfetch (curated logo database, best
      // quality/coverage) → the OG-image/favicon scrape already captured
      // in metadata.imageUrl → give up (falls back to a letter avatar in
      // the UI, not a hard error).
      let domain = null;
      try {
        domain = new URL(cleanWebsiteUrl).hostname.replace(/^www\./, "");
      } catch (err) {
        logWarn("api/submit-product.create", "Could not parse domain for Brandfetch", {
          slug,
          cleanWebsiteUrl,
        });
      }

      if (domain) {
        pngBuffer = await fetchBrandfetchLogo(domain);
      }

      if (!pngBuffer && metadata.imageUrl) {
        pngBuffer = await fetchAndConvertLogo(metadata.imageUrl);
      }

      if (!pngBuffer) {
        logWarn("api/submit-product.create", "Auto-fetch logo failed, continuing without one", {
          slug,
          domain,
          imageUrl: metadata.imageUrl,
        });
      }
    }

    let brandColor = null;
    let brandTextColor = null;
    if (pngBuffer) {
      const extracted = await extractBrandColor(pngBuffer);
      if (extracted) {
        brandColor = extracted.brandColor;
        brandTextColor = extracted.brandTextColor;
        logInfo("api/submit-product.create", "Brand color extracted", {
          slug,
          brandColor,
          brandTextColor,
        });
      } else {
        logWarn("api/submit-product.create", "Brand color extraction failed, falling back to hash tint", {
          slug,
        });
      }
    }

    if (pngBuffer) {
      const logoPath = `${slug}-${Date.now()}.png`;

      // Requires a public storage bucket named "logos", PNG-only, 2MB
      // limit — create it once in the Supabase dashboard (Storage → New
      // bucket → public, then restrict file types/size in the bucket
      // settings). See README for the exact steps.
      const { error: uploadError } = await supabaseAdmin.storage
        .from("logos")
        .upload(logoPath, pngBuffer, { contentType: ALLOWED_LOGO_MIME });

      if (uploadError) {
        const bucketMissing = /bucket not found/i.test(uploadError.message || "");
        logError("api/submit-product.uploadLogo", uploadError, {
          slug,
          logoPath,
          hint: bucketMissing
            ? "The 'logos' storage bucket doesn't exist yet — create it in Supabase dashboard → Storage → New bucket (public, PNG only, 2MB limit). See README."
            : undefined,
        });
        // Logo upload failing is NOT fatal to product creation — log it
        // clearly and continue without a logo rather than blocking.
      } else {
        const { data: publicUrlData, error: publicUrlError } =
          supabaseAdmin.storage.from("logos").getPublicUrl(logoPath);
        if (publicUrlError) {
          logError("api/submit-product.getPublicUrl", publicUrlError, { logoPath });
        }
        logoUrl = publicUrlData?.publicUrl ?? null;
      }
    }

    const { data: product, error: insertError } = await supabaseAdmin
      .from("products")
      .insert({
        name: cleanName,
        slug,
        description: finalDescription,
        logo_url: logoUrl,
        website_url: cleanWebsiteUrl,
        category_id: finalCategoryId,
        status: "active", // auto-published, no review queue
        brand_color: brandColor,
        brand_text_color: brandTextColor,
      })
      .select("id, name, slug, rating, category_id, logo_url, website_url, description, brand_color, brand_text_color")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        logWarn("api/submit-product.create", "Duplicate product name rejected", {
          slug,
        });
        return res
          .status(409)
          .json({ error: "A product with that name already exists" });
      }
      logError("api/submit-product.insert", insertError, {
        slug,
        name: cleanName,
      });
      return res.status(500).json({ error: "Could not submit product" });
    }

    return res.status(200).json({ product });
  } catch (err) {
    logError("api/submit-product.create", err, { body: req.body });
    return res
      .status(500)
      .json({ error: "Something went wrong submitting your product" });
  }
}

// Next's default API route body limit is 1MB. A logo up to the bucket's
// 2MB PNG limit, base64-encoded (which inflates size by ~33%), comes in
// around 2.7MB — comfortably over that default, which was silently
// failing every submission with a real logo attached (413 "Body
// exceeded 1mb", visible in Vercel's function logs). Raised to 4MB for
// headroom.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4mb",
    },
  },
};

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      if (req.query.action === "guess-category") {
        return handleGuessCategory(req, res);
      }
      if (req.query.action === "suggest-question") {
        return handleSuggestQuestion(req, res);
      }
      if (req.query.action === "suggest-competitors") {
        return handleSuggestCompetitors(req, res);
      }
      return handleSearch(req, res);
    }
    if (req.method === "POST") {
      return handleCreate(req, res);
    }
    res.setHeader("Allow", ["GET", "POST"]);
    logWarn("api/submit-product", "Rejected unsupported method", {
      method: req.method,
    });
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    logError("api/submit-product", err, { method: req.method });
    return res.status(500).json({ error: "Something went wrong" });
  }
}
