# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.3.0] - 2026-02-08

### Features
- About page, FAQ search, social links in Footer
- PWA install prompt hook and enhanced offline page
- Health API enhancements, freshness alerts, expanded admin stats
- ROI count-up animation, rank change arrows, sort fade animation
- UI micro-interactions + dark theme polish
- Search optimization + data validation scripts + card hover unification
- Frontend polish: skeleton screens, fade transitions, button feedback, lazy images, view transitions
- `roi_type` field in exchange config, connector snapshots, and trader detail UI
- Dynamic hero stats, footer, sidebar, mobile responsive homepage

### Fixes
- Stripe payment & Pro gating improvements
- NaN/Infinity guards, memory leak fixes, title truncation
- Admin auth protection for monitoring & data-health pages
- Library book detail page gates paid content by Pro status
- Community features: followers list query, rich text preview with code blocks
- Remove middleware.ts conflicting with proxy.ts
- Light theme visual issues: CSS vars instead of hardcoded dark colors
- Resolve all remaining TS errors from lint cleanup

### Performance
- Vercel Analytics, performance budget, slow API logging, sidebar prefetch
- Dynamic import WalletSection & OneClickWalletButton to code-split web3 bundle
- Mobile performance optimizations (spacer, pull-to-refresh, critical-css)

### Security
- Env validation, loading/error coverage, and DX improvements
- Error handling + reliability enhancements

### Testing
- 120 new tests for improved coverage
- E2E experience improvements

### Accessibility
- ARIA labels, focus traps, keyboard nav, screen reader support

### Other
- Design tokens: replace hardcoded colors for visual consistency
- i18n completeness, not-found pages, PWA icons
- SEO: metadata, canonical URLs, preconnect hints, resource prefetch
- Growth: registration conversion, onboarding, CTAs, social proof

## [0.2.0] - 2026-01-26

### Features
- OKX Futures, Weex, Hyperliquid, dYdX exchange support
- HTX (Huobi) copy trading leaderboard
- Uniswap spot trading leaderboard via Dune Analytics
- DeFi data integration (GMX, Nansen)
- Unified connector architecture (`connectors/`)
- Cloudflare Worker proxy for exchange IP restrictions
- Atomic counter functions for concurrency safety
- PullToRefresh component, push notification API

## [0.1.0] - 2026-01-01

- Initial release with Binance, Bybit, BingX, Bitget support
- Trader rankings, community features, copy trading data aggregation
