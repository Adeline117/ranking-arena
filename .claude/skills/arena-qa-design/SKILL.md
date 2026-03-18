---
name: arena-qa-design
description: Design QA with auto-fix. Finds visual inconsistencies, spacing issues, AI slop — then fixes and commits atomically.
---

# Arena Design QA — Find & Fix

Find visual inconsistency, spacing issues, hierarchy problems, and AI slop across Arena's UI — then fix them. Each fix committed atomically.

## Process

### Step 1: Extract Current Design System
Read these files to understand what the design system IS (not what it should be):
- `lib/design-tokens.ts`
- `tailwind.config.ts`
- `app/globals.css`
- Sample 5-10 components from `app/components/`

### Step 2: Scan for Inconsistencies

#### Spacing Issues
```bash
# Find hardcoded pixel values (should use Tailwind spacing)
grep -rn "px\b" app/ --include="*.tsx" | grep -v "node_modules" | grep -v ".css" | head -30

# Find inconsistent padding/margin
grep -rn "p-[0-9]" app/ --include="*.tsx" | head -20
grep -rn "m-[0-9]" app/ --include="*.tsx" | head -20
```

#### Typography Issues
```bash
# Find raw text sizes (should use design tokens)
grep -rn "text-\[" app/ --include="*.tsx" | head -20

# Find inconsistent font weights
grep -rn "font-[0-9]" app/ --include="*.tsx" | head -20
```

#### Color Issues
```bash
# Find hardcoded colors (should use design tokens)
grep -rn "#[0-9a-fA-F]\{6\}" app/ --include="*.tsx" | head -20

# Find inconsistent profit/loss colors
grep -rn "green\|red\|emerald\|rose" app/ --include="*.tsx" | head -20
```

#### AI Slop Detection
Look for:
- Unnecessary gradients (`bg-gradient-to-*` without design justification)
- Excessive border radius (`rounded-3xl`, `rounded-full` on non-avatar elements)
- Decorative blur/glow effects (`blur-`, `shadow-2xl`)
- Empty hero sections with generic copy
- Over-animated elements (`animate-` without purpose)

### Step 3: Fix & Commit Loop

For each issue:

1. **Screenshot context**: Note the file, line, and what's wrong
2. **Fix**: Apply the minimal CSS/Tailwind change
3. **Verify**: Ensure fix doesn't break layout
4. **Commit**:
```bash
git add [specific file]
git commit -m "fix(design): [what was wrong] → [what it is now]

Example: fix(design): inconsistent card padding p-3/p-4/p-5 → unified p-4

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Step 4: Report

```markdown
# Design QA Report — [Date]

## Fixes Applied: [N]

### Spacing Fixes
1. [commit] — [description]

### Typography Fixes
1. [commit] — [description]

### Color Fixes
1. [commit] — [description]

### AI Slop Removed
1. [commit] — [description]

## Remaining (need designer input)
1. [issue] — [why it's ambiguous]
```

## Rules
- NEVER change layout structure (grid → flex, column count, etc.)
- NEVER change colors that have semantic meaning (profit/loss)
- NEVER remove functionality to "simplify" design
- OK to fix: inconsistent spacing, hardcoded values, misaligned elements, inconsistent border radius
- Each fix MUST be a separate atomic commit
- If unsure, add to "Remaining" list
