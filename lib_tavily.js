import { logWarn, logInfo } from "./logger";

// Grounds competitor suggestions in real, current web results instead of
// relying on Gemini's training memory alone (which can be stale or miss
// newer/niche products entirely). Free tier: 1,000 credits/month,
// recurring, no card required — a basic search costs 1 credit. Never
// throws; returns an empty array on any failure so the caller can fall
// back to Gemini-only suggestions (the previous behavior) rather than
// breaking the whole flow over a search provider hiccup.
const TAVILY_TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;

export async function searchCompetitors(productName) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    logWarn("lib/tavily.searchCompetitors", "TAVILY_API_KEY not set — skipping real search grounding", {
      productName,
    });
    return [];
  }
  if (!productName) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: apiKey,
        query: `${productName} competitors alternatives`,
        search_depth: "basic", // 1 credit, not the "advanced" 2-credit tier — plenty for a competitor list
        max_results: MAX_RESULTS,
      }),
    });

    if (!res.ok) {
      logWarn("lib/tavily.searchCompetitors", "Non-OK response", {
        productName,
        status: res.status,
      });
      return [];
    }

    const body = await res.json();
    const results = (body?.results || [])
      .slice(0, MAX_RESULTS)
      .map((r) => ({
        title: r.title || "",
        content: (r.content || "").slice(0, 400), // keep the Gemini prompt this feeds into small
        url: r.url || "",
      }));

    logInfo("lib/tavily.searchCompetitors", "Search succeeded", {
      productName,
      resultCount: results.length,
    });
    return results;
  } catch (err) {
    logWarn("lib/tavily.searchCompetitors", "Failed", {
      productName,
      error: err?.message,
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
