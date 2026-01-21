## Summary

<!-- Describe your changes in 1-3 sentences -->



## Type of Change

<!-- Mark the appropriate option with [x] -->

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [ ] ✨ New feature (non-breaking change that adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to change)
- [ ] 📝 Documentation update
- [ ] ♻️ Refactoring (no functional changes)
- [ ] 🧪 Test improvement
- [ ] 🔧 Configuration/build change
- [ ] 🗃️ Database migration

## Related Issues

<!-- Link related issues using GitHub keywords: Fixes #123, Closes #456 -->

-

## Changes Made

<!-- List the key changes in bullet points -->

-
-
-

---

## Pre-Submit Checklist

### Code Quality

- [ ] TypeScript compiles without errors (`npm run type-check`)
- [ ] ESLint passes (`npm run lint`)
- [ ] Code follows project conventions (see CLAUDE.md)
- [ ] No hardcoded secrets or credentials
- [ ] No `console.log` statements (use `logger` from `@/lib/utils/logger`)

### Testing

- [ ] Unit tests added/updated for new functionality
- [ ] All tests pass (`npm test`)
- [ ] E2E tests pass for affected user flows (`npm run test:e2e`)
- [ ] Manual testing completed in development environment

### Database (if applicable)

- [ ] Migration file follows naming convention: `NNNNN_description.sql`
- [ ] Migration version number is unique (CI checks this)
- [ ] RLS policies added/updated for new tables (see docs/RLS_POLICIES.md)
- [ ] Indexes added for frequently queried columns
- [ ] Backward compatible with existing data

### API Changes (if applicable)

- [ ] API follows conventions in docs/API_BEST_PRACTICES.md
- [ ] Error responses use standardized format
- [ ] Request validation implemented
- [ ] Rate limiting considered
- [ ] API documentation updated

### UI Changes (if applicable)

- [ ] Responsive design tested (mobile: 375px, tablet: 768px, desktop: 1280px+)
- [ ] Accessibility checked (keyboard navigation, screen reader)
- [ ] Loading states implemented
- [ ] Error states handled gracefully
- [ ] Design tokens used from `lib/design-tokens.ts`

### Performance

- [ ] No obvious performance regressions
- [ ] Large lists use virtualization if needed
- [ ] Images optimized with Next.js Image
- [ ] Expensive computations memoized

---

## Deployment Notes

<!-- Any special deployment considerations? Database migrations to run? Environment variables to add? -->

- [ ] No special deployment steps required

OR:

-

---

## Screenshots/Videos

<!-- For UI changes, include before/after screenshots or screen recordings -->

<details>
<summary>Screenshots</summary>

<!-- Paste images here -->

</details>

---

## Reviewer Notes

<!-- Any specific areas you'd like reviewers to focus on? -->

-
