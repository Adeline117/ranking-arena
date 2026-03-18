---
name: arena-design-audit
description: Visual design audit across 10 categories. Report-only, never modifies code. Use to assess UI quality.
---

# Arena Design Audit

> **Shared patterns**: Read `.claude/skills/arena-shared-preamble.md` for Boil the Lake philosophy and effort estimates.

You are a senior product designer auditing Arena's live UI. You produce a comprehensive visual audit report. You NEVER modify code — report only.

## Audit Process

### Step 1: Identify Pages to Audit
Read the app router structure to identify all user-facing pages:
```bash
find app -name "page.tsx" | head -30
```

Focus on core path first:
1. Homepage (`/`)
2. Rankings (`/rankings`)
3. Trader Detail (`/trader/[id]`)
4. Search results
5. Auth flow (login/signup)
6. Pro subscription

### Step 2: Read Design Tokens
Read `lib/design-tokens.ts` and Tailwind config to understand the current design system.

### Step 3: Audit Categories (10 categories, 8 items each = 80 checks)

#### 1. Typography (8 checks)
- [ ] Font hierarchy clear (h1 > h2 > h3 > body > caption)
- [ ] Line heights readable (1.4-1.6 for body)
- [ ] Font sizes consistent across similar elements
- [ ] No more than 3 font weights used
- [ ] Numbers in tables use tabular/monospace figures
- [ ] Text contrast meets WCAG AA (4.5:1 min)
- [ ] No orphaned single-word lines in headers
- [ ] CJK text (zh) properly sized and spaced

#### 2. Color System (8 checks)
- [ ] Primary/secondary/accent colors consistent
- [ ] Semantic colors correct (green=profit, red=loss)
- [ ] Dark mode: sufficient contrast, no pure white text
- [ ] Color not sole indicator of state (accessibility)
- [ ] Hover/focus states visible
- [ ] Disabled states clearly different from active
- [ ] Background hierarchy creates depth
- [ ] Brand colors used consistently

#### 3. Spacing & Layout (8 checks)
- [ ] Consistent spacing scale (4px/8px/16px/24px/32px)
- [ ] Content width appropriate (max-width on readable text)
- [ ] Grid alignment consistent
- [ ] Responsive breakpoints work (mobile/tablet/desktop)
- [ ] No layout shift (CLS < 0.1)
- [ ] Padding consistent within card/panel components
- [ ] Whitespace used intentionally (not cramped, not sparse)
- [ ] Three-column layout doesn't break on narrow screens

#### 4. Components (8 checks)
- [ ] Buttons have consistent sizing and styles
- [ ] Input fields match across forms
- [ ] Cards have consistent border radius and shadow
- [ ] Tables are readable with proper cell padding
- [ ] Loading states are consistent (skeleton/spinner)
- [ ] Empty states have helpful content
- [ ] Badges/tags are consistent
- [ ] Tooltips positioned correctly

#### 5. Navigation (8 checks)
- [ ] Current page clearly indicated
- [ ] Navigation hierarchy logical
- [ ] Mobile menu works properly
- [ ] Breadcrumbs present where needed
- [ ] Back button behavior correct
- [ ] Tab/period switchers clear
- [ ] Search accessible from everywhere
- [ ] Footer links organized

#### 6. Data Visualization (8 checks)
- [ ] Charts readable at all sizes
- [ ] Axes labeled properly
- [ ] Color-blind safe chart colors
- [ ] Numbers formatted consistently (commas, decimals, %)
- [ ] Large numbers abbreviated (1.2M not 1,234,567)
- [ ] Rank changes shown clearly (arrows, colors)
- [ ] Arena Score visualization clear
- [ ] Period switcher doesn't cause layout jump

#### 7. Interaction & Animation (8 checks)
- [ ] Hover effects on interactive elements
- [ ] Click targets large enough (44px min)
- [ ] Transitions smooth (150-300ms)
- [ ] No janky animations
- [ ] Scroll behavior smooth
- [ ] Modal/dialog transitions consistent
- [ ] Tab switching feels instant
- [ ] Infinite scroll or pagination clear

#### 8. Content & Copy (8 checks)
- [ ] Labels clear and concise
- [ ] Error messages helpful
- [ ] CTAs action-oriented ("View Trader" not "Click Here")
- [ ] Bilingual (zh/en) consistent
- [ ] Dates formatted for locale
- [ ] Numbers use correct currency symbols
- [ ] No placeholder/lorem ipsum text
- [ ] Legal/disclaimer text present where needed

#### 9. Trust & Credibility (8 checks)
- [ ] Exchange logos/icons present and correct
- [ ] Data freshness indicated (last updated)
- [ ] Methodology explained or linked
- [ ] Pro features clearly marked
- [ ] Social proof elements present
- [ ] Contact/support accessible
- [ ] No broken images or 404 links
- [ ] Professional tone throughout

#### 10. AI Slop Detection (8 checks)
- [ ] No generic stock imagery
- [ ] No overly polished "AI-generated" graphics
- [ ] Copy doesn't read like ChatGPT output
- [ ] No unnecessary gradients/glassmorphism
- [ ] Icons meaningful, not decorative
- [ ] No empty hero sections
- [ ] Data-first design, not decoration-first
- [ ] Feels like a tool, not a marketing page

### Step 4: Scoring

Grade each category A-F:
- **A** (7-8 pass): Excellent
- **B** (5-6 pass): Good
- **C** (3-4 pass): Needs improvement
- **D** (1-2 pass): Poor
- **F** (0 pass): Failing

### Step 5: Output Report

```markdown
# Arena Design Audit Report — [Date]

## Overall Grade: [A-F]

## Scores by Category
| Category | Grade | Pass | Fail | Critical Issues |
|----------|-------|------|------|-----------------|
| Typography | B | 6/8 | 2 | [issue] |
| ... | ... | ... | ... | ... |

## Critical Issues (fix first)
1. [Issue]: [Where] — [Why it matters]

## Improvements (nice to have)
1. [Issue]: [Where] — [Suggested fix]

## What's Working Well
- [Positive finding 1]
- [Positive finding 2]
```

**REMEMBER: This is a report-only audit. Do NOT modify any code.**
