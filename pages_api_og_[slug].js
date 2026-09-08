import { ImageResponse } from "@vercel/og";
import { supabaseAdmin as supabase } from "../../../supabase-admin";
import { logError, logWarn } from "../../../lib/logger";

// GET /api/og/[slug] -> a 1200x630 PNG summarizing the battle, styled to
// look like an actual screenshot of the app's own scoreboard (logos,
// progress bar, brand fonts) rather than a plain text sentence. This is
// what the Share button and any social link preview (WhatsApp/X/iMessage
// OG card) points at.
//
// Runs on the edge runtime, which @vercel/og is built for. Falls back to
// a plain-text/minimal image on any error rather than a broken image —
// social platforms handle a missing/broken OG image poorly.
export const config = {
  runtime: "edge",
};

const WIDTH = 1200;
const HEIGHT = 630;

// Same identity-based color hash as lib/categoryIcons.js's
// getAvatarTint — duplicated here on PURPOSE rather than imported.
// categoryIcons.js pulls in lucide-react (a full React icon library),
// which has no place in an edge image-rendering function; importing it
// here would drag icon-component code into the edge bundle for no
// reason. This is ~10 lines of pure string hashing, cheap to keep in
// sync manually versus adding a cross-runtime dependency.
const AVATAR_TINTS = [
  { bg: "#F7EAE0", text: "#C08552" },
  { bg: "#EAF0EA", text: "#6B8F71" },
  { bg: "#FBF3DF", text: "#8A6A16" },
  { bg: "#E2F5F4", text: "#0EA5A0" },
  { bg: "#E9F5EC", text: "#1F9D55" },
  { bg: "#FCE7F3", text: "#BE185D" },
];
function getAvatarTint(name) {
  const str = (name || "?").toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

// @vercel/og (Satori) can't reach Google Fonts on its own — it needs
// actual font file BYTES passed via the `fonts` option, not a CSS
// @font-face declaration. This fetches Google's CSS2 endpoint (stable,
// documented, doesn't require hardcoding a gstatic file hash that
// could rotate), pulls the actual .ttf URL out of it, then fetches
// that. Runs fine on Vercel's edge network (real internet access at
// request time) even though this couldn't be tested from a sandboxed
// dev environment without network access.
async function loadGoogleFont(family, weight) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family
  )}:wght@${weight}`;
  const css = await (await fetch(cssUrl)).text();
  const match = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/);
  if (!match) throw new Error(`No font file URL found for ${family} ${weight}`);
  const fontRes = await fetch(match[1]);
  if (!fontRes.ok) throw new Error(`Font file fetch failed for ${family} ${weight}`);
  return fontRes.arrayBuffer();
}

// Loads both brand fonts in parallel. Returns null (not a throw) on any
// failure so the caller can fall back to system fonts — a slightly
// off-brand share image beats a broken one.
async function loadBrandFonts() {
  try {
    const [anton, mono] = await Promise.all([
      loadGoogleFont("Anton", 400),
      loadGoogleFont("JetBrains+Mono", 700),
    ]);
    return [
      { name: "Anton", data: anton, weight: 400, style: "normal" },
      { name: "JetBrains Mono", data: mono, weight: 700, style: "normal" },
    ];
  } catch (err) {
    logWarn("api/og/[slug].loadBrandFonts", "Falling back to system fonts", {
      error: err?.message,
    });
    return null;
  }
}

function errorImage(message) {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#FBF6EF",
          fontSize: 32,
          color: "#2B2620",
        }}
      >
        {message}
      </div>
    ),
    { width: WIDTH, height: HEIGHT }
  );
}

function Logo({ url, name, size, tint, dimmed }) {
  const wrapStyle = {
    width: size,
    height: size,
    borderRadius: size * 0.22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    background: tint.bg,
    opacity: dimmed ? 0.55 : 1,
  };
  if (url) {
    return (
      <div style={wrapStyle}>
        <img src={url} width={size} height={size} style={{ objectFit: "cover" }} />
      </div>
    );
  }
  return (
    <div style={wrapStyle}>
      <div
        style={{
          fontFamily: "Anton",
          fontSize: size * 0.4,
          color: tint.text,
          display: "flex",
        }}
      >
        {(name || "?")[0]?.toUpperCase()}
      </div>
    </div>
  );
}

function Badge({ children, bg, color }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "8px 18px",
        borderRadius: 999,
        background: bg,
        color,
        fontFamily: "JetBrains Mono",
        fontSize: 20,
        fontWeight: 700,
      }}
    >
      {children}
    </div>
  );
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const slug = url.pathname.split("/").pop();

    if (!slug) {
      return errorImage("Zoloop");
    }

    const { data: battle, error } = await supabase
      .from("battles")
      .select(
        "slug, status, votes_a, votes_b, votes_a_boost, votes_b_boost, views, clicks, question, created_by, product_a:product_a_id(name, logo_url, category:category_id(name)), product_b:product_b_id(name, logo_url)"
      )
      .eq("slug", slug)
      .single();

    if (error || !battle) {
      if (error) {
        logError("api/og/[slug]", error, { slug });
      }
      return errorImage("Battle not found");
    }

    const votesA = battle.votes_a + (battle.votes_a_boost ?? 0);
    const votesB = battle.votes_b + (battle.votes_b_boost ?? 0);
    const total = votesA + votesB;
    const pctA = total > 0 ? Math.round((votesA / total) * 100) : 50;
    const pctB = 100 - pctA;
    const aLeads = pctA >= pctB;

    // FIX: this used to always say "X defeated Y" — even for a battle
    // that's still live, which claims a final outcome that hasn't
    // happened yet and could still flip with the next vote. Only say
    // "defeated" once the battle has actually completed; say "leads"
    // while it's still live.
    const isCompleted = battle.status === "completed";
    const verb = isCompleted ? "defeated" : "leads";
    const leaderName = aLeads ? battle.product_a.name : battle.product_b.name;
    const otherName = aLeads ? battle.product_b.name : battle.product_a.name;
    const leaderPct = Math.max(pctA, pctB);
    const otherPct = Math.min(pctA, pctB);

    const tintA = getAvatarTint(battle.product_a.name);
    const tintB = getAvatarTint(battle.product_b.name);

    const fonts = await loadBrandFonts();
    const displayFont = fonts ? "Anton" : "sans-serif";
    const monoFont = fonts ? "JetBrains Mono" : "sans-serif";

    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            padding: "56px 64px",
            background: "#FFFFFF",
            fontFamily: "sans-serif",
          }}
        >
          {/* header row: wordmark + ZOLOOP PICK if applicable */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  background: "linear-gradient(135deg, #C08552, #6B8F71)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  fontFamily: displayFont,
                  fontSize: 20,
                }}
              >
                Z
              </div>
              <div style={{ fontFamily: displayFont, fontSize: 26, color: "#2B2620", display: "flex" }}>
                ZOLOOP
              </div>
            </div>
            {battle.created_by === "admin" && (
              <Badge bg="#FBF3DF" color="#8A6A16">
                ★ ZOLOOP PICK
              </Badge>
            )}
          </div>

          {/* the actual debate question, if there is one */}
          {battle.question && (
            <div
              style={{
                display: "flex",
                fontFamily: monoFont,
                fontSize: 22,
                color: "#8A8072",
                marginTop: 28,
                maxWidth: 1000,
              }}
            >
              {battle.question}
            </div>
          )}

          {/* matchup row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 36,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
              <Logo url={battle.product_a.logo_url} name={battle.product_a.name} size={120} tint={tintA} dimmed={!aLeads} />
              <div style={{ fontFamily: displayFont, fontSize: 24, color: aLeads ? "#2B2620" : "#8A8072", display: "flex" }}>
                {battle.product_a.name}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
              <div style={{ display: "flex", fontFamily: monoFont, fontSize: 72, fontWeight: 700, color: "#C08552" }}>
                {pctA}%
              </div>
            </div>

            <div style={{ display: "flex", fontFamily: displayFont, fontSize: 30, color: "#8A8072" }}>VS</div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
              <div style={{ display: "flex", fontFamily: monoFont, fontSize: 72, fontWeight: 700, color: "#6B8F71" }}>
                {pctB}%
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
              <Logo url={battle.product_b.logo_url} name={battle.product_b.name} size={120} tint={tintB} dimmed={aLeads} />
              <div style={{ fontFamily: displayFont, fontSize: 24, color: !aLeads ? "#2B2620" : "#8A8072", display: "flex" }}>
                {battle.product_b.name}
              </div>
            </div>
          </div>

          {/* progress bar */}
          <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", marginTop: 32 }}>
            <div style={{ display: "flex", width: `${pctA}%`, background: "#C08552" }} />
            <div style={{ display: "flex", width: `${pctB}%`, background: "#6B8F71" }} />
          </div>

          {/* headline result sentence */}
          <div style={{ display: "flex", fontFamily: displayFont, fontSize: 34, color: "#2B2620", marginTop: 32 }}>
            {leaderName} {verb} {otherName} {leaderPct}%–{otherPct}%
          </div>

          {/* stat badges instead of dot-joined text */}
          <div style={{ display: "flex", gap: 14, marginTop: 24 }}>
            <Badge bg="#FBF6EF" color="#2B2620">
              {total.toLocaleString()} votes
            </Badge>
            {battle.product_a.category?.name && (
              <Badge bg="#FBF6EF" color="#2B2620">
                {battle.product_a.category.name}
              </Badge>
            )}
            <Badge bg="#FBF6EF" color="#2B2620">
              {(battle.views ?? 0).toLocaleString()} views
            </Badge>
          </div>
        </div>
      ),
      { width: WIDTH, height: HEIGHT, fonts: fonts ?? undefined }
    );
  } catch (err) {
    logError("api/og/[slug]", err);
    return errorImage("Zoloop");
  }
}
