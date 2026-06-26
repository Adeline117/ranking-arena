# Arena Design System

Quick reference for all UI work. Source of truth: `lib/design-tokens.ts`.

## Spacing (8px base)

| Token               | Value | Use for                        |
| ------------------- | ----- | ------------------------------ |
| `tokens.spacing[1]` | 4px   | Micro gaps, icon margins       |
| `tokens.spacing[2]` | 8px   | Card inner gaps, badge padding |
| `tokens.spacing[3]` | 12px  | Row padding, compact sections  |
| `tokens.spacing[4]` | 16px  | Standard card padding          |
| `tokens.spacing[5]` | 20px  | Page horizontal padding        |
| `tokens.spacing[6]` | 24px  | Section padding                |
| `tokens.spacing[8]` | 32px  | Hero padding, section gaps     |

## Typography

| Token                               | Size | Use for                     |
| ----------------------------------- | ---- | --------------------------- |
| `tokens.typography.fontSize.xs`     | 12px | Labels, captions, badges    |
| `tokens.typography.fontSize.sm`     | 13px | Secondary text, table cells |
| `tokens.typography.fontSize.base`   | 14px | Body text (default)         |
| `tokens.typography.fontSize.md`     | 16px | Inputs (avoids iOS zoom)    |
| `tokens.typography.fontSize.lg`     | 18px | Desktop table ROI           |
| `tokens.typography.fontSize.xl`     | 20px | Card ROI, subheadings       |
| `tokens.typography.fontSize['2xl']` | 24px | Hero stats, headings        |
| `tokens.typography.fontSize.hero`   | 28px | Hero metrics                |

| Weight Token                            | Value |
| --------------------------------------- | ----- |
| `tokens.typography.fontWeight.normal`   | 400   |
| `tokens.typography.fontWeight.medium`   | 500   |
| `tokens.typography.fontWeight.semibold` | 600   |
| `tokens.typography.fontWeight.bold`     | 700   |
| `tokens.typography.fontWeight.black`    | 900   |

Global: `font-variant-numeric: tabular-nums` is applied to `<body>`.

## Border Radius

| Token                | Value  | Use for                |
| -------------------- | ------ | ---------------------- |
| `tokens.radius.sm`   | 6px    | Small badges, chips    |
| `tokens.radius.md`   | 10px   | Cards, inputs, buttons |
| `tokens.radius.lg`   | 14px   | Panels, modals         |
| `tokens.radius.xl`   | 18px   | Hero sections          |
| `tokens.radius.full` | 9999px | Pills, avatars         |

## Colors (CSS Variables)

Always use CSS variables, never hardcode hex values.

```
Background:  var(--color-bg-primary)       // Page bg
             var(--color-bg-secondary)      // Card bg
             var(--color-bg-tertiary)       // Elevated surfaces

Text:        var(--color-text-primary)      // Main text
             var(--color-text-secondary)    // Secondary
             var(--color-text-tertiary)     // Muted

Brand:       var(--color-brand)             // Purple accent
             var(--color-accent-secondary)  // Teal accent

Sentiment:   var(--color-accent-success)    // Positive/bull
             var(--color-accent-error)      // Negative/bear
```

## Components

### Box (`app/components/base/Box.tsx`)

Layout container with token-based spacing props.

```tsx
<Box p={4} bg="secondary" radius="lg" border="primary">
  {children}
</Box>
```

### Text (`app/components/base/Text.tsx`)

Semantic text with enforced token values.

```tsx
<Text size="sm" weight="medium" color="secondary">
  Label
</Text>
```

### Button (`app/components/base/Button.tsx`)

6 variants: `primary`, `secondary`, `ghost`, `text`, `success`, `danger`.
CSS class `btn-base` handles transitions/hover/active via globals.css.

### EmptyState (`app/components/ui/EmptyState.tsx`)

**Always use this for empty/null states. Never roll your own.**

```tsx
<EmptyState
  icon={<SearchIcon />}
  title={t('noResults')}
  description={t('tryDifferentQuery')}
  action={{ label: t('goBack'), onClick: () => router.back() }}
  variant="card" // 'default' | 'compact' | 'card'
/>
```

## CSS Classes (globals.css)

| Class             | Effect                                          |
| ----------------- | ----------------------------------------------- |
| `.glass-card`     | Glassmorphism bg + blur + border + hover lift   |
| `.card-hover`     | Shadow + translateY(-3px) hover lift            |
| `.sidebar-card`   | Sidebar card styling (14px radius, padding)     |
| `.btn-base`       | Unified button transition + hover/active states |
| `.hover-lift`     | Simple translateY(-2px) + shadow on hover       |
| `.skeleton`       | Loading placeholder with shimmer animation      |
| `.content-reveal` | Fade-in-up animation for skeleton→content       |

