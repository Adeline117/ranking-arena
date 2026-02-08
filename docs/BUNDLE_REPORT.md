# Bundle Analysis Report

**Date:** 2026-02-08  
**Build:** Next.js 16.1.6 (Turbopack)  
**Total client chunks:** ~15 MB (uncompressed)

## Largest Chunks

| Size | Hash | Primary Contents |
|------|------|-----------------|
| 641 KB | `fc07bb95` | Prism.js / syntax highlighting grammar (ethers types) |
| 638 KB | `a3133fb0` | Mixed: chart libs, ethers, viem, Sentry, React |
| 539 KB | `a733fde5` | Syntax highlighting, React, Sentry, Supabase |
| 538 KB | `8d212034` | viem (Ethereum library) |
| 519 KB | `60e08aa1` | React internals |
| 408 KB | `b2aabf11` | React components |
| 347 KB | `09640f81` | React components |
| 320 KB | `5ff2bb41` | Syntax highlighting (highlight.js or prism) |
| 298 KB | `489b5489` | wagmi (web3 hooks) |
| 298 KB | `75a0b0c7` | wagmi (web3 hooks) |
| 298 KB | `810613bb` | wagmi (web3 hooks) |

## Key Observations

### 1. Web3 Libraries (~1.4 MB)
- **viem**: ~538 KB chunk
- **wagmi**: ~900 KB across 3 chunks  
- These are loaded even on pages that don't use web3 features

### 2. Syntax Highlighting (~960 KB)
- Two large chunks for Prism/highlight.js
- Likely used for code display in posts or trader analysis

### 3. Sentry (~included in multiple chunks)
- Sentry SDK is bundled into several chunks rather than a single shared chunk

## Recommendations

### High Impact
1. **Lazy-load web3 libraries** — Use `next/dynamic` for wallet/web3 components. viem + wagmi total ~1.4 MB and most users don't need them on initial load.
   ```tsx
   const WalletConnect = dynamic(() => import('./WalletConnect'), { ssr: false })
   ```

2. **Lazy-load syntax highlighting** — ~960 KB for code highlighting. Load only when rendering code blocks.
   ```tsx
   const CodeBlock = dynamic(() => import('./CodeBlock'), { ssr: false })
   ```

3. **Tree-shake viem** — Import specific functions instead of the entire library:
   ```ts
   // ❌ import { createPublicClient, http, parseAbi } from 'viem'
   // ✅ import { createPublicClient } from 'viem/clients'
   ```

### Medium Impact
4. **Reduce Sentry bundle** — Use `@sentry/nextjs` tree-shaking options, disable replay/profiling if not needed.

5. **Audit `optimizePackageImports`** in `next.config.ts` — Add large libs:
   ```ts
   experimental: {
     optimizePackageImports: ['lucide-react', '@radix-ui/react-icons', 'viem', 'wagmi']
   }
   ```

### Low Impact  
6. **Enable gzip/brotli** — Already enabled (`compress: true`). Verify CDN serves brotli.
7. **Review shared chunks** — Multiple wagmi chunks suggest poor chunk splitting; consider manual `splitChunks` config.

## Estimated Savings

| Optimization | Estimated Savings |
|-------------|-------------------|
| Lazy-load web3 | ~1.4 MB off critical path |
| Lazy-load syntax highlighting | ~960 KB off critical path |
| Sentry tree-shaking | ~100-200 KB |
| **Total** | **~2.5 MB off initial load** |
