// Pure hex/RGB math only — deliberately has ZERO dependencies (no
// sharp, nothing native). This gets imported from lib/categoryIcons.js,
// which is used by client-rendered page components; sharp is a native
// Node binary that can't run in a browser bundle. lib/brandColor.js
// (which DOES need sharp, for actual image analysis) imports the shared
// pieces from here rather than duplicating them, but nothing that needs
// sharp lives in this file.

export function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function hexToRgb(hex) {
  const clean = (hex || "").replace("#", "");
  const bigint = parseInt(clean, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}

// Simple relative-luminance check (not full WCAG contrast math, just
// enough to decide "does black or white text/border read better here")
// against a color that can't be assumed ahead of time — an extracted
// brand color might come back very light or very dark.
export function getReadableTextColor(r, g, b) {
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#2B2620" : "#FFFFFF";
}

// Blends a color toward white — turns a raw, possibly-saturated brand
// color into a light background wash suitable for a whole card/page
// background, while the raw color itself stays available for borders/
// accents/text where full saturation is fine.
export function lightenForBackground(hex, amount = 0.88) {
  try {
    const { r, g, b } = hexToRgb(hex);
    const lr = r + (255 - r) * amount;
    const lg = g + (255 - g) * amount;
    const lb = b + (255 - b) * amount;
    return rgbToHex(lr, lg, lb);
  } catch (err) {
    return "#FBF6EF"; // sand fallback if the hex was somehow malformed
  }
}
