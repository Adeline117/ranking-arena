# Code Cleanup Recommendations

**Date**: January 28, 2026
**Status**: Phase 1 Complete - Recommendations for Future Phases

---

## Phase 1 Results

✅ **Completed**: Low-risk cleanup items
- Deleted 1 unused component (PageTransition.tsx, 99 lines)
- Organized 4 setup scripts into `/scripts/setup/` directory
- Updated CLAUDE.md to remove outdated references

See [PHASE1_CLEANUP_REPORT.md](./PHASE1_CLEANUP_REPORT.md) for details.

---

## Phase 2 Recommendations: Additional Low-Risk Cleanup

### 2.1 Script Consolidation

**Current State**: Two check scripts with similar purposes
- `scripts/check_sources.mjs` - checks trader_snapshots table
- `scripts/check_sources2.mjs` - checks trader_scores and trader_sources tables

**Recommendation**: Merge into single diagnostic script
```bash
scripts/check_data.mjs --table=snapshots|scores|sources|all
```

**Benefits**:
- Single entry point for data verification
- Easier to maintain
- More discoverable

**Risk Level**: Low
**Effort**: 1-2 hours

---

### 2.2 Directory Structure Review

**Current Observations**:

The project has good overall structure, but some areas could be improved:

1. **API Test Organization**:
   ```
   app/api/
   ├── stripe/webhook/__tests__/route.test.ts
   ├── saved-filters/__tests__/
   └── settings/__tests__/
   ```

   **Recommendation**: Consider moving all API tests to a unified location or ensure consistent pattern.

2. **Import Scripts Organization**:
   ```
   scripts/import/
   ├── batch_import.mjs
   ├── check_comprehensive.mjs
   ├── check_freshness.mjs
   ├── check_seasons.mjs
   ├── import_dydx_enhanced.mjs
   ├── import_gmx_enhanced.mjs
   ├── import_htx_enhanced.mjs
   └── ENHANCED_DATA_STATUS.md
   ```

   **Status**: Well organized, no changes needed

---

### 2.3 Unused Files Investigation

**Files to Investigate** (require deeper analysis):

1. **install.sh**
   - Purpose unclear from git status
   - May be one-time setup script
   - **Action**: Review and potentially move to `scripts/setup/`

2. **proxy.ts**
   - New file (untracked)
   - May be development-only
   - **Action**: Verify usage and add to .gitignore if local dev tool

---

## Phase 3 Recommendations: Medium-Risk Cleanup

### 3.1 Dependency Audit

**Action Items**:
1. Run dependency audit:
   ```bash
   npx depcheck
   npx npm-check
   ```

2. Review and remove unused dependencies

3. Update outdated dependencies (with testing)

**Risk Level**: Medium (requires testing)
**Effort**: 4-6 hours

---

### 3.2 TypeScript Configuration

**Current Status**: Project uses TypeScript strict mode ✓

**Recommendation**: Audit for any remaining `any` types
```bash
grep -r ": any" app/ lib/ --include="*.ts" --include="*.tsx" | wc -l
```

**Action**: Replace `any` with proper types where feasible

**Risk Level**: Medium (may reveal type errors)
**Effort**: Varies by usage

---

### 3.3 Component Usage Audit

**Tools to Use**:
- `ts-prune` - Find unused exports
- `unimported` - Find unused files
- Custom script to detect single-use components

**Process**:
1. Run static analysis tools
2. Review results manually
3. Categorize:
   - Safe to delete
   - Candidate for inlining
   - Keep as-is

**Risk Level**: Medium (requires careful review)
**Effort**: 6-8 hours

---

## Phase 4 Recommendations: Performance Optimization

### 4.1 Bundle Size Analysis

**Actions**:
1. Run Next.js bundle analyzer:
   ```bash
   npm run build -- --analyze
   ```

2. Identify large dependencies

3. Consider:
   - Dynamic imports for large components
   - Tree-shaking opportunities
   - Alternative lighter libraries

---

### 4.2 Image Optimization

**Current State**: Project likely has images in multiple formats

**Recommendations**:
1. Audit image usage:
   ```bash
   find app public -type f \( -name "*.jpg" -o -name "*.png" -o -name "*.gif" \)
   ```

2. Convert to WebP where appropriate

3. Ensure all images use Next.js Image component

---

## Phase 5 Recommendations: Code Quality

### 5.1 ESLint Rule Enforcement

**Review Current Rules**:
- Check `.eslintrc.js` or `eslint.config.js`
- Consider enabling stricter rules:
  - `@typescript-eslint/no-explicit-any`
  - `@typescript-eslint/explicit-function-return-type`
  - `react/jsx-no-bind`

---

### 5.2 Test Coverage Improvement

**Current Coverage**: Partial (from git status, some tests exist)

**Actions**:
1. Run coverage report:
   ```bash
   npm run test:coverage
   ```

2. Identify critical paths with low coverage

3. Add tests for:
   - API routes
   - Data manipulation functions
   - User flows

---

## Quick Wins (Can Do Anytime)

### 1. Add EditorConfig

Create `.editorconfig` for consistent formatting:
```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

---

### 2. Add Scripts Documentation

Create `scripts/README.md` documenting:
- Purpose of each script
- When to use it
- Required environment variables
- Example usage

---

### 3. Improve Git Ignore

Review `.gitignore` for:
- Development artifacts
- OS-specific files
- IDE configurations
- Local environment files

---

## Anti-Recommendations (Things NOT to Do)

### ❌ Don't Delete These

1. **IconSystem.tsx**
   - Despite appearing unused, it's used via re-exports
   - 4 active import locations confirmed

2. **Documentation Files**
   - All current docs serve unique purposes
   - Keep comprehensive history for future reference

3. **Diagnostic Scripts**
   - Even if not in package.json
   - Valuable for debugging production issues

---

### ❌ Don't Refactor Without Testing

1. **Database Queries**
   - Performance-critical
   - Small changes can have big impact
   - Always benchmark before/after

2. **API Routes**
   - May have external consumers
   - Require integration testing
   - Version if making breaking changes

3. **Authentication Flow**
   - Security-critical
   - Requires thorough testing
   - Consider security review

---

## Monitoring Recommendations

### Track Cleanup Progress

**Metrics to Monitor**:
- Lines of code (trend down)
- Number of files (trend down or stable)
- Bundle size (trend down)
- Build time (track for regressions)
- Test coverage (trend up)

**Tools**:
- SonarQube or SonarCloud
- Code Climate
- Codecov
- GitHub Actions size tracking

---

## Conclusion

Phase 1 cleanup demonstrated that careful, incremental cleanup is safe and effective. Future phases should:

1. **Continue gradual approach**
   - Small, verifiable changes
   - Comprehensive testing
   - Immediate rollback capability

2. **Prioritize safety**
   - Low-risk changes first
   - High-impact optimizations second
   - Breaking changes last (with migration plan)

3. **Maintain momentum**
   - Regular cleanup sessions
   - Document decisions
   - Track progress

---

## Next Steps

1. ✅ Review this document with team
2. ⏳ Select Phase 2 tasks to execute
3. ⏳ Schedule cleanup sessions (e.g., every sprint)
4. ⏳ Set up automated cleanup checks in CI

---

## Resources

- [Next.js Bundle Analyzer](https://www.npmjs.com/package/@next/bundle-analyzer)
- [depcheck](https://github.com/depcheck/depcheck)
- [ts-prune](https://github.com/nadeesha/ts-prune)
- [unimported](https://github.com/smeijer/unimported)
- [npm-check](https://github.com/dylang/npm-check)
