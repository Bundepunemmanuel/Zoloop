# ZOLOOP

The internet picks the winner. Head-to-head product battles, voted on by
real people, ranked by rating.

## Stack

- Next.js 15.3.6 (Pages Router)
- Tailwind CSS
- Supabase (Postgres + Storage)
- Deployed on Vercel

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. In the Supabase SQL editor:

   - **First-time setup** (brand new database): run the whole
     `supabase-schema.sql` file top to bottom, then
     `supabase-migration-description-limit.sql`, then `supabase-seed.sql`,
     then enable Row Level Security on `products`, `categories`,
     `battles`, `votes` (Table Editor → each table → RLS toggle) and run
     `supabase-rls.sql`.
   - **Already-running database** (you've run an earlier version of this
     file before): do **NOT** re-run the whole file — the `create table`
     statements near the top aren't safe to repeat and will fail with
     `relation "..." already exists`. Instead, run only the
     `-- ---------- migration ...` blocks near the bottom of
     `supabase-schema.sql` (everything from the first
     `-- ---------- migration` comment to the end of the file — 7 blocks
     as of the admin dashboard + boost/vote-dedup update). All of them
     are idempotent — safe to run again even if you're not sure whether
     you already ran them. Then re-run `supabase-seed.sql` (also
     idempotent) to pick up the new category list.
     If you're already running an earlier version of this project and
     only need what's new in this update, migration 7 (vote/click
     boosts, `battles.created_by`, `votes.ip_hash`) is the one you're
     missing — safe to run on its own.

3. One-time Storage setup: in the Supabase dashboard, go to
   **Storage → New bucket**, name it `logos`, mark it **public**, and set
   the bucket's file type restriction to **PNG only** with a **2MB** size
   limit — that matches the limits enforced in `pages/api/submit-product.js`.
   If you skip this step, logo uploads fail with a `Bucket not found`
   error (visible in your logs, see below) until the bucket exists.

