# UI/UX Pro Max - Design Intelligence

A comprehensive design system guide offering 50+ styles, 97 color palettes, 57 font pairings, 99 UX guidelines, and 25+ chart types across multiple technology stacks.

## Supported Stacks

- html-tailwind (default)
- react
- nextjs
- vue
- nuxtjs
- nuxt-ui
- svelte
- react-native
- flutter
- swiftui
- jetpack-compose
- shadcn

## Priority Framework

Design rules organized by impact level:

1. **Accessibility (CRITICAL)** — Color contrast minimums (4.5:1), focus states, alt text, keyboard navigation
2. **Touch & Interaction (CRITICAL)** — 44x44px minimum targets, loading states, error feedback
3. **Performance (HIGH)** — Image optimization, reduced-motion support, preventing layout shifts
4. **Layout & Responsive (HIGH)** — Viewport settings, readable font sizes, z-index management
5. **Typography & Color (MEDIUM)** — Line height (1.5-1.75), character limits, font pairing
6. **Animation (MEDIUM)** — Timing (150-300ms), transform performance, skeleton screens
7. **Style Selection (MEDIUM)** — Consistency across product type
8. **Charts & Data (LOW)** — Chart type matching, accessible color guidance

## Workflow

**Step 1:** Analyze product type, style keywords, industry, and technology stack

**Step 2:** Generate design system using `--design-system` flag (always start here)

**Step 3:** Supplement with domain-specific searches as needed:
- `--domain product` - Product type recommendations
- `--domain style` - Style category guidelines
- `--domain color` - Color palette suggestions
- `--domain typography` - Font pairing recommendations
- `--domain landing` - Landing page patterns
- `--domain chart` - Data visualization guidance
- `--domain ux` - UX best practices

**Step 4:** Apply stack-specific guidelines (defaults to html-tailwind if unspecified)

## Critical Best Practices

These are frequently overlooked professional standards:

- Use SVG icons instead of emoji for UI elements
- Add `cursor-pointer` to all interactive elements
- Maintain 4.5:1 color contrast ratio minimum for accessibility
- Ensure glass/transparent elements remain visible in light mode
- Prevent layout shifts from hover states
- Respect `prefers-reduced-motion` for animations
- Use semantic HTML before ARIA attributes

## Search Domains

| Domain | Keywords | Description |
|--------|----------|-------------|
| product | saas, ecommerce, fintech, healthcare... | Product type recommendations |
| style | glassmorphism, brutalism, minimalism... | Design style guidelines |
| color | vibrant, trust, professional, dark... | Color palette guidance |
| typography | elegant, modern, playful, technical... | Font pairing suggestions |
| landing | hero, cta, features, testimonials... | Landing page patterns |
| chart | trend, comparison, distribution... | Chart type selection |
| ux | navigation, animation, forms, touch... | UX guidelines |
| icons | navigation, action, status, commerce... | Icon recommendations |

## Usage Examples

```bash
# Generate complete design system for a SaaS product
python scripts/search.py "saas dashboard fintech" --design-system

# Search for specific style guidelines
python scripts/search.py "glassmorphism dark mode" --domain style

# Get Next.js specific guidelines
python scripts/search.py "performance optimization" --stack nextjs

# Generate and persist design system
python scripts/search.py "crypto trading platform" --design-system --persist
```

## Pre-Delivery Checklist

Before delivering any UI/UX work, verify:

- [ ] Color contrast meets WCAG AA (4.5:1 for text)
- [ ] All interactive elements have cursor: pointer
- [ ] Touch targets are minimum 44x44px
- [ ] Focus states are visible and styled
- [ ] Loading states for all async operations
- [ ] Error states with clear feedback
- [ ] Reduced motion support implemented
- [ ] No layout shifts on hover/interaction
- [ ] Dark mode tested (if applicable)
- [ ] Responsive across 375px-1920px
- [ ] Semantic HTML used appropriately
- [ ] ARIA labels for icon-only buttons

## Data Files

- `data/charts.csv` - Chart type recommendations (25 types)
- `data/colors.csv` - Color palettes by product type (97 palettes)
- `data/icons.csv` - Icon library reference (100 icons)
- `data/landing.csv` - Landing page patterns (30 patterns)
- `data/products.csv` - Product type style mapping (96 types)
- `data/prompts.csv` - AI prompt templates (23 styles)
- `data/react-performance.csv` - React/Next.js performance (44 guidelines)
- `data/styles.csv` - Design style reference (58 styles)
- `data/typography.csv` - Font pairings (57 combinations)
- `data/ui-reasoning.csv` - UI category guidelines (100 rules)
- `data/ux-guidelines.csv` - UX best practices (99 guidelines)
- `data/web-interface.csv` - Web interface patterns (30 guidelines)
- `data/stacks/*.csv` - Stack-specific guidelines (12 stacks)
