import sharp from "sharp";
import { rgbToHex, getReadableTextColor } from "./colorMath";
import { logWarn, logInfo } from "./logger";

// SERVER-ONLY (imports sharp, a native Node binary — never import this
// file from anything that renders client-side). Used only from API
// routes: pages/api/submit-product.js (auto-fetch pipeline) and
// pages/api/admin.js (manual logo-URL editing / backfill).
//
// Extracts a real "brand color" from a logo image — the actual dominant
// color in the image, not a name-based hash. This is what makes a
// product's page genuinely take on its own visual identity (Pecan AI's
// page is green because Pecan's logo is green), rather than the earlier
// getAvatarTint/getCoolTint system in lib/categoryIcons.js, which is a
// stable-but-arbitrary color assigned from a product's NAME with no
// relationship to what its logo actually looks like.
//
// Uses sharp's built-in stats().dominant (a fast per-pixel histogram)
// rather than a plain pixel average — averaging alone tends to produce
// a muddy gray for logos with white or transparent backgrounds, which
// isn't what anyone means by "brand color." Deliberately does NOT add a
// new third-party color library (e.g. node-vibrant): sharp is already a
// proven, working dependency in this project, and this sandbox has no
// network access to verify a new package would even install cleanly —
// reusing sharp is the safer bet.
//
// Flattens onto a neutral mid-gray background first so transparent
// regions of a PNG don't get counted as pure white/black and skew the
// result toward the wrong dominant color.
export async function extractBrandColor(imageBuffer) {
  try {
    const { dominant } = await sharp(imageBuffer)
      .flatten({ background: { r: 128, g: 128, b: 128 } })
      .stats();

    if (!dominant || typeof dominant.r !== "number") {
      logWarn("lib/brandColor.extractBrandColor", "sharp returned no usable dominant color", {
        dominant,
      });
      return null;
    }

    const brandColor = rgbToHex(dominant.r, dominant.g, dominant.b);
    const brandTextColor = getReadableTextColor(dominant.r, dominant.g, dominant.b);
    logInfo("lib/brandColor.extractBrandColor", "Extraction succeeded", {
      brandColor,
      brandTextColor,
      dominantRgb: dominant,
    });
    return { brandColor, brandTextColor };
  } catch (err) {
    logWarn("lib/brandColor.extractBrandColor", "Extraction failed", {
      error: err?.message,
    });
    return null;
  }
}