4. AI features (competitor suggestions, non-generic battle questions, and
   the description-only fallback for sites with no meta description) need
   a Gemini API key. In Vercel → your project → Settings →
   Environment Variables, add `GEMINI_API_KEY` (server-only — never
   prefixed with `NEXT_PUBLIC_`, so it's never sent to the browser). Get
   a key from Google AI Studio. **Everything else in this app works fine
   without this** — every Gemini call in `lib/gemini.js` fails gracefully
   and falls back to non-AI behavior (generic battle question, keyword-
   based category guess, requiring a manual description) if the key is
   missing or a request fails.

4. Copy `.env.local.example` to `.env.local` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from
     Supabase Settings → API (safe to expose, RLS limits what it can do)
   - `SUPABASE_SERVICE_ROLE_KEY` — same page, the `service_role` key.
     **Never** prefix this with `NEXT_PUBLIC_` or it'll ship to the
     browser. Keep it out of any public chat, repo, or screenshot.
   - `BRANDFETCH_CLIENT_ID` — optional. Logo auto-fetch tries Brandfetch's
     Logo API first (free tier, ~1M renders/mo, Client ID only — no
     secret key). Get one from the Brandfetch developer portal. If unset,
     logo auto-fetch just falls through to the existing OG-image/favicon
     scrape, same as before this existed.
   - `JINA_API_KEY` — optional. The description auto-fetch fallback uses
     Jina Reader (r.jina.ai) for JS-rendered/SPA sites cheerio can't read
     — works with **no key at all** on a shared free rate limit; setting
     this raises that limit but is never required.
   - `ADMIN_EMAILS` — comma-separated list of emails allowed into the
     admin dashboard at `/emmybund` (e.g.
     `you@example.com,teammate@example.com`). Falls back to a hardcoded
     default list in `lib/requireAdmin.js` if unset — **set this
     explicitly in production.**
   - `NEXT_PUBLIC_SITE_URL` — recommended, e.g. `https://zoloop.vercel.app`
     or your custom domain. Used to build the absolute `og:image` URL on
     battle pages (link previews on WhatsApp/X/iMessage need an absolute
     URL, not a relative one — this is what was broken before). If
     unset, it's derived from the request's own host header instead, so
     preview deployments still work, but setting it explicitly in
     production avoids any ambiguity.

5. Admin dashboard (`/emmybund`, not linked anywhere in the site's UI):
   create a Supabase Auth user for each admin (Supabase dashboard →
   Authentication → Users → Add user, email + password) and make sure
   that email is in `ADMIN_EMAILS`. Sign in at `/emmybund` with that
   email/password to edit product ratings and battle votes directly.

6. Run locally:

   ```
   npm run dev
   ```

7. Deploy: push to GitHub, import in Vercel, add the env vars above in
   the Vercel project settings, deploy. Vercel Web Analytics
   (`<Analytics />` in `pages/_app.js`) starts collecting automatically
   once deployed on Vercel — no extra env var needed.

## What's here (MVP scope)

- `products`, `categories`, `battles`, `votes` tables
- RLS: `anon` can only read; all writes go through the service-role key,
  used exclusively inside `pages/api/*.js` server routes
- **Rating system** (`elo.js`): dynamic Elo. New products start at 1000,
  floored at 0 — a win against a stronger opponent moves your rating more
  than a win against a weaker one. Ratings update per individual vote
  with a small K-factor (4) rather than once per completed battle, since
  a battle can accumulate hundreds of votes. Existing products from
  before the 1000 baseline shipped keep whatever rating they already had.
- **Matchmaking gate**: two products can only battle if their ratings are
  within 200 points of each other (`isMatchAllowed` in `elo.js`),
  enforced server-side in `pages/api/vote.js` at battle-creation time.
- **Rematch cooldown**: the same pairing, under the *same battle
  question*, can't create a new battle while one between them is still
  live, or if they fought over that exact question within the last 24h.
  The same two products CAN run separate simultaneous battles under
  different questions (e.g. "best for coding" vs "best for writing").
- **Battle duration**: required at creation — 1 hour, 24 hours, or 7
  days, chosen from a fixed whitelist server-side (never a client-sent
  timestamp). `starts_at`/`ends_at` are stored and shown on the battle
  card. Once `ends_at` passes, the battle is lazily flipped from `live`
  to `completed` (with a winner set from whichever side had more votes,
  or no winner if tied) the next time anyone loads it — no cron job.
- **Battle question**: every battle stores the specific question it's
  settling (`battles.question`), shown on the battle card. Defaults to
  "Which is better: A or B?" if the person doesn't customize it.
- **Views**: every `/battle/[slug]` page load increments that battle's
  `views` counter, shown alongside its vote count. A `clicks` column
  also exists on `battles` for future website-click tracking, but
  nothing writes to it yet — no click-tracking redirect endpoint has
  been built.
- **Fuzzy, typo-tolerant product search**: `search_products()` (a
  Postgres function defined in `supabase-schema.sql`, using the
  `pg_trgm` extension) ranks results by string similarity, not just
  substring match — catches things like "chatgtp" or partial spelling.
  Also checks a `products.aliases` column for exact alias matches (e.g.
  "GPT" → ChatGPT), though there's no UI yet for adding aliases — the
  column just exists for now, fillable manually via the Supabase table
  editor.
- Server-side voting (`pages/api/vote.js`) with 1-vote-per-IP-per-battle
  dedup, dynamic Elo rating updates, and a `rating_history` row logged on
  every vote (powers the Rankings page's Form arrows and confidence tiers)
- Product creation (`pages/api/submit-product.js`, `POST`) — only name,
  website URL, and category are required. **Description and logo are
  optional**: if left blank, the server fetches the website's Open Graph
  tags (or a real `<link rel="icon">`/`apple-touch-icon`, falling back to
  `/favicon.ico` last) and uses those instead, converting any image to
  PNG via `sharp`. A manually provided description or uploaded PNG logo
  always overrides the auto-fetched one. If auto-fetch fails and no
  description was given, product creation is rejected with a message
  asking for one — a completely blank description everywhere isn't
  allowed, but a missing logo is fine (falls back to a letter avatar).
  **Category is auto-suggested** from the site's title/description using
  plain keyword matching (`guessCategorySlug` — not AI/ML), shown as a
  pre-selected, clearly-labeled "(suggested)" chip the person can freely
  override. **Auto-publishes immediately** — no review queue.
- Product search + recommendations (`pages/api/submit-product.js`, `GET`)
  — `?q=text` for fuzzy search, `?category=id` for top-rated products in
  a category. Either battle slot can be filled first — there's no "your
  product" concept since this app has no accounts, so nothing is
  actually owned by anyone.
- Battle creation (`pages/api/vote.js`, `POST` with `action: "create"`) —
  takes two existing product ids, an optional custom question, and a
  required duration, creates a `status: "live"` battle immediately, no
  approval step.
- Homepage "Challenge a competitor" flow: one input —
  `yourproduct.com vs competitor.com` — parsed on the literal word " vs "
  between the two terms. Runs a fuzzy search for both sides at once, each
  showing results to pick from or a `+ Add "{term}"` inline mini-form if
  nothing matches. Once both sides are resolved, shows an editable
  battle-question field and the required duration picker, then
  "Create Battle".
- Persistent header nav (`Header.js`): Battles / Rankings / Categories /
  Challenge a competitor. Categories and Challenge a competitor route to
  `/` with a `?panel=categories` or `?panel=battle` query param — the
  homepage reads that param and expands the matching section inline.
  Still never a popup or native `<select>`, just relocated out of a
  homepage-only toggle row into the always-visible header.
- Rankings page (`/rankings`) with inline-expand category and time-range
  filters (Today / This week / This month / All time), three sort tabs
  (Top rated / Rising / Most battles), gold/silver/bronze tier styling
  for the top 3, a rating-confidence dot (Low/Medium/High, based on
  battle count), and a Form column (rank movement over ~24h, derived
  from `rating_history` — see the code comment on `computeForm` in
  `pages/rankings.js` for exactly what approximation this is).
- Battle pages (`/battle/[slug]`): category breadcrumb, Share/Visit×2
  action row, a stats row (battle views, website clicks), a related-
  battles section (same category, excluding the current one), and a
  richer post-vote result panel (who you voted for, current score, total
  voters, Share/Visit/Challenge-another actions) — shown both on the
  standalone battle page and wherever `BattleCard` is embedded (e.g. the
  homepage's live battle).
- Click tracking (`pages/api/click.js`) — every "Visit" link on a battle
  or product page routes through this redirect endpoint first, which
  increments `battles.clicks` and only ever redirects to a URL it looked
  up from the database itself (never a client-supplied redirect target,
  to avoid an open-redirect vulnerability).
- Shareable result-card images (`pages/api/og/[slug].js`, edge runtime,
  via `@vercel/og`) — a 1200×630 PNG summarizing a battle's result, used
  for the battle page's OG/Twitter meta tags and a direct
  "Download result card" link.
- Product pages (`/product/[slug]`) with a rating/record/win-rate/rank
  stat block and a battle history list showing WON/LOST/TIE/LIVE per
  matchup
- Responsive layout — no fixed mobile-only width, scales up with `md:`
  breakpoints

## Known simplifications (documented in code comments)

- Voter dedup is IP-based only (`pages/api/vote.js`) — not real fraud
  prevention yet, just enough for the MVP
- Rating updates per-vote with a small K-factor rather than batching once
  when a battle completes — see the comment at the top of `elo.js`
- The rematch cooldown and rating-gap matchmaking check happen at
  battle-*creation* time only — they don't affect an already-live battle
- Battle expiry is lazy (checked on read, not via a scheduled job), so a
  battle can sit "live" in the database for a little while after its
  `ends_at` has technically passed, until the next time someone loads
  the homepage or that battle's page
- No review queue on submissions — anything submitted goes live
  immediately, spam/abuse handling is not built
- Auto-fetched logos/descriptions depend on the target site actually
  having Open Graph tags and not blocking the fetch — sites that block
  bot user agents, have no OG data, or time out will fail auto-fetch
  gracefully (falling back to a letter avatar / requiring a manual
  description), not error out
- The "vs" input parser only recognizes the literal word " vs " (or
  "vs.") between the two terms — there's no natural-language fallback if
  someone phrases it differently
- Category auto-suggestion uses plain keyword matching against the
  site's title/description (`guessCategorySlug` in
  `pages/api/submit-product.js`) — not an LLM or any ML model, and it's
  honest about that. It will sometimes guess wrong or find nothing at
  all for niche products; it's always just a pre-selected starting
  point, never enforced.
- Fuzzy search (`search_products()`, using `pg_trgm`) is meaningfully
  better than plain substring matching but isn't a full search engine —
  no typo tolerance tuning, no synonym dictionary beyond the manually
  filled `aliases` column, which has no UI yet
- "Form" (rank movement on the Rankings page) compares a product's
  current rank to an *approximate* rank from ~24h ago, computed by
  taking whichever products already had `rating_history` by that cutoff
  and ranking just those against each other — then comparing that
  subset-ranking to today's full ranking. It's a reasonable signal, not
  a rigorous backtest. See `computeForm` in `pages/rankings.js`.
- The Rankings page's time-range filter (Today/This week/This
  month/All time) recomputes win/loss/battle counts for that window from
  actual completed battles, but the **rating** shown always reflects the
  current overall value — it is never a point-in-time snapshot for that
  window. A true time-windowed rating would require replaying rating
  history from an arbitrary baseline, which wasn't built.
- Click tracking (`pages/api/click.js`) counts a click any time someone
  follows a Visit link through the redirect — it doesn't currently
  de-duplicate repeat clicks from the same visitor the way voting does.

## Deliberately not built yet

Auth (beyond the admin dashboard), payments, badges, tournaments, a
public API. Also see the "Explicitly scoped out" note at the bottom of
this file for a few specific items from a source design doc that were
intentionally deferred.

### Product claiming, disputes, and verified battles (designed, not built)

**The problem this solves:** anyone can currently add any product and
put it in a battle — including a competitor's product the challenger
doesn't control. There's no ownership model, no way for the real company
to respond, and no recourse if a battle frames them unfairly. This
matters more once the "Challenge a competitor" flow is used as a growth
mechanic (see below) rather than an occasional feature, since it turns
"unaware third party gets compared" from an edge case into the default
outcome of the core acquisition loop.

**Design (not implemented):**

- `products.claim_status` (`unclaimed` | `claimed`), `claimed_by_email`,
  `claimed_at`. Claiming reuses Supabase Auth already in the project —
  a logged-in user can claim a product if their email's domain matches
  the product's `website_url` domain. No new email-verification
  infrastructure needed.
- `battles.challenger_product_id` — which side initiated the battle, so
  the app can show "You were challenged by X" to the other side. No cold
  outreach/scraped-contact emailing — surfacing happens in-app only,
  when the real founder eventually looks up their own product (which
  the challenger's own distribution of the battle naturally drives).
- A new `disputes` table (`battle_id`, `product_id` nullable, `reason`,
  `reporter_email` nullable, `status`) — reportable by anyone, no
  claiming or login required, feeding a new tab in the admin dashboard
  (`pages/emmybund.js`).
- **Tiered trust model**, not a single consent gate (a hard gate would
  kill the challenge/growth mechanic entirely — no incumbent opts in to
  being challenged):
  1. **Unclaimed challenge** (default, unblocked): battle goes live
     immediately, framed as a neutral head-to-head ("X vs Y — which
     would you choose?"), not the adversarial "prove us wrong" dare.
     Unclaimed side shows a visible, honest badge ("Y hasn't claimed
     this profile yet"). Votes display live and real, but do NOT feed
     the product's official Elo rating yet — the drama is real, the
     leaderboard is protected. Dispute flag available immediately.
  2. **Claimed mid-battle**: the challenged product's real owner claims
     their listing, unlocking editing rights, a right-of-reply on that
     battle, and future notifications. Votes start counting toward
     their real rating from the claim moment forward (not retroactively
     — replaying Elo history precisely was judged not worth the
     complexity for v1).
  3. **Verified battle** (both sides claimed): only here does the
     sharper "we think X is better than Y, prove us wrong" framing
     unlock in the Gemini prompt (`generateBattleQuestion` would take a
     `bothClaimed` boolean). Worth its own "VERIFIED BATTLE" badge —
     a battle both companies visibly opted into reads as more credible
     to voters, not just safer.
- Rate limit: block a second concurrent unclaimed challenge against the
  same competitor, so one product can't get piled on with multiple
  unflattering framings before its owner even knows Zoloop exists.

**Why this is documented here instead of built:** it's a genuinely large
feature (new table, tiered prompt logic, an Elo-update gate, new UI in
three+ existing pages) and touches the platform's core trust model —
worth building deliberately in its own pass rather than folded into
unrelated work.

### Becoming an ongoing platform, not a "launch once and forget" directory (designed, not built)

**The problem this solves:** a launch directory's core value (a badge,
one day of traffic) has a hard expiration date built into the format —
there's no mechanic pulling a founder back tomorrow. Zoloop's model is
*structurally* capable of an ongoing relationship instead (an evolving
rating, a re-challengeable leaderboard position), but right now nothing
actually exercises that — a battle ends and nothing brings anyone back.
Without the mechanics below, Zoloop risks being "launch once and forget"
with different packaging, not a real improvement on the category.

**Design (not implemented), roughly in build-priority order:**

1. **Evergreen search value on product pages.** A product's profile
   (`pages/product/[slug].js`) should accumulate a permanent, growing
   record across every completed battle, making it a genuinely useful
   page to land on from search a year later — not just traffic the day
   a battle is shared. Needs: `sitemap.xml`, per-page meta descriptions,
   structured data (schema.org) — none of which exist yet.
2. **Pull-back mechanics** — the biggest gap versus "ongoing" being real
   rather than theoretical:
   - Rematch requests (a losing product can challenge again, once,
     with real stakes)
   - Live momentum alerts during an active battle ("Claude just took
     the lead") — gives people a reason to check back mid-battle
   - "Notify me" when a product someone voted for or claimed gets
     challenged again
3. **Leaderboard with real memory**, not a daily reset. Surface
   streaks, rating trajectories over time, "biggest mover this week" —
   using the rating history that already exists in `rating_history`
   rather than only ever showing a flat current snapshot.
4. **Solve supply the way directories solve it — constantly.** Directory
   sites never run dry because there's always something new tomorrow;
   Zoloop's supply is bounded by real rivalries existing. Make battle
   creation (the Challenge mechanic, see the claiming/disputes section
   above) as easy and habitual for a founder as a directory submission,
   and proactively suggest rematches/new challenges to founders whose
   last battle ended a while ago, rather than waiting for them to think
   of it.
5. **Let founders build ON Zoloop, not just visit it once** — an
   embeddable live battle widget for a founder's own landing page (which
   also functions as a real, legitimate backlink back to Zoloop, unlike
   the click-tracking redirect discussed elsewhere in this file), plus a
   real founder-facing dashboard (separate from `pages/emmybund.js`)
   showing their own product's stats over time.
6. **All of this depends on the trust foundation above actually
   shipping first.** A directory's badge is a one-day claim nobody has
   to trust for long; an ongoing leaderboard makes a claim people keep
   watching — which means claiming, disputes, and retiring the seeding
   vote/click boost (see `lib/requireAdmin.js` env docs and the
   migration 7 notes above) matter *more* here, not less, once the
   platform is meant to be durable rather than a one-shot directory
   alternative.

## Recent changes (branding + hardening pass)

- **Branding**: colors (`tailwind.config.js` → `cornerA` / `cornerB`) now
  match the Zoloop logo exactly (`#FE4C12` orange, `#754BF6` purple,
  sampled directly from the logo file). The header/favicon now use
  `public/logo.png` (the real Zoloop mark) instead of the old placeholder
  SVG.
- **Categories**: `supabase-seed.sql` now seeds the full 25-category list
  (Books, Business, Developer Tools, … Weather). The category filter
  moved from mid-page to the top of the homepage, right under the header,
  and is a row of tappable pills — never a native `<select>`/popup. The
  "Add a product" form's category picker was changed from a `<select>`
  to the same pill style for the same reason.
- **Demo competitors removed**: `supabase-seed.sql` no longer seeds any
  demo products or battles (previously included Claude vs ChatGPT,
  Cursor vs Windsurf, etc.). It now seeds categories only — real
  products/battles come from the submission form or manual inserts.
- **Responsive design**: removed the hard `max-width: 480px` cap in
  `styles.css` that forced a mobile-only layout regardless of screen
  size. Layouts now scale through `sm:`/`md:`/`lg:` breakpoints
  throughout, and `pages/rankings.js` was moved from a stray root-level
  `rankings.js` (which meant `/rankings` 404'd) into `pages/` where
  Next.js's router actually picks it up.
- **Error handling + logging**: added `lib/logger.js`, a small structured
  logger (`logError` / `logWarn` / `logInfo`) that prints one JSON line
  per event with a timestamp, the calling context, and the full error
  message/stack. Every `getServerSideProps`, API route, and interactive
  client function (voting, submitting a product, uploading a logo,
  navigating categories) is now wrapped in try/catch and logs through it,
  so the cause of any failure is visible in your terminal (`npm run dev`)
  or your hosting provider's function logs (e.g. Vercel → Deployments →
  Functions). A top-level React error boundary in `pages/_app.js` also
  catches any render-time crash, logs it, and shows a plain fallback
  instead of a blank white screen.

## Recent changes (battle lifecycle + rating overhaul)

- **Rating system replaced**: was Elo (dynamic K-factor math), now a flat
  ±64-per-result system starting at 1000 for new products, floored at 0.
  `elo.js` keeps its filename to avoid touching every import site, but
  its content is now flat-delta scoring — see the comment at the top of
  that file. **Existing products keep their current rating** — the 1000
  starting point only applies to products created from now on.
- **Matchmaking gate**: added a 200-point rating-gap cap. Two products
  more than 200 points apart can't battle — checked server-side in
  `pages/api/vote.js` at creation time, not adjustable from the client.
- **Rematch cooldown**: a pairing can't refight immediately — blocked if
  they already have a live battle or fought within the last 24h, checked
  in both directions (A-vs-B and B-vs-A count as the same pairing).
- **Battle duration is now required**: 1 hour / 24 hours / 7 days, picked
  from a fixed list before "Start Battle" unlocks — never a client-sent
  timestamp. Stored as `starts_at`/`ends_at` (columns already existed in
  the schema, just unused before). Expiry is lazy: the next time the
  homepage or that battle's page is loaded after `ends_at` passes, it
  flips from `live` to `completed` with a winner set from whichever side
  had more votes (or no winner if tied).
- **Views tracking**: `battles.views` is a new column (migration at the
  bottom of `supabase-schema.sql` — re-run that file once, it's
  idempotent). Increments on every `/battle/[slug]` page load, shown next
  to the vote count on the battle card, trending list, and product battle
  history.
- **"Your product" language removed**: this app has no accounts, so
  nothing is actually owned by anyone — the battle-creation flow now
  says "Product A" / "Product B" instead of "your product", and either
  slot can be filled first. Recommended-opponent suggestions now key off
  whichever slot gets filled first, not a fixed "yours" side.
- **RED CORNER / BLUE CORNER labels removed** from the battle card.
- **Category lists now scroll horizontally** instead of wrapping into
  multiple rows — both the homepage's Categories tab and the "Add a
  product" form's category picker.
- **Rankings page**: added category filter tabs (same horizontal-scroll
  pills as the homepage) and gold/silver/bronze tier styling for the top
  3 spots. `LeaderboardTable.js` rows are now bordered cards instead of a
  plain divided list, and show the product's category icon.
- **Product pages**: bigger hero block, a "Visit ↗" pill button instead
  of a plain text link for the website URL (also added to battle pages),
  a new RANK stat (computed from how many active products currently sit
  above this one), and a battle history list with WON/LOST/TIE/LIVE
  badges per matchup instead of a plain status label.
- **Logo/website rendering fix**: `LeaderboardTable.js`, `BattleCard.js`,
  and `pages/product/[slug].js` previously always showed a letter avatar
  and never rendered the uploaded logo or linked the website — fixed
  everywhere logos/links appear.
- **PNG-only, 2MB logo validation**: matches the actual Supabase
  Storage bucket restrictions (previously accepted any image type up to
  1MB, mismatched against the bucket's real limits and causing confusing
  upload failures).

One pre-existing gap this pass did **not** fix: this README references
`supabase-migration-description-limit.sql` and `supabase-rls.sql` in the
setup steps, but neither file exists in the repo. You'll need to write
those (or skip the description length DB constraint / apply RLS manually
via the Supabase dashboard) before following step 2 above.

## Recent changes (single-input flow + Elo revert)

- **Rating system reverted to dynamic Elo.** A brief flat ±64-per-result
  system shipped in the previous pass; this pass reverted it back to
  proper Elo (`elo.js`), because a later product decision called for
  upset wins to matter more than expected ones. The 1000 starting
  rating, 0 floor, and 200-point matchmaking gate are all unchanged —
  only the per-vote math changed back.
- **Category list replaced.** The old 25-category consumer-app list
  (Books, Magazines & Newspapers, Medical, Navigation, Sports, Weather,
  etc.) is gone, replaced with a 22-category founder/competitor-focused
  list (AI, Productivity, Developer Tools, Design, Note-taking,
  Collaboration, SaaS, Marketing, Finance, Business, E-commerce, and
  more — see `supabase-seed.sql` for the full list). Old categories are
  deleted on re-seed **only if no product still references them**, so
  this can never orphan an existing product or violate a foreign key.
- **Battles now carry a `question`** (e.g. "Which is better for
  launching a product?"), separate from either product's own
  description. This is what lets the same two products run multiple
  simultaneous battles under different questions — the rematch cooldown
  is now scoped to (pairing + question), not just pairing.
- **Fuzzy, typo-tolerant search added** via Postgres's `pg_trgm`
  extension and a new `search_products()` SQL function (see
  `supabase-schema.sql`'s second migration block) — ranks results by
  string similarity instead of requiring an exact substring match, and
  also checks a new (currently UI-less) `aliases` column for exact
  alias matches.
- **Product creation drastically simplified.** Previously name, website,
  category, description, AND a PNG logo were all required up front. Now
  only name, website, and category are required — description and logo
  are optional and auto-fetched server-side from the site's Open Graph
  tags if left blank (logo converted to PNG via the new `sharp`
  dependency), with any manually provided value always taking priority
  over the auto-fetched one.
- **Homepage flow collapsed into one input.** The old two-box "Product
  A" / "Product B" search flow is gone, replaced with a single
  `yourproduct.com vs competitor.com` field that parses on " vs " and
  searches both sides at once. The "Start a Battle" tab is now labeled
  "⚔️ Challenge a competitor", and the final button is "Create Battle"
  instead of "Start Battle". The old standalone "🔥 Recommended
  opponents" chip feature (suggesting an opponent by category once one
  side was picked) was removed in favor of this faster typed-input path
  — it may be worth re-adding later as a fallback for people who don't
  know who to challenge, but it isn't there right now.
- **`pages/api/submit-product.js`'s `GET ?q=` search** now calls the new
  `search_products()` Postgres function via `.rpc()` instead of a plain
  `ilike` query, and reshapes the flat function result back into the
  same `{ category: { name, icon } }` nested shape the UI already
  expected, to minimize changes elsewhere.
- **`package.json`**: added `sharp` as a real dependency (previously only
  available in the assistant's own sandbox) — required for the
  auto-fetched-logo-to-PNG conversion. Run `npm install` again after
  pulling this change.

### Explicitly scoped out of this pass (from the same source doc)

These were called out in the flow-redesign document this pass was based
on, and left for later at the time. **Most have since shipped** — see
"Recent changes (UI overhaul + rankings/battle rebuild)" further down
for what changed and when. Still genuinely not built:

- Claiming/ownership (X login or magic-link auth) — no accounts exist in
  this app yet at all
- The `?product=...&vs=...` instant-battle URL pattern (the "vs" input
  on the homepage covers the same need today, just not via a
  shareable pre-filled URL)

### A note on what I could and couldn't verify myself

The auto-fetch-metadata and logo-conversion code
(`pages/api/submit-product.js`'s `fetchMetadata` / `fetchAndConvertLogo`)
was written carefully but **could not be tested end-to-end** in the
environment this was built in, which has no outbound network access. The
logic is sound and defensively written (timeouts, try/catch around every
fetch, graceful fallback on any failure), but real websites are messy —
expect to find and fix edge cases (unusual OG tag formats, sites that
block the request outright, redirects, etc.) once this runs against real
traffic on Vercel.

## Recent changes (UI overhaul + rankings/battle rebuild)

- **Fixed the Product B disappearing bug.** The two-column battle-creation
  layout used `flex-1` without `min-w-0`. A flex item's default minimum
  width is its *unwrapped content width* — with a 22-chip horizontal
  category strip nested inside, that pushed the whole row (and Product
  B's entire column) off-screen to the right. Because the page has
  `overflow-x: hidden`, that overflow was silently clipped rather than
  scrollable, making Product B look like it had vanished. Fixed by
  adding `min-w-0` to both flex columns in `pages/index.js`. Nothing was
  wrong with search or auto-detection — this was purely a layout bug.
- **Hardened logo/favicon auto-fetch.** Now parses a real
  `<link rel="icon">` / `apple-touch-icon` tag from the page instead of
  blindly guessing `/favicon.ico`, and explicitly follows redirects.
  Still won't work for every site — some block bot user agents or have
  no icon/OG data at all — but this catches more real-world cases.
- **Header nav restructured.** `Header.js` now has four persistent items
  — Battles / Rankings / Categories / Challenge a competitor — instead
  of Categories and Challenge living only on the homepage as toggle
  tabs. Categories and Challenge a competitor are still plain links
  (`/?panel=categories`, `/?panel=battle`); the homepage reads that
  query param and expands the matching section inline. Still never a
  popup or native `<select>`.
- **Rating history added** (`rating_history` table, migration 3 in
  `supabase-schema.sql`) — every vote now logs each product's new rating
  to an append-only ledger. This is what powers two new things on the
  Rankings page: a Form column (rank movement over ~24h) and a
  confidence dot (Low/Medium/High, based on how many battles a rating
  is built on).
- **Rankings page rebuilt**: inline-expand category and time-range
  filters (never popups), three sort tabs (Top rated / Rising / Most
  battles), gold/silver/bronze tier styling for the top 3. The
  time-range filter recomputes win/loss/battle counts for that window
  from real completed battles — but rating itself always stays the
  current overall value, not a point-in-time snapshot (see Known
  simplifications above for why).
- **Category list replaced category auto-suggestion (new)**: the
  "+ Add a product" mini-form now suggests a category on website-URL
  blur, using plain keyword matching against the fetched site title/
  description (`guessCategorySlug`) — explicitly labeled "(suggested)"
  in the UI, never enforced, and honestly not AI-based.
- **Click tracking shipped**: `pages/api/click.js` is a new redirect
  endpoint every "Visit" link now routes through (battle page, product
  page, and the post-vote result panel). Increments `battles.clicks`
  and only ever redirects to a URL it looked up itself from the
  database — never a client-supplied target, to avoid becoming an
  open redirect.
- **Shareable result-card images shipped**: `pages/api/og/[slug].js` (new
  file, edge runtime, `@vercel/og`) generates a 1200×630 PNG summarizing
  a battle's result. Wired into the battle page's OG/Twitter meta tags
  (real link previews now) and a "Download result card" link.
- **Battle page actions + post-vote result panel shipped**: category
  breadcrumb, Share/Visit×2 action row, a views/clicks stats row, and a
  related-battles section (same category, via product A) on
  `/battle/[slug]`. `BattleCard.js` itself now shows a full post-vote
  panel — who you voted for, current score, total voters, and
  Share/Visit/Challenge-another actions — inline wherever the card is
  used (the standalone battle page and the homepage's embedded live
  battle), not just as a one-line "vote counted" message.
- **BattleCard restyled**: status line now flags low-vote results as
  "EARLY RESULT", shows a trophy pill next to the ENDED badge once a
  battle closes, and the question moved to sit between the avatars and
  the vote percentages, matching the reference layout.
- **Homepage hero and trending redesigned**: subhead copy updated
  ("Discover products through real battles. Vote, compare, and challenge
  competitors."), trending battles are now compact paired-avatar cards
  instead of text rows. Note: the source doc's "hero copy split" asked
  for two explicit, separately-labeled paths for voters vs. founders —
  what shipped is lighter-touch (one hero + the header's standing
  "Challenge a competitor" button serving as the founder path), not a
  dedicated two-path component. Flagging that as a scope simplification
  rather than a full implementation.
- **`LeaderboardTable.js` gained a `mode` prop** (`"compact"` for the
  homepage, `"full"` for Rankings) so one component serves both instead
  of drifting into two near-duplicate implementations.
- **`package.json`**: added `@vercel/og` for the result-card image
  endpoint, alongside the `sharp` dependency added in the previous pass.

## Recent changes (bug fixes + Gemini AI features)

- **Fixed the logger's `"[object Object]"` bug.** Supabase/PostgREST
  errors are plain objects (`{message, code, details, hint}`), not
  instances of the JS `Error` class. `lib/logger.js`'s `serializeError`
  only special-cased real `Error` objects — everything else fell through
  to `String(err)`, which for a plain object just prints the useless
  literal `"[object Object]"`. This had been silently discarding the
  actual cause of every Supabase error since the logger was written.
  Now extracts `.message`/`.code`/`.details`/`.hint` explicitly.
- **Fixed the 413 "Body exceeded 1mb" errors.** Next's API routes
  default to a 1MB body limit; a 2MB PNG logo, base64-encoded, comes in
  around 2.7MB. Every submission with a real logo attached was silently
  failing. `pages/api/submit-product.js` now sets a 4MB limit via
  `export const config`.
- **Fixed the rankings category/time-range dropdown not scrolling.**
  Same root cause as the earlier Product-B-disappearing bug — a
  horizontally-scrolling strip needs a width-bounded ancestor, or the
  browser sizes the box to fit its unwrapped content instead of clipping
  it into a scrollable region. Fixed by giving the dropdown wrapper divs
  `w-full`.
- **Added a general-purpose duplicate-category cleanup** (migration 4 in
  `supabase-schema.sql`) — if two category rows ever end up with the
  same name (this happened once, when an older seed revision's row
  survived a category-list swap because a product still referenced it),
  keeps the oldest row, reassigns any products pointing at the newer
  duplicate(s), then deletes them. Written to catch this class of
  problem generally, not just the one instance that was reported.
- **Removed the 200-point matchmaking rating-gap cap** (`elo.js`'s
  `isMatchAllowed` is no longer called in `pages/api/vote.js` — the
  function itself is left in place in case this needs to come back).
- **Homepage's live battle is now clickable through** to its full
  `/battle/[slug]` page — a "View full battle →" link now sits below the
  embedded `BattleCard`. Previously the only way to reach a battle's full
  page was via Trending or the leaderboard.
- **Reordered battle-page and post-vote actions** to Visit A / Share /
  Visit B (was Share / Visit A / Visit B).
- **Emoji replaced with real icons.** New `lib/categoryIcons.js` maps
  each category slug to a `lucide-react` icon component. Every category
  render spot across the app (`Header.js`, `pages/index.js`,
  `pages/rankings.js`, `LeaderboardTable.js`, the product page) now uses
  this instead of the emoji stored in `categories.icon` — that column
  still exists in the database (harmless) but is no longer read by the
  UI. Every category select query was updated to include `slug`, which
  the icon lookup needs.
- **Nav rebuilt** (`Header.js`): real icons next to each label (Swords/
  Trophy/Tags), the current page is now visually distinguished (bold,
  not just gray), and the mobile menu button is a real hamburger/X icon
  instead of two plain bars.
- **Per-product click totals added** (`products.clicks`, migration 4) —
  `pages/api/click.js` now increments this alongside the existing
  per-battle `battles.clicks`. Shown in `LeaderboardTable.js` rows and as
  a new stat card on the product page.
- **Gemini AI features added** (new `lib/gemini.js`, model
  `gemini-3.5-flash-lite` as specified — see the note at the top of that
  file about model names changing over time):
  - **Non-generic battle questions**: `generateBattleQuestion` produces
    a question grounded in what the two specific products actually do
    (e.g. "Which handles large codebases better?"), instead of the
    generic "Which is better?" template. A new preview endpoint
    (`GET /api/submit-product?action=suggest-question`) lets the person
    see and edit the AI-generated question in the Start-a-Battle UI
    *before* committing, not just after. Falls back to the generic
    template on any failure (no API key, timeout, unusable response) —
    battle creation is never blocked by this.
  - **"🔍 Suggest competitors"**: button-triggered (never automatic,
    per instruction), calls `suggestCompetitors` for real, named
    competitors of whichever product is already selected, then checks
    Zoloop's own database for each one via the existing fuzzy search.
    Matches show as one-tap "Select" chips; non-matches show as
    "+ Add {name}" chips that open the add-product form pre-filled with
    the AI's suggested name and domain (both still editable, since an
    LLM can guess a domain wrong for a lesser-known product).
  - **Description fallback**: if a site has no `og:description`,
    `twitter:description`, or plain meta description at all — the one
    gap HTML scraping structurally can't solve — `generateDescription`
    gets one shot at writing a short, factual description from the
    page's title and visible text. Only fires in that specific gap, not
    on every submission. Still falls through to requiring a manual
    description if this also fails.
- **Switched HTML parsing from regex to `cheerio`** (a real HTML parser)
  in `pages/api/submit-product.js`'s `fetchMetadata` — regex was
  missing/mis-parsing tags on enough real sites (attribute order
  variance, unusual whitespace, self-closing vs. not) that it was worth
  the dependency. Also expanded the logo fallback chain to check
  `twitter:image` before falling back to `<link rel="icon">` tags.
- **`package.json`**: added `@google/generative-ai`, `lucide-react`, and
  `cheerio`.
