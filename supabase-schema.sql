-- PIT — MVP schema
-- Run this in the Supabase SQL editor before seeding.

create extension if not exists "pgcrypto";

-- ---------- categories ----------
create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  icon text,
  created_at timestamptz not null default now()
);

-- ---------- products ----------
create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  description text,
  website_url text,
  logo_url text,
  category_id uuid references categories(id),
  twitter_handle text,
  rating integer not null default 1500,
  wins integer not null default 0,
  losses integer not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index products_rating_idx on products (rating desc);
create index products_category_idx on products (category_id);

-- ---------- battles ----------
create table battles (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  product_a_id uuid not null references products(id),
  product_b_id uuid not null references products(id),
  status text not null default 'pending'
    check (status in ('pending', 'live', 'completed', 'cancelled')),
  votes_a integer not null default 0,
  votes_b integer not null default 0,
  winner_id uuid references products(id),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create index battles_status_idx on battles (status);

-- ---------- votes ----------
-- Every vote is logged individually — never just increment a counter.
-- This is what lets fraud detection / historical analytics exist later.
create table votes (
  id uuid primary key default gen_random_uuid(),
  battle_id uuid not null references battles(id),
  product_id uuid not null references products(id),
  voter_hash text not null,
  created_at timestamptz not null default now()
);

create index votes_battle_idx on votes (battle_id);
create index votes_voter_hash_idx on votes (voter_hash);

-- One vote per browser per battle (MVP-level fraud prevention).
create unique index votes_one_per_voter_per_battle
  on votes (battle_id, voter_hash);

-- ---------- migration: views, flat-scoring rating baseline, rating floor ----------
-- Safe to run any number of times. Run this in the Supabase SQL editor
-- once against an already-created database.

-- View count per battle (incremented on each /battle/[slug] page load).
alter table battles add column if not exists views integer not null default 0;
create index if not exists battles_views_idx on battles (views desc);

-- New products now start at 1000 rating instead of 1500 — this only
-- changes the default for FUTURE inserts. Existing products keep
-- whatever rating they already have; this does not touch existing rows.
alter table products alter column rating set default 1000;

-- Rating can never drop below 0 (enforced in application code too, this
-- is the backstop). Wrapped in a DO block because Postgres doesn't
-- support "ADD CONSTRAINT IF NOT EXISTS" — this makes re-running safe.
do $$
begin
  alter table products add constraint products_rating_floor check (rating >= 0);
exception
  when duplicate_object then null;
end $$;

-- ---------- migration 2: battle question/clicks, fuzzy product search ----------
-- Safe to run any number of times. Run this in the Supabase SQL editor
-- once against an already-created database.

-- Each battle now carries the question it's actually settling (e.g.
-- "Which is better for launching a product?"), separate from the two
-- products' own descriptions. Lets the same two products run multiple
-- battles under different questions (e.g. "best for coding" vs "best
-- for writing").
alter table battles add column if not exists question text;

-- Website-click tracking (visit-button clicks routed through a redirect
-- endpoint, counted here) — shown on the battle page alongside votes/views.
alter table battles add column if not exists clicks integer not null default 0;

-- Fuzzy/typo-tolerant product search. pg_trgm is a standard Postgres
-- extension (enabled by default on Supabase) that ranks strings by how
-- similar they LOOK, catching typos and partial spelling that a plain
-- ILIKE substring match would miss.
create extension if not exists pg_trgm;

-- Optional aliases (e.g. "GPT" for ChatGPT, "IG" for Instagram) — plain
-- trigram similarity won't catch these since the strings don't share
-- characters, so exact/alias matches are checked separately in the
-- search function below. Not yet exposed in the add-product form; the
-- column exists so aliases can be filled in manually (e.g. via the
-- Supabase table editor) ahead of a future UI for it.
alter table products add column if not exists aliases text[] not null default '{}';

create index if not exists products_name_trgm_idx
  on products using gin (name gin_trgm_ops);

-- Search function used by GET /api/submit-product?q=... . Matches on
-- substring, alias, or trigram similarity, ranked by similarity then
-- rating. Defined as a function (rather than composed client-side)
-- because PostgREST's filter operators don't expose ORDER BY on
-- similarity() directly — this is the standard way to use pg_trgm
-- ranking through Supabase's JS client (via .rpc()).
create or replace function search_products(search_term text, result_limit int default 8)
returns table (
  id uuid,
  name text,
  slug text,
  rating integer,
  category_id uuid,
  logo_url text,
  category_name text,
  category_icon text
)
language sql
stable
as $$
  select
    p.id, p.name, p.slug, p.rating, p.category_id, p.logo_url,
    c.name as category_name, c.icon as category_icon
  from products p
  left join categories c on c.id = p.category_id
  where p.status = 'active'
    and (
      p.name ilike '%' || search_term || '%'
      or search_term ilike any(p.aliases)
      or similarity(p.name, search_term) > 0.2
    )
  order by similarity(p.name, search_term) desc, p.rating desc
  limit result_limit;
$$;

-- ---------- migration 3: rating history (powers Form arrows + confidence) ----------
-- Safe to run any number of times.
--
-- Append-only ledger: one row per product per vote, logging the rating
-- right after that vote. This is what "Form" (rank movement) and rating
-- confidence tiers are computed from — neither existed before this,
-- because there was previously no historical record, only the current
-- `products.rating` value.
create table if not exists rating_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  battle_id uuid not null references battles(id),
  rating integer not null,
  created_at timestamptz not null default now()
);

create index if not exists rating_history_product_idx
  on rating_history (product_id, created_at desc);

-- ---------- migration 4: per-product click totals, duplicate category cleanup ----------
-- Safe to run any number of times.

