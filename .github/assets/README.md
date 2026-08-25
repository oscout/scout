# Scout GitHub assets

The GitHub-facing Scout identity is a restrained field system: a cream mark on
a near-black surface, quiet construction lines, and one green routing signal.
These files are repository-native sources, not exports from a hidden design
tool.

| Asset | Use |
| --- | --- |
| `scout-mark.svg` | Transparent canonical mark |
| `avatar.svg` / `avatar.png` | Square org or package avatar |
| `readme-hero.svg` / `readme-hero.png` | Repository README header |
| `social-preview.svg` / `social-preview.png` | GitHub repository social preview |
| `brand-tokens.json` | Shared colors and geometry values |

## Render PNGs

From the repository root:

```bash
bun scripts/render-github-brand-assets.mjs
```

The renderer uses the repository's existing `sharp` development dependency and
keeps every bitmap reproducible from its adjacent SVG source.

Use `readme-hero.svg` directly at the top of the repository README. Upload
`social-preview.png` under **Settings → General → Social preview**, and use
`avatar.png` anywhere GitHub requires a raster image.

## Guardrails

- Keep the mark geometry unchanged; it is shared with the Scout app icon.
- Use the signal green as a routing/status cue, not as a full background.
- Preserve generous clear space: at least one inner-hex width around the mark.
- Prefer flat color and precise lines. Avoid gradients, glass, mascots, and
  decorative terminal chrome.
- README artwork must remain legible in GitHub light and dark themes.
