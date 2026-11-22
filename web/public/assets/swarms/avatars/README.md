# Bird avatars

Paper MCP was unavailable in the implementation session. These ten formations use the exact wing path from the official Paper export at `../flock.svg`. The original flock and working assets are unchanged.

Each formation has a light SVG and a `-night.svg` counterpart using the official flock colors. All use a 100 by 100 viewBox and filled wings. The app renders the same paths with the Bot palette, lifting colors in dark mode and using theme text color for black.

Formation definitions live in `web/src/avatar/birds.ts`. Run `node --import tsx scripts/export-bird-avatars.mts` from the repository root to export the SVGs. The default suggestion is Flock, followed by Solo, Soar, Glide, Pair, Rise, Arc, Vee, Diamond, and Cascade. The primary Bot continues to use the original official flock mark.