-- Per-product total click count (sum across all that product's battles).
-- Incremented directly in pages/api/click.js alongside the existing
-- per-battle battles.clicks, so no aggregation query is needed to show
-- it on leaderboard rows. Starts at 0 — does NOT retroactively backfill
-- clicks that were already recorded on battles.clicks before this
-- column existed.
alter table products add column if not exists clicks integer not null default 0;

-- General-purpose duplicate-category cleanup: if two category rows ever
-- end up with the exact same name (this happened once already, when an
-- older seed revision's row survived a category-list swap because a
-- product still referenced it), keep the OLDEST row per name, move any
-- products pointing at the newer duplicate(s) onto the kept row, then
-- delete the now-unreferenced duplicates. Written to be safe to re-run
-- and to catch this class of problem generally, not just this one case.
do $$
declare
  dup record;
  keeper_id uuid;
begin
  for dup in
    select name, array_agg(id order by created_at asc) as ids
    from categories
    group by name
    having count(*) > 1
  loop
    keeper_id := dup.ids[1];
    update products
      set category_id = keeper_id
      where category_id = any(dup.ids[2:array_length(dup.ids, 1)]);
    delete from categories
      where id = any(dup.ids[2:array_length(dup.ids, 1)]);
  end loop;
end $$;

-- ---------- migration 5: search_products() gains category_slug ----------
-- Re-defines the function from migration 2 to also return the category's
-- slug (needed for the icon-mapping lookup added in this pass). Postgres
-- requires dropping a function before changing its return signature.
drop function if exists search_products(text, int);

create or replace function search_products(search_term text, result_limit int default 8)
returns table (
  id uuid,
  name text,
  slug text,
  rating integer,
  category_id uuid,
  logo_url text,
  category_name text,
  category_icon text,
  category_slug text
)
language sql
stable
as $$
  select
    p.id, p.name, p.slug, p.rating, p.category_id, p.logo_url,
    c.name as category_name, c.icon as category_icon, c.slug as category_slug
  from products p
  left join categories c on c.id = p.category_id
  where p.status = 'active'
    and (
      p.name ilike '%' || search_term || '%'
      or search_term ilike any(p.aliases)
      or similarity(p.name, search_term) > 0.2
    )
  order by similarity(p.name, search_term) desc, p.rating desc
  limit result_limit;
$$;

-- ---------- migration 6: nullable battle_id on rating_history (admin edits) ----------
-- Safe to run on its own, any number of times (DROP NOT NULL is a no-op
-- if the column is already nullable). This is the ONLY statement in
-- this file you need to run against an existing database — everything
-- above already exists on a live install and isn't guaranteed to be
-- safe to re-run in full (the initial `create table` statements don't
-- use `if not exists`).
--
-- The admin dashboard (pages/emmybund.js, pages/api/admin.js) can adjust
-- a product's rating directly, outside of any specific battle. Those
-- edits still get logged to rating_history (so Form arrows / rating
-- charts don't silently drift from what's shown), but with battle_id
-- null to mark them as manual adjustments rather than vote outcomes.
alter table rating_history alter column battle_id drop not null;

-- ---------- migration 7: vote/click boosts, battle origin, IP fraud signal ----------
-- Run each statement below against your existing database (safe to run
-- more than once — every clause is guarded).
--
-- votes_a_boost / votes_b_boost / clicks_boost: admin-adjusted numbers,
-- kept SEPARATE from the real votes_a/votes_b/clicks columns rather than
-- overwriting them. Anywhere the app shows a vote/click count publicly,
-- it displays real + boost (so a boost looks the same as an organic
-- number to visitors) — but the admin dashboard queries both columns
-- separately so the real number is never lost or hidden from you.
alter table battles add column if not exists votes_a_boost integer not null default 0;
alter table battles add column if not exists votes_b_boost integer not null default 0;
alter table products add column if not exists clicks_boost integer not null default 0;

-- created_by: 'user' for battles started through the public "Challenge a
-- competitor" flow, 'admin' for battles created directly from the admin
-- dashboard. Powers the "ZOLOOP PICK" tag on the battle page (replacing
-- "Community-created by real users" for admin-made battles, which
-- otherwise would have been a false claim).
alter table battles add column if not exists created_by text not null default 'user'
  check (created_by in ('user', 'admin'));

-- ip_hash: logged alongside voter_hash on every vote, but NOT part of
-- the uniqueness constraint (voter_hash alone still is — see below).
-- Purely for the admin dashboard's fraud-signal view, to help spot
-- e.g. one IP behind an unusual number of distinct voter_hash values in
-- a short window.
alter table votes add column if not exists ip_hash text;

-- ---------- migration 8: real brand-color extraction ----------
-- Run on its own, safe to run any number of times.
--
-- brand_color: the actual dominant color pulled from a product's real
-- logo image (via sharp's built-in stats().dominant — see
-- lib/brandColor.js), NOT the earlier hash-based tint system
-- (lib/categoryIcons.js's getAvatarTint/getCoolTint), which just assigns
-- a color deterministically from a product's NAME with no relationship
-- to what its logo actually looks like. This is the real "Pecan AI's
-- page is green because Pecan's logo is green" effect.
--
-- brand_text_color: computed alongside brand_color — whichever of
-- black/white reads legibly against it (a raw extracted color can come
-- back very light or very dark, so this can't be assumed, it's computed
-- per-product from the actual extracted color).
--
-- Both null for any product that predates this migration, or whose
-- extraction failed, or that has no logo at all — the hash-based tint
-- remains the fallback in all of those cases (see
-- lib/categoryIcons.js's getProductTint, which is now the single
-- resolver every page should call instead of getAvatarTint directly).
alter table products add column if not exists brand_color text;
alter table products add column if not exists brand_text_color text;
