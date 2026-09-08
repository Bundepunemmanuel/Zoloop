/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,jsx}",
    "./*.js",
  ],
  theme: {
    extend: {
      colors: {
        // Palette shifted from the original orange/purple "Zoloop logo"
        // scheme to a calmer terracotta/sage/sand palette (approved via
        // mockup). Token NAMES are kept as-is (cornerA, cornerB, paper,
        // etc.) rather than renamed, since renaming would mean touching
        // every className referencing them across the whole codebase for
        // zero functional benefit — only the hex values changed.
        ink: "#2B2620",
        inkCard: "#3A342C",
        line: "#DCCFB8",
        paper: "#FBF6EF",
        cornerA: "#C08552", // terracotta (was orange #FE4C12)
        cornerADim: "#3D2A1A",
        cornerB: "#6B8F71", // muted sage (was purple #754BF6)
        cornerBDim: "#1F2A20",
        gold: "#E8B84B", // unchanged — kept for medal badges specifically
        grayText: "#8A8072",
      },
      fontFamily: {
        display: ["Anton", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
        sans: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};
