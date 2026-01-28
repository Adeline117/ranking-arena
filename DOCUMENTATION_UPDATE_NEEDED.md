# Documentation Update Needed

After Phase 2 cleanup, the following documentation files still reference old script names and need to be updated.

## Files to Update

### 1. README.md

**Search for**: `import_dydx.mjs`, `import_gmx.mjs`, `import_htx.mjs`, `import_hyperliquid.mjs`

**Replace with**: `import_dydx_enhanced.mjs`, `import_gmx_enhanced.mjs`, `import_htx_enhanced.mjs`, `import_hyperliquid_enhanced.mjs`

**Affected Sections**:
- Feature list (lines ~48-49)
- Usage examples (lines ~518, 522-524)
- Changelog (lines ~805-806)
- Chinese documentation (lines ~1275, 1279-1281)

### 2. .claude/settings.local.json

**Line 111**:
```json
"Bash(node scripts/import/import_gmx.mjs:*)",
```
Should be:
```json
"Bash(node scripts/import/import_gmx_enhanced.mjs:*)",
```

**Line 133**:
```json
"Bash(node scripts/import/import_htx.mjs:*)",
```
Should be:
```json
"Bash(node scripts/import/import_htx_enhanced.mjs:*)",
```

## Automated Fix Commands

```bash
# README.md updates
sed -i '' 's/import_dydx\.mjs/import_dydx_enhanced.mjs/g' README.md
sed -i '' 's/import_gmx\.mjs/import_gmx_enhanced.mjs/g' README.md
sed -i '' 's/import_htx\.mjs/import_htx_enhanced.mjs/g' README.md
sed -i '' 's/import_hyperliquid\.mjs/import_hyperliquid_enhanced.mjs/g' README.md

# .claude/settings.local.json updates
sed -i '' 's/import_gmx\.mjs/import_gmx_enhanced.mjs/g' .claude/settings.local.json
sed -i '' 's/import_htx\.mjs/import_htx_enhanced.mjs/g' .claude/settings.local.json
```

## Verification

After updates, verify no old references remain:

```bash
grep -n "import_dydx\.mjs\|import_gmx\.mjs\|import_htx\.mjs\|import_hyperliquid\.mjs" README.md .claude/settings.local.json
```

Expected output: No matches (empty)
