# Performance Baseline Report

**Date:** 2026-02-08  
**Project:** Ranking Arena (arenafi.org)  
**Stack:** Next.js 16 (Turbopack)  
**Test Location:** Local Mac Mini → Production

---

## 1. Bundle Size Analysis

### Total Client-Side JS
- **Total:** 14,379 KB (14.04 MB) across 407 files

### Top 10 Largest JS Chunks

| # | File | Size (KB) | Identified Content |
|---|------|-----------|-------------------|
| 1 | `fc07bb95e96f4af8.js` | 641 KB | SIWE (Sign-In with Ethereum) grammar parser |
| 2 | `a3133fb0a17515b5.js` | 638 KB | Coinbase Wallet SDK / MetaMask SDK |
| 3 | `a4add2e80d271733.js` | 539 KB | Next.js internals (BloomFilter, router) |
| 4 | `8d212034adeed6d5.js` | 538 KB | viem/ABI/contract utilities |
| 5 | `60e08aa12ebbee28.js` | 520 KB | viem/wagmi chain definitions |
| 6 | `b2aabf1146098928.js` | 408 KB | WalletConnect / wallet connectors |
| 7 | `09640f81eddb9eb5.js` | 348 KB | Crypto/wallet related |
| 8 | `686d99f0895f401a.js` | 320 KB | Wallet infrastructure |
| 9 | `810613bb5c475983.js` | 298 KB | Shared chunk (duplicated 3x) |
| 10 | `75a0b0c78b0bfad7.js` | 298 KB | Shared chunk (duplicated) |

**Web3/Wallet SDK total: ~3.7 MB** (chunks 1-8) — dominates the bundle.

---

## 2. API Response Time Baseline

| API Endpoint | HTTP | TTFB | Total | Response Size |
|---|---|---|---|---|
| `/api/health` | 200 | 1.167s | 1.167s | 462 B |
| `/api/traders?period=7d&limit=20` | 200 | 1.701s | 1.701s | 5.6 KB |
| `/api/library?limit=20` | 200 | 3.977s | 3.978s | 18.5 KB |
| `/api/flash-news?limit=10` | 200 | 0.797s | 0.797s | 7.4 KB |

### Observations
- **`/api/health`** takes 1.17s — very slow for a health check, should be <100ms
- **`/api/library`** is the slowest at ~4s — likely heavy DB query or external API call
- **`/api/traders`** at 1.7s — moderate, could benefit from caching
- **`/api/flash-news`** at 0.8s — acceptable but could be faster

---

## 3. Page Load (TTFB) Baseline

| Page | HTTP | TTFB | Total | Size |
|---|---|---|---|---|
| `/` (Homepage) | 200 | 0.355s | 0.365s | 168 KB |
| `/rankings` | 200 | 0.640s | 0.644s | 159 KB |
| `/library` | 200 | 0.084s | 0.088s | 116 KB |

### Observations
- **Library page** has the best TTFB at 84ms — likely SSG or well-cached
- **Homepage** TTFB 355ms — acceptable for SSR
- **Rankings** TTFB 640ms — likely involves data fetching at render time

---

## 4. Optimization Recommendations

### 🔴 Critical: Bundle Size (14 MB client JS)

1. **Lazy-load wallet SDKs** — MetaMask SDK (638KB), SIWE grammar (641KB), Coinbase SDK, and WalletConnect (~3.7MB total) should be dynamically imported only when user initiates wallet connection
2. **Tree-shake viem/wagmi** — 1+ MB of chain definitions and ABI utilities; configure to only include chains actually used
3. **Deduplicate shared chunks** — `810613bb`, `75a0b0c7`, `489b5489` are identical (298KB × 3 = 894KB wasted)

### 🟡 Important: API Performance

4. **Health endpoint** — Should return instantly; remove any DB/external calls from `/api/health`
5. **Cache `/api/library`** — 4s response time is unacceptable; add Redis/in-memory cache with 5-min TTL
6. **Cache `/api/traders`** — Add ISR or SWR caching, data doesn't change per-second
7. **Add CDN caching headers** — `Cache-Control` on API responses for Vercel Edge

### 🟢 Nice to Have

8. **Consider RSC streaming** — Next.js 16 supports streaming; use Suspense boundaries to show content progressively
9. **Preload critical data** — Use `prefetch` for rankings data on homepage
10. **Compress API responses** — Ensure gzip/brotli is enabled for all API routes

### Target Metrics

| Metric | Current | Target |
|---|---|---|
| Total Client JS | 14.04 MB | < 5 MB |
| Wallet SDK (initial load) | ~3.7 MB | 0 (lazy) |
| `/api/health` TTFB | 1.17s | < 100ms |
| `/api/library` TTFB | 3.98s | < 500ms |
| `/api/traders` TTFB | 1.70s | < 500ms |
| Homepage TTFB | 355ms | < 200ms |
