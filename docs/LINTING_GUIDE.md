# Linting Guide

This document explains the ESLint rules configured for the Ranking Arena project.

## Overview

The project uses ESLint with the flat config format (`eslint.config.mjs`). The base configuration extends:

- `eslint-config-next/core-web-vitals` - Next.js recommended rules for Core Web Vitals
- `eslint-config-next/typescript` - TypeScript-specific rules

## Rule Categories

### Disabled Rules (Legacy Patterns)

These rules are disabled because the codebase has existing patterns that would require significant refactoring to comply:

| Rule | Reason |
|------|--------|
| `@typescript-eslint/no-explicit-any` | Many utility functions and API handlers use `any` pragmatically. Gradual typing improvements are in progress. |
| `react-hooks/set-state-in-effect` | Some components use state updates in effects for legitimate reasons. |
| `react-hooks/immutability` | Current state management patterns don't fully comply. |
| `react-hooks/purity` | Some components have intentional side effects. |
| `@next/next/no-html-link-for-pages` | 404 and error pages use plain `<a>` tags intentionally. |
| `@next/next/no-img-element` | Some legacy components don't use Next.js Image. |

### Warning Rules (Non-Blocking)

These rules produce warnings to encourage best practices without blocking deployment:

| Rule | Description | Auto-fix |
|------|-------------|----------|
| `prefer-const` | Use `const` for variables that are never reassigned | Yes |
| `eqeqeq` | Use `===` instead of `==` (except for null checks) | Yes |
| `no-console` | Avoid `console.log`; use the logger utility instead | No |
| `@typescript-eslint/no-unused-vars` | Remove unused variables (underscore prefix ignores) | No |
| `no-empty` | Don't leave catch blocks empty | No |
| `no-async-promise-executor` | Don't use async functions in Promise constructors | No |

## Best Practices

### 1. Use the Logger Utility

Instead of:
```typescript
console.log('Data loaded', data)
console.error('Failed to load', error)
```

Use:
```typescript
import { logger, createLogger } from '@/lib/utils/logger'

// Use pre-defined loggers
import { apiLogger, dataLogger } from '@/lib/utils/logger'

apiLogger.info('Data loaded', { data })
apiLogger.error('Failed to load', { error: error.message })

// Or create a named logger
const myLogger = createLogger('my-component')
myLogger.debug('Processing started')
```

### 2. Handle Unused Variables

Pattern for intentionally unused variables:
```typescript
// Good - prefix with underscore
const [_unused, setUsed] = useState()
function handler(_event: MouseEvent) { /* ... */ }
try { /* ... */ } catch (_error) { /* handled silently */ }

// Bad - will produce warning
const unused = getValue()
function handler(event: MouseEvent) { /* event not used */ }
```

### 3. Use Strict Equality

```typescript
// Good
if (value === undefined) { }
if (value !== null) { }

// Bad (produces warning)
if (value == undefined) { }
if (value != null) { }
```

### 4. Don't Leave Empty Catch Blocks

```typescript
// Good - log or comment
try {
  riskyOperation()
} catch (error) {
  logger.warn('Operation failed, continuing', { error })
}

// Good - explicit ignore with comment
try {
  optionalOperation()
} catch {
  // Intentionally ignored: operation is optional
}

// Bad - empty catch
try {
  operation()
} catch {
}
```

## Running the Linter

```bash
# Check for issues
npm run lint

# Auto-fix where possible
npm run lint:fix

# Type-check only (no lint)
npm run type-check
```

## IDE Integration

### VS Code

Install the ESLint extension and add to `.vscode/settings.json`:

```json
{
  "eslint.useFlatConfig": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```

### WebStorm / IntelliJ

1. Go to **Preferences** → **Languages & Frameworks** → **JavaScript** → **Code Quality Tools** → **ESLint**
2. Enable **Automatic ESLint configuration**
3. Enable **Run eslint --fix on save**

## Ignoring Rules

### File-Level Ignore

```typescript
/* eslint-disable no-console */
// Entire file can use console
```

### Block-Level Ignore

```typescript
/* eslint-disable-next-line no-console */
console.log('This specific log is necessary')
```

### Inline Ignore

```typescript
console.log('Debug output') // eslint-disable-line no-console
```

### Directory Ignore

Add to `eslint.config.mjs`:
```javascript
globalIgnores([
  "some-directory/**",
])
```

## Gradual Improvement Plan

The team is working to gradually enable stricter rules:

1. **Phase 1 (Current)**: Warnings only, no blocking
2. **Phase 2**: Convert critical warnings to errors in CI
3. **Phase 3**: Enable `no-explicit-any` with specific escape hatches
4. **Phase 4**: Full strict mode compliance

## Related Files

- `eslint.config.mjs` - ESLint configuration
- `.prettierrc` - Prettier configuration (formatting)
- `tsconfig.json` - TypeScript configuration
- `.vscode/settings.json` - VS Code settings