## Anti-Patterns (ESLint will warn)

```tsx
// BAD — hardcoded values
style={{ fontSize: 14, borderRadius: 8, fontWeight: 600 }}

// GOOD — token references
style={{
  fontSize: tokens.typography.fontSize.base,
  borderRadius: tokens.radius.md,
  fontWeight: tokens.typography.fontWeight.semibold,
}}
```

```tsx
// BAD — custom empty state
<div style={{ textAlign: 'center', padding: '80px 24px' }}>
  <p>No results found</p>
</div>

// GOOD — shared component
<EmptyState title="No results found" variant="compact" />
```

```tsx
// BAD — hardcoded color
style={{ color: '#8b6fa8' }}

// GOOD — CSS variable
style={{ color: 'var(--color-brand)' }}
// or token
style={{ color: tokens.colors.accent.brand }}
```

### NEVER concatenate hex alpha onto a token color (invalid CSS, silently dropped)

`tokens.colors.*` resolve to CSS variables, so appending a hex alpha produces
`var(--color-accent-error)15` — invalid CSS the browser **drops entirely**, so the
background / border / shadow silently disappears. Use the `alpha()` helper
(`color-mix`), which is valid for both CSS-variable and literal-hex inputs.

```tsx
// BAD — `var(--color-accent-error)15` is invalid → no background renders
style={{ background: `${tokens.colors.accent.error}15` }}
style={{ border: `1px solid ${sourceInfo.typeColor}30` }}

// GOOD — alpha() → color-mix(in srgb, var(--x) 8%, transparent)
import { tokens, alpha } from '@/lib/design-tokens'
style={{ background: alpha(tokens.colors.accent.error, 8) }}
style={{ border: `1px solid ${alpha(sourceInfo.typeColor, 19)}` }}
```

Note: inside `var(--x, <fallback>)` the concatenated fallback is dead (never used
when `--x` is defined) and OG-image routes render via Satori (no `color-mix`) — leave
those literal. Everywhere else in `app/`, prefer `alpha()`.

---

# Design Language v2 — Evolution Principles

The tables above are the _mechanical_ reference (what tokens exist). This section is
the _editorial_ reference (how to compose them). It encodes the 2026 direction:
**evolve the dark + purple + glass identity** into something sharper for a
data-dense crypto product. Keep the brand; raise the craft.

Guiding idea: **users want direction, not more data.** Every screen should make the
single most important number obvious, color it by meaning, and get out of the way.

## 1. Signal Accent — one bright accent per surface

Color is a signal, not decoration. On any given surface, **at most one** bright
accent should compete for attention.

| Meaning                          | Token                                          | Use for                                         |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Positive / gain / bull           | `var(--color-accent-success)` (`#2fe57d` dark) | ROI↑, PnL↑, win streaks, "up" deltas            |
| Negative / loss / bear           | `var(--color-accent-error)` (`#ff7c7c` dark)   | ROI↓, PnL↓, drawdown, "down" deltas             |
| Brand / navigation / CTA / focus | `var(--color-brand)` (`#8b6fa8`)               | Primary buttons, active nav, focus rings, links |
| Neutral / unknown / muted        | `var(--color-text-secondary)` / `tertiary`     | Missing data (`—`), labels, non-signal numbers  |

Rules:

- **Never** paint a non-signal number green/red. A column label or a row count is neutral.
- Brand purple is for _interaction_ (you can click it), green/red is for _outcome_ (it happened).
- Don't stack accents: a card with a green ROI should not also have an amber tag and a
  purple badge fighting it. Demote the rest to neutral.
- Gauges/medals/verified badges keep their dedicated tokens — they are domain semantics, not "accents".

## 2. Ledger Numerals — financial numbers read like a ledger

All money/performance figures (ROI, PnL, Arena Score, balances, win%, drawdown, prices)
must align like an accountant's ledger so the eye can scan columns.

```tsx
// Use the <Metric> component (app/components/ui/Metric.tsx) — do not hand-roll.
<Metric value={trader.roi} format="roi" size="lg" />     // colors + sign + tabular automatically
<Metric value={trader.pnl} format="pnl" size="md" />
```

If you must style a number inline, apply the ledger recipe:

```tsx
style={{
  fontVariantNumeric: 'tabular-nums',   // already global on <body>, restate on overrides
  letterSpacing: '-0.02em',             // tightens wide tabular figures
  fontWeight: tokens.typography.fontWeight.bold,
}}
```

