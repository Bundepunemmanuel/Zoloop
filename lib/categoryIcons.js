import {
  Bot,
  Zap,
  Code,
  Palette,
  NotebookPen,
  Users,
  Cloud,
  Megaphone,
  DollarSign,
  Briefcase,
  ShoppingCart,
  Camera,
  Music,
  Film,
  Gamepad2,
  HeartPulse,
  GraduationCap,
  Plane,
  ShoppingBag,
  MessageCircle,
  Wrench,
  Newspaper,
  Tag,
} from "lucide-react";
import { lightenForBackground } from "./colorMath";

// Maps each category slug (from supabase-seed.sql) to a real icon
// component instead of an emoji glyph — emoji rendering varies wildly
// across devices/OSes/browsers and looked inconsistent. `categories.icon`
// in the database still stores an emoji for now (harmless, just unused by
// the UI) — this mapping is the source of truth for what actually
// renders. Falls back to a generic tag icon for any slug not listed here
// (e.g. a category added later without updating this file).
export const CATEGORY_ICONS = {
  ai: Bot,
  productivity: Zap,
  "developer-tools": Code,
  design: Palette,
  "note-taking": NotebookPen,
  collaboration: Users,
  saas: Cloud,
  marketing: Megaphone,
  finance: DollarSign,
  business: Briefcase,
  "e-commerce": ShoppingCart,
  "photo-video": Camera,
  music: Music,
  entertainment: Film,
  games: Gamepad2,
  "health-fitness": HeartPulse,
  education: GraduationCap,
  travel: Plane,
  shopping: ShoppingBag,
  social: MessageCircle,
  utilities: Wrench,
  news: Newspaper,
};

/**
 * Renders the icon for a category slug, sized/colored via className like
 * any other lucide-react icon (e.g. className="h-4 w-4").
 */
export function CategoryIcon({ slug, className }) {
  const Icon = CATEGORY_ICONS[slug] || Tag;
  return <Icon className={className} strokeWidth={2} />;
}

// Fallback letter-avatar tints, keyed by PRODUCT IDENTITY (name) rather
// than by which side of a battle it happens to be on. Before this,
// every fallback avatar used a color tied to "side A" or "side B" (or
// just a flat gray), so the same product could show up orange in one
// battle and purple in another, and unrelated products on the same side
// all looked identical — Claude, ChatGPT, Cursor, and Canva were all a
// plain gray "C". Hashing the name into one of these tints means a
// given product always gets the same color everywhere on the site,
// making it recognizable even without a real logo image.
const AVATAR_TINTS = [
  { bg: "#F7EAE0", text: "#C08552" }, // cornerA tint (terracotta)
  { bg: "#EAF0EA", text: "#6B8F71" }, // cornerB tint (sage)
  { bg: "#FBF3DF", text: "#8A6A16" }, // gold tint
  { bg: "#E2F5F4", text: "#0EA5A0" }, // teal
  { bg: "#E9F5EC", text: "#1F9D55" }, // green
  { bg: "#FCE7F3", text: "#BE185D" }, // rose
];

export function getAvatarTint(name) {
  const str = (name || "?").toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

// The single resolver pages should call for a product's tint, instead
// of calling getAvatarTint(product.name) directly. Prefers the REAL
// extracted brand color (product.brand_color / brand_text_color — see
// lib/brandColor.js) when it exists; falls back to the name-hash tint
// for any product that predates extraction, has no logo, or whose
// extraction failed. Returns the same { bg, text } shape either way, so
// call sites don't need to care which source it came from.
export function getProductTint(product) {
  if (product?.brand_color) {
    return {
      bg: lightenForBackground(product.brand_color),
      text: product.brand_color, // saturated color — readable on the light `bg` above
      border: product.brand_color,
    };
  }
  const fallback = getAvatarTint(product?.name);
  return { ...fallback, border: fallback.text };
}

// Card-accent tints for the Battles page ("each battle should have
// different cool colours") — deliberately excludes terracotta/gold/warm
// tones so a card's own background accent never competes visually with
// the terracotta vote buttons sitting on top of it. Hashed on the battle's
// id (stable per battle across visits, not random each reload) rather
// than product name, since this colors the CARD, not a specific
// product's identity.
const COOL_TINTS = [
  { bg: "#F0F6FF", border: "#3B5BDB", text: "#3B5BDB" }, // indigo
  { bg: "#E2F5F4", border: "#0EA5A0", text: "#0EA5A0" }, // teal
  { bg: "#F1ECFE", border: "#754BF6", text: "#754BF6" }, // violet
  { bg: "#E0F2FE", border: "#0284C7", text: "#0284C7" }, // sky
  { bg: "#E0FBFC", border: "#0891B2", text: "#0891B2" }, // cyan
  { bg: "#EEF2FF", border: "#4F46E5", text: "#4F46E5" }, // blue-violet
];

export function getCoolTint(seed) {
  const str = String(seed || "?");
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return COOL_TINTS[hash % COOL_TINTS.length];
}
