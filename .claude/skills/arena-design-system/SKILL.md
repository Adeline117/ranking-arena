---
name: arena-design-system
description: Design system architect. Audits current design, researches landscape, proposes complete system. Creates DESIGN.md.
---

# Arena Design System Consultation

> **Shared patterns**: Read `.claude/skills/arena-shared-preamble.md` for Boil the Lake philosophy and effort estimates.

You are a design system architect building a cohesive design language for Arena — a crypto trader ranking platform.

## Process

### Step 1: Understand the Product

Read these files to understand Arena's visual identity:
- `lib/design-tokens.ts` — current design tokens
- `tailwind.config.ts` — Tailwind configuration
- `app/globals.css` — global styles
- `app/layout.tsx` — root layout
- `app/components/` — shared components (sample 5-10)
- `app/rankings/` — core ranking pages

### Step 2: Research Landscape

Analyze competitors and best-in-class financial data products:
- Crypto: CoinGecko, CoinMarketCap, DefiLlama, Copin.io
- Finance: Bloomberg Terminal, TradingView, Yahoo Finance
- Data products: Stripe Dashboard, Datadog, Linear

Key question: What makes Arena DIFFERENT visually? (data density, trust, professionalism)

### Step 3: Design System Proposal

#### 3a. Design Principles (3-5)
```markdown
1. **Data First**: Every pixel serves the data. No decorative elements.
2. **Trust Through Precision**: Exact numbers, clear methodology, verifiable sources.
3. **Speed**: The UI should feel as fast as the traders it tracks.
4. **Bilingual Native**: zh/en are equal citizens, not afterthoughts.
```

#### 3b. Color System
```typescript
// Semantic colors for Arena
const colors = {
  profit: { light: '#16a34a', dark: '#22c55e' },
  loss: { light: '#dc2626', dark: '#ef4444' },
  rank: {
    gold: '#f59e0b',    // top 10
    silver: '#94a3b8',  // top 50
    bronze: '#b45309',  // top 100
  },
  arena: {
    primary: '...',     // brand color
    accent: '...',      // CTAs
  },
  surface: {
    base: '...',
    elevated: '...',
    overlay: '...',
  }
}
```

#### 3c. Typography Scale
```
Display:  32px / 700 — Page titles
H1:       24px / 600 — Section headers
H2:       20px / 600 — Card titles
H3:       16px / 600 — Subsection titles
Body:     14px / 400 — Default text
Caption:  12px / 400 — Labels, metadata
Mono:     14px / 400 — Numbers, addresses, trader IDs
```

#### 3d. Spacing Scale
```
xs:   4px  — inline padding
sm:   8px  — tight spacing
md:  16px  — default spacing
lg:  24px  — section spacing
xl:  32px  — page sections
2xl: 48px  — major breaks
```

#### 3e. Component Patterns
Define standard patterns for:
- TraderCard (compact / expanded)
- RankBadge (position + change indicator)
- ArenaScoreBar (visual score representation)
- MetricDisplay (label + value + change)
- PeriodSwitcher (7D / 30D / 90D tabs)
- ExchangeLogo (icon + name)
- DataTable (sortable, responsive)

### Step 4: Generate Preview

Create a preview page at `app/design-system/page.tsx` showing:
- Color palette swatches
- Typography scale
- Component examples
- Spacing demonstrations

### Step 5: Output DESIGN.md

Write `/docs/DESIGN.md` with the complete design system documentation.

```markdown
# Arena Design System

## Principles
...

## Colors
...

## Typography
...

## Spacing
...

## Components
...

## Usage Examples
...
```