- Always show an explicit sign on deltas (`+12.4%`, `-8.1%`) so positive/negative read at a glance.
- Right-align numeric **table** columns; the decimal points should line up.
- Use `formatROI` / `formatPnL` / `formatCompact` from `lib/utils/format.ts` — never `toFixed` ad hoc.
- Mono font (`tokens.typography.fontFamily.mono`) is reserved for addresses/hashes/code, **not** metrics — tabular Inter already aligns.

## 3. Numeric Hierarchy — size encodes importance

One hero number per view, sized far above its supporting stats.

| Tier            | Size token                | px    | Use for                                                         |
| --------------- | ------------------------- | ----- | --------------------------------------------------------------- |
| Hero metric     | `fontSize.hero` / `3xl`   | 28/32 | The page's single headline number (trader ROI, portfolio value) |
| Card metric     | `fontSize.xl`             | 20    | The lead number inside a card / leaderboard row                 |
| Table metric    | `fontSize.lg` / `base`    | 18/14 | Dense row values                                                |
| Supporting stat | `fontSize.sm`             | 13    | Sharpe, MDD, win% under the lead number                         |
| Label / caption | `fontSize.xs` + uppercase | 12    | The word _above_ the number (`PNL`, `WIN%`)                     |

Pattern: **label small + muted on top, value large + colored below.** Labels use
`text-tertiary`, `letter-spacing: 0.04em`, `text-transform: uppercase`.

## 4. Data Visualization — single accent, labels on the data

- **Label on the data, not in a legend.** Annotate the last point of a line, the end of a
  bar, the hovered slice — don't make users map colors to a legend key.
- **One accent + neutral grays.** A sparkline is green if the series is net-up, red if net-down,
  neutral otherwise. Avoid rainbow multi-series unless comparing named entities.
- **Bars/progress** (`ROI` bar, drawdown bar): fill with the signal color, clamp the fill width,
  keep the track neutral. Clamp formula lives with the component; never let a fill exceed 100%
  (see the historical `drawdown > 100%` scaling bug).
- Reuse `Sparkline` (`app/components/ui/Sparkline.tsx`) and `RankTrendSparkline` — don't draw raw SVG inline.

## 5. Motion Discipline — purposeful, interruptible, accessible

- Durations/easings come from `tokens.duration` / `tokens.easing`. Default UI feedback: `200ms standard`.
- **Always honor reduced motion.** Wrap non-essential animation in `media.motion` (from
  `lib/design-tokens.ts`) or gate via CSS `@media (prefers-reduced-motion: reduce)`. globals.css
  already neutralizes keyframes under reduce — don't reintroduce unconditional animation.
- Stagger list entrance with `getStaggerDelay(index)` but **cap it**: stop staggering after ~8 rows
  (long leaderboards must not ripple for seconds). Beyond the cap, render immediately.
- Motion explains change (a value ticking, a row reordering), it does not decorate idle states.

## 6. Glass vs Clarity — anti-liquid-glass for data

The 2026 rule: clarity outranks shimmer where real numbers live.

- `.glass-card` / `getGlassStyle()` are for **decorative / chrome** surfaces: sidebars, floating
  overlays, hero backdrops, marketing sections.
- **Data surfaces use solid fills**: leaderboard rows, price tables, trade lists, alerts, and any
  cell with a number you'd act on use `var(--color-bg-secondary/tertiary)` with a real border —
  no backdrop blur reducing contrast behind a figure.
- If a glass effect drops text/number contrast below WCAG AA, remove it. Legibility is the premium look.

## 7. Component State Matrix — every interactive element covers all states

No interactive component ships without all of these. Reuse the shared infra; don't re-implement.

| State            | Standard                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Default          | Token surface + border                                                                            |
| Hover            | `.hover-lift` (translateY(-2px) + shadow) or `.card-hover` (-3px)                                 |
| Active / pressed | Slight scale/translate via `.btn-base`                                                            |
| Focus-visible    | `tokens.focusRing.style` (2px brand ring, 2px offset) — never remove outline without replacing it |
| Disabled         | Reduced opacity + `cursor: not-allowed`, no hover response                                        |
| Loading          | `.skeleton` shimmer / `LoadingSkeleton` / `LoadingSpinner`                                        |
| Empty            | `EmptyState` (never a bare centered `<p>`)                                                        |
| Error            | `ErrorState` / `DataStateWrapper`                                                                 |
| Touch target     | ≥ `tokens.touchTarget.min` (44px) hit area on anything tappable                                   |

`DataStateWrapper` collapses Loading → Error → Empty → Content automatically — prefer it for
any async data region on the core path.
