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
