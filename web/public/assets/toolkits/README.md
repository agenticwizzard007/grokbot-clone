# Shared app logos

These SVGs are pinned copies of `https://logos.composio.dev/api/<slug>`, retrieved
on November 10, 2026 and checked against the supplied Connect Apps screenshot.
They preserve the original brand artwork, colors, and background treatments.
Each logo remains the property of its respective brand.

Use `ToolkitLogo` and the mapping in `web/src/lib/toolkitLogos.ts` for catalog
rows, connected-app settings, badges, and chat cards. The native Apple apps load
this same web interface. Do not substitute platform glyphs, recolor these marks,
or point individual screens at separate copies of these logos.

Apps outside this reference set use their catalog artwork with the same tile
proportions. Missing artwork uses the shared first-letter fallback. When adding
a reference logo, save the original SVG here, check it visually, and add its
catalog slug to the mapping. Keep catalog order, counts, and connection state
driven by the server.
