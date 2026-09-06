# Quant Entelloq — Brand Assets

## Required files

Save your brand assets to this folder. The code looks for these paths:

| File | Usage |
|------|-------|
| `assets/entelloq-logo.png` | Full lockup (head + ENTELLOQ wordmark + NETWORKS tagline). Used for the corner watermark on dashboard pages. |
| `assets/entelloq-mark.png` | **Cropped head only** (no wordmark). Used everywhere the Q monogram used to appear: sidebar logo, Copilot dock, mentor avatar, quest panel header, daily-challenge badge. |

If you only save `entelloq-logo.png` (the full lockup), the code falls back to using it for the small marks too — but it will look better with a head-only crop because the small placements are 30–44px and the wordmark won't read at that size.

## Recommended crop for `entelloq-mark.png`

From the full logo image, crop a square region containing only the cyborg head and the circuit lines flowing into it. The crop should be roughly the top 55% of the original logo's vertical center, cropped square.

## File specs

- **Format:** PNG with transparent background (preferred) or solid black background
- **Size:** Source resolution ≥ 512×512 px for sharp rendering on retina displays
- **Color profile:** sRGB

## Where to save

These files live in `assets/` alongside `index.html`:

```
QuantEntelloq/
├── index.html
└── assets/
    ├── entelloq-logo.png   ← full lockup
    └── entelloq-mark.png   ← head only (square crop)
```

Commit + push the files, and the platform updates automatically — no code change needed.

## Fallback behavior

If the image files are missing or fail to load, the platform continues to show the gradient "Q" monogram as before. The replacement is graceful and reversible.

## Quant launch landscapes

The September 2026 launch uses `quant-horizon.png` and `quant-perspective.png` (1672 × 941 each), generated with the built-in imagegen tool. These are decorative backgrounds; all text, navigation, charts, and controls remain HTML, CSS, and SVG.

Prompt set: a cinematic near-black teal alpine landscape with a blue Earth horizon and dark left headline space; a second alpine city-valley scene at dusk with a small seated explorer at left, amber lights, and dark center/right copy space. Both prompts specified backgrounds only, without text, logos, charts, or UI.
