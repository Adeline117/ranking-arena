/**
 * 关键 CSS 内联优化
 * 提取首屏渲染必需的 CSS 样式
 *
 * Performance: This CSS is inlined in <head> to avoid render blocking
 * All non-critical CSS is loaded async after LCP
 */

import { tokens } from '@/lib/design-tokens'

const { container, gutter, breakpoint: homeTier } = tokens.layout
const BP_MD = Number.parseInt(tokens.breakpoint.md, 10) // 768
const BP_LG = Number.parseInt(tokens.breakpoint.lg, 10) // 1024

/**
 * Homepage outer container, generated from tokens.layout (owner decision
 * 2026-11-13): the nav inner row, hero, source strip and the three-column grid
 * all sit in ONE `.home-container` with ONE gutter, so their left/right edges
 * coincide at every width. At 1440px: (1440 - 1400) / 2 + 32 = 52px — the same
 * x the protected three-column smoke assertion already locks.
 */
export const containerCss = `
:root{--container-content:${container.content}px;--container-wide:${container.wide}px;--container-max:${container.max}px;--home-container:var(--container-wide);--container-gutter:${gutter.mobile}px}
@media(min-width:${BP_MD}px){:root{--container-gutter:${gutter.tablet}px}}
@media(min-width:${BP_LG}px){:root{--container-gutter:${gutter.desktop}px}}
@media(min-width:${homeTier.wide}px){:root{--home-container:var(--container-max)}}
.home-container{width:100%;max-width:var(--home-container);margin-left:auto;margin-right:auto;padding-left:var(--container-gutter);padding-right:var(--container-gutter)}
.home-container .three-col-layout{max-width:none;padding-left:0;padding-right:0}
.top-nav-inner.top-nav-inner--home{max-width:var(--home-container);padding-left:var(--container-gutter);padding-right:var(--container-gutter)}
.home-hero-shell{padding-top:12px}
@media(max-width:${BP_MD - 1}px){.home-hero-shell{padding-top:8px}.home-page-container{padding-top:8px}}
`

/**
 * 关键 CSS - 首屏必需样式
 * 包含：布局、字体、颜色、响应式网格、基础动画
 */
export const criticalCss = `
/* SSR-only fallback: visible before client app renders */
.ssr-only { display: block; }
/* 基础重置和布局 */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%;tab-size:4;scroll-behavior:auto}
body{margin:0;font-family:var(--font-inter),system-ui,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;max-width:100vw;width:100%}

/* 关键布局样式 */
.top-nav{position:sticky;top:0;z-index:100;background:var(--bg-primary,#0B0A10);height:56px;border-bottom:1px solid var(--glass-border,rgba(255,255,255,0.08))}
@media(max-width:400px){.top-nav-theme-action{display:none!important}}
@media(max-width:360px){.top-nav-logo-word{display:none!important}}
main{min-height:100vh;background:var(--bg-primary,#0B0A10)}

/* Root promo banner — present in the server HTML, localized and dismissed
   before paint without waiting for hydration. */
.pro-promo-lang{display:none}
.pro-promo-lang[data-pro-promo-lang="en"],html[lang="ja"] .pro-promo-lang[data-pro-promo-lang="ja"],html[lang="ko"] .pro-promo-lang[data-pro-promo-lang="ko"],html[lang="zh-CN"] .pro-promo-lang[data-pro-promo-lang="zh"]{display:inline}
html[lang="ja"] .pro-promo-lang[data-pro-promo-lang="en"],html[lang="ko"] .pro-promo-lang[data-pro-promo-lang="en"],html[lang="zh-CN"] .pro-promo-lang[data-pro-promo-lang="en"],html[data-pro-promo-hidden="true"] .pro-promo-banner{display:none}
.pro-promo-short{display:none}
@media(max-width:480px){.pro-promo-full{display:none}.pro-promo-short{display:inline}}

/* 字体变量 */
:root{
  --font-inter:'Inter',system-ui,sans-serif;
  --safe-area-inset-top:env(safe-area-inset-top,0px);
  --safe-area-inset-right:env(safe-area-inset-right,0px);
  --safe-area-inset-bottom:env(safe-area-inset-bottom,0px);
  --safe-area-inset-left:env(safe-area-inset-left,0px);
}

/* 深色主题颜色 (default) */
[data-theme="dark"]{
  --bg-primary:#0B0A10;
  --bg-secondary:#14121C;
  --bg-tertiary:#1C1926;
  --bg-hover:#252232;
  --text-primary:#EDEDED;
  --text-secondary:#A8A8B3;
  --text-tertiary:#8E8E9E;
  --accent-primary:var(--color-brand);
  --border-primary:#2A2836;
  --border-secondary:#3A3848;
  --glass-bg:rgba(20,18,28,0.85);
  --glass-border:rgba(255,255,255,0.1);
}

/* 浅色主题颜色 */
[data-theme="light"]{
  --bg-primary:#FFFFFF;
  --bg-secondary:#F8F8FA;
  --bg-tertiary:#F0F0F4;
  --bg-hover:#E8E8EC;
  --text-primary:#1A1A1A;
  --text-secondary:#5A5A6A;
  --text-tertiary:#8A8A9A;
  --accent-primary:#7B5F98;
  --border-primary:#E0E0E6;
  --border-secondary:#D0D0D8;
  --glass-bg:rgba(255,255,255,0.85);
  --glass-border:rgba(0,0,0,0.08);
}

/* ============================================
   响应式网格 - Critical for LCP
   ============================================ */
.main-grid{display:grid;gap:16px;grid-template-columns:1fr;align-items:start}
@media(min-width:768px){.main-grid{grid-template-columns:1fr 220px;gap:16px}}
@media(min-width:1024px){.main-grid{grid-template-columns:200px 1fr 220px;gap:16px}}
@media(min-width:1280px){.main-grid{grid-template-columns:220px 1fr 240px;gap:20px}}
@media(min-width:1440px){.main-grid{grid-template-columns:240px 1fr 260px;gap:24px}}

/* Three-column layout — Critical for CLS prevention.
   min-height reserves space before the grid content loads. */
.three-col-layout{display:grid;grid-template-columns:240px 1fr 260px;gap:20px;align-items:start;max-width:1400px;margin:0 auto;padding:0 16px;min-height:calc(100vh - 120px);contain:layout style}
@media(min-width:1024px) and (max-width:1279px){.three-col-layout{grid-template-columns:200px 1fr}.three-col-right{display:none!important}}
@media(min-width:1280px) and (max-width:1439px){.three-col-layout{grid-template-columns:220px 1fr 240px}}
@media(min-width:1441px){.three-col-layout{max-width:1600px;grid-template-columns:260px 1fr 280px}}
@media(max-width:1023px){.three-col-layout{display:block;padding:0 12px}.three-col-left,.three-col-right{display:none!important}}
@media(max-width:480px){.three-col-layout{padding:0 8px}}
.three-col-layout.three-col-no-left{grid-template-columns:1fr 260px}
.three-col-layout.three-col-no-left.three-col-no-right{grid-template-columns:1fr}
.three-col-layout.three-col-no-right:not(.three-col-no-left){grid-template-columns:240px 1fr}
@media(min-width:1024px) and (max-width:1279px){.three-col-layout.three-col-no-left{grid-template-columns:1fr}}
@media(min-width:1280px) and (max-width:1439px){.three-col-layout.three-col-no-left{grid-template-columns:1fr 240px}.three-col-layout.three-col-no-left.three-col-no-right{grid-template-columns:1fr}}
@media(min-width:1441px){.three-col-layout.three-col-no-left{grid-template-columns:1fr 280px}.three-col-layout.three-col-no-left.three-col-no-right{grid-template-columns:1fr}.three-col-layout.three-col-no-right:not(.three-col-no-left){grid-template-columns:260px 1fr}}
.three-col-center{min-height:calc(100vh - 60px);min-width:0;overflow-x:clip}

/* Safe Area (iPhone 刘海屏) */
.safe-area-inset-bottom{padding-bottom:var(--safe-area-inset-bottom,0px)}
.safe-area-inset-top{padding-top:var(--safe-area-inset-top,0px)}
.has-mobile-nav{padding-bottom:calc(var(--mobile-nav-height,60px) + var(--safe-area-inset-bottom,0px))}
@media(min-width:768px){.has-mobile-nav{padding-bottom:0}}

/* 移动端容器 */
.mobile-container{padding-left:16px;padding-right:16px;max-width:100%}

/* ============================================
   响应式显示/隐藏 - Critical for layout
   ============================================ */
.hide-mobile{display:none}
.show-mobile{display:block}
.show-mobile-flex{display:flex}
.hide-desktop{display:block}
.show-below-lg{display:block}

@media(min-width:768px){
  .hide-mobile{display:block}
  .show-mobile,.show-mobile-flex{display:none}
  .hide-desktop{display:none}
}

@media(min-width:1024px){
  .hide-tablet{display:block}
  .show-tablet{display:none}
  .show-below-lg{display:none}
}

/* ============================================
   关键动画 - Only essential for LCP
   ============================================ */
@keyframes shimmer{
  0%{transform:translateX(-100%)}
  100%{transform:translateX(100%)}
}
@keyframes fadeIn{
  from{opacity:0;transform:translateY(-4px)}
  to{opacity:1;transform:translateY(0)}
}
@keyframes spin{to{transform:rotate(360deg)}}

/* 骨架屏 — GPU-composited via transform (not background-position) */
.skeleton{
  position:relative;
  overflow:hidden;
  background:rgba(255,255,255,0.05);
}
.skeleton::after{
  content:'';
  position:absolute;
  inset:0;
  background:linear-gradient(90deg,transparent 25%,rgba(255,255,255,0.08) 50%,transparent 75%);
  animation:shimmer 2s infinite linear;
  will-change:transform;
}

/* mesh-gradient-bg disabled for performance — expensive fixed-position compositor layer */
.mesh-gradient-bg{display:none}

/* ============================================
   Ranking Table Layout - LCP Element
   Minimum layout for the ranking table grid so
   rows render at the correct size before async CSS loads.
   ============================================ */
.ranking-table-grid{display:grid;gap:8px;align-items:center;min-height:52px;padding:0 16px;contain:layout style}
.ranking-table-grid.ranking-row{display:grid;gap:8px;align-items:center;min-height:52px;padding:0 16px;transition:background 0.15s ease}
.sort-header{display:flex;align-items:center;gap:4px;background:none;border:none;padding:0;cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap;font-size:10px;font-weight:500;color:var(--color-text-quaternary,var(--color-text-tertiary));min-height:44px}
.toolbar-btn{display:flex;align-items:center;justify-content:center;gap:3px;padding:4px 8px;height:26px;border-radius:6px;border:1px solid var(--border-secondary,#3A3848);background:var(--bg-tertiary,#1C1926);color:var(--text-secondary,#A8A8B3);cursor:pointer;font-size:11px}

/* ============================================
   防止布局偏移 (CLS)
   ============================================ */
img{display:block;max-width:100%;height:auto}
video{display:block;max-width:100%}
iframe{display:block;max-width:100%}

/* Homepage layout — prevents CLS when Phase 2 mounts */
.home-page-root{min-height:100vh;background:var(--bg-primary,#0B0A10);color:var(--text-primary,#EDEDED)}
/* Width + horizontal padding come from .home-container (containerCss below);
   this only keeps the vertical rhythm and stacking. */
.home-page-container{position:relative;z-index:1;padding-top:16px}
${containerCss}
/* Phase 2 is appended after the server shell. Hide the geometry-matched shell
   in the same style calculation that reveals the interactive root; the
   HomePageClient layout effect remains the fallback for browsers without :has. */
html:has(#homepage-interactive) #ssr-home-content-shell{display:none}

/* CSS Containment for rendering performance */
.trader-card-contained{contain:layout style paint}
.sidebar-contained{contain:layout style}

/* content-visibility:auto skips rendering of off-screen content until scrolled into view.
   Dramatically reduces initial rendering work (TBT) and improves Speed Index. */
.three-col-left,.three-col-right{content-visibility:auto;contain-intrinsic-size:auto 600px}
/* Below-fold content: defer rendering until scrolled into view */
footer,.sidebar-contained{content-visibility:auto;contain-intrinsic-size:auto 300px}

/* ============================================
   Ranking Table Grid — CRITICAL for CLS
   Without these, the grid renders with wrong columns
   until responsive.css loads async (causes 0.1+ CLS).
   Desktop table only: below 768px the ranking renders .mrow rows (see the
   mobile ranking block further down), never the grid table.
   ============================================ */
.ranking-table-grid .col-sharpe,.ranking-table-grid .col-followers,.ranking-table-grid .col-trades,.ranking-table-grid .col-copiers{display:none !important}
@media(min-width:768px){.ranking-table-grid{grid-template-columns:44px minmax(140px,1.5fr) 80px 80px 70px 70px 64px !important}.ranking-table-grid .col-score,.ranking-table-grid .col-pnl,.ranking-table-grid .col-winrate,.ranking-table-grid .col-mdd{display:flex !important}}

/* SSR ranking table — one responsive DOM, desktop grid / mobile .mrow rows.
   The desktop columns mirror RankingTable's default information architecture;
   below 768px the same cells reflow, so no duplicate link/value tree exists. */
.ssr-t{background:var(--color-bg-secondary);border-radius:16px;border:1px solid var(--color-border-primary);overflow:hidden}
.ssr-ranking-table{width:100%;max-width:100%;min-width:0;overflow:hidden;background:var(--color-bg-secondary)}
.ssr-ranking-grid{display:grid;grid-template-columns:40px minmax(0,1.5fr) 58px 96px 80px 64px 64px;column-gap:12px;align-items:center;min-width:0;max-width:100%}
.ssr-filter-bar{height:63px}
.ssr-ranking-header{min-height:61px;padding:8px 20px;border-bottom:1px solid var(--glass-border-light);background:var(--color-bg-secondary)}
.ssr-ranking-header>span{min-width:0;color:var(--color-text-tertiary);font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ssr-ranking-header>span:first-child,.ssr-ranking-header>span:nth-child(3){text-align:center}
.ssr-ranking-header>span:nth-child(n+4){text-align:right}
.ssr-ranking-body{min-width:0;display:flex;flex-direction:column}
.ssr-ranking-entry{min-height:58px;padding:14px 20px;color:inherit;text-decoration:none;border-bottom:1px solid var(--color-border-primary);position:relative;contain:layout style}
.ssr-ranking-entry:hover{background:linear-gradient(90deg,var(--color-accent-primary-08) 0%,transparent 50%)}
.ssr-ranking-entry:focus-visible{outline:2px solid var(--color-brand);outline-offset:-2px;border-radius:4px}
.ssr-ranking-entry:active{transform:scale(.998)}
.ssr-ranking-entry-rank-1{min-height:72px;margin:6px 0 8px;border-radius:14px;background:linear-gradient(135deg,rgba(255,215,0,.18) 0%,rgba(255,215,0,.06) 35%,rgba(255,215,0,.02) 70%,transparent 100%);box-shadow:inset 4px 0 0 var(--color-rank-gold)}
.ssr-ranking-entry-rank-2{min-height:72px;margin:4px 0 6px;border-radius:14px;background:linear-gradient(135deg,rgba(192,192,192,.14) 0%,rgba(192,192,192,.04) 35%,transparent 80%);box-shadow:inset 4px 0 0 var(--color-rank-silver)}
.ssr-ranking-entry-rank-3{min-height:72px;margin:4px 0 6px;border-radius:14px;background:linear-gradient(135deg,rgba(205,127,50,.14) 0%,rgba(205,127,50,.04) 35%,transparent 80%);box-shadow:inset 4px 0 0 var(--color-rank-bronze)}
.ssr-rank-cell{display:flex;align-items:center;justify-content:center;min-width:0}
.ssr-rank-medal{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:var(--color-bg-primary);font-size:13px;font-weight:700}
.ssr-rank-medal-1{background:linear-gradient(135deg,var(--color-medal-gold),var(--color-medal-gold-end))}
.ssr-rank-medal-2{background:linear-gradient(135deg,var(--color-medal-silver),var(--color-medal-silver-end))}
.ssr-rank-medal-3{background:linear-gradient(135deg,var(--color-medal-bronze),var(--color-medal-bronze-end))}
.ssr-rank-number{color:var(--color-text-tertiary);font-size:14px;font-weight:800}
.ssr-trader-cell{display:flex;align-items:center;gap:10px;min-width:0}
.ssr-trader-avatar{width:36px;height:36px;min-width:36px;aspect-ratio:1;border-radius:50%;background:linear-gradient(135deg,var(--color-accent-primary-30),var(--color-pro-gold-border,#a78bfa));border:2px solid var(--color-border-primary);display:flex;align-items:center;justify-content:center;color:var(--color-on-accent,#fff);font-size:14px;font-weight:700;overflow:hidden;position:relative;contain:layout style paint}
.ssr-trader-avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%;position:absolute;inset:0}
.ssr-trader-copy{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0}
.ssr-trader-name{max-width:100%;color:var(--color-text-primary);font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssr-source-tag{padding:1px 6px;border-radius:6px;color:var(--color-text-tertiary);background:color-mix(in srgb,var(--color-text-tertiary) 8%,transparent);border:1px solid color-mix(in srgb,var(--color-text-tertiary) 19%,transparent);font-size:11px;font-weight:700;line-height:1.4;white-space:nowrap}
.ssr-score-cell{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-width:0}
.ssr-score-badge{width:38px;height:38px;border-radius:50%;border:1px solid var(--ssr-score-ring,var(--color-border-primary));background:transparent;color:var(--color-text-primary);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.ssr-roi-cell{display:flex;justify-content:flex-end;align-items:center;min-width:0;text-align:right}
.ssr-supporting-metrics{display:contents}
.ssr-metric-cell{display:flex;justify-content:flex-end;align-items:center;min-width:0;text-align:right}
.ssr-metric-value{color:var(--color-text-secondary);font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.ssr-sharpe-cell{display:none}
.ssr-ranking-empty{padding:48px 16px;text-align:center;color:var(--color-text-tertiary)}
.ssr-ranking-empty p:first-child{margin-bottom:8px;font-size:14px}
.ssr-ranking-empty p:last-child{font-size:13px}
/* ============================================
   Mobile ranking rows (<768px) — the ONE place for mobile ranking layout.
   Shared by the SSR shell (SSRRankingTable: .ssr-ranking-entry.mrow) and the
   client tree (MobileRankRows.tsx: MobileRankHeader + TraderMobileRow), so the
   hydration hand-off cannot jump. Owner decision 2026-11-13: ~56px flat rows,
   1px separators, no per-row card or metric tiles; top-3 keep a thin medal
   bar. Rank | avatar+name(+source tag) | Score (primary) | one secondary metric,
   chosen via html[data-rank-metric] (roi default | pnl | win | mdd).
   The table view never renders below 768px, so there are no mobile
   .ranking-table-grid rules anywhere (they used to fight here, in globals.css,
   responsive.css and ranking-table.css with !important).
   ============================================ */
.mrow-head{display:none}
.ranking-controls-bar{display:flex;align-items:center;gap:12px;margin-bottom:8px;min-height:48px;flex-wrap:wrap}
.ranking-controls-divider{width:1px;height:24px;background:var(--color-border-primary);flex-shrink:0}
.time-range-selector{padding:4px}
.time-range-selector .time-range-btn{padding:10px 16px;min-height:44px}
.category-tabs .touch-target-sm{min-height:36px}
@media(max-width:639px){.category-tabs .touch-target-sm{min-height:44px}}
.rank-stat{color:var(--color-text-secondary);font-size:13px;font-weight:500;line-height:1.2;font-variant-numeric:tabular-nums;white-space:nowrap}
@media(max-width:767px){
  /* Period + category in ONE 52px row (was two wrapped rows + a 16px async
     margin) so the rows reach the first screen. */
  .ranking-controls-bar{flex-wrap:nowrap;gap:8px;min-height:0}
  .ranking-controls-divider{display:none}
  .time-range-selector{padding:2px;flex-shrink:0}
  .time-range-selector .time-range-btn{padding:8px 12px;min-height:44px;min-width:0}
  .ranking-controls-bar .category-tabs{flex:1 1 auto;min-width:0}
  .ssr-ranking-table{padding:0;background:transparent}
  .ssr-ranking-header{display:none}
  /* Reserve exactly the client controls (52 + 8) and toolbar row so the SSR
     header + rows start where the hydrated ones do (measured, like desktop). */
  .ssr-t .ssr-controls{height:52px;padding:0 12px;flex-wrap:nowrap;overflow:hidden}
  .ssr-t .ssr-pagination{display:none}
  .ssr-filter-bar{display:block;height:57px}
  .ssr-ranking-body{display:block}
  .mrow-head,.mrow{display:grid;grid-template-columns:24px minmax(0,1fr) 44px 84px;column-gap:10px;align-items:center;width:100%;max-width:100%;padding:0 12px}
  .mrow-head{height:32px;border-bottom:1px solid var(--color-border-primary);color:var(--color-text-tertiary);font-size:11px;font-weight:600;letter-spacing:.04em;line-height:1;text-transform:uppercase;white-space:nowrap}
  .mrow-head>span:first-child,.mrow-head-score{text-align:center}
  .mrow-head-sort{position:relative;display:flex;align-items:center;min-width:0;height:100%}
  .mrow-head-metric{position:relative;display:flex;align-items:center;justify-content:flex-end;height:100%}
  .mrow-head-metric-label{display:inline-flex;align-items:center;gap:4px;color:var(--color-text-secondary)}
  .mrow-head-select{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;opacity:0;font-size:16px;cursor:pointer;-webkit-appearance:none;appearance:none}
  .mrow{position:relative;height:56px;min-height:56px;margin:0;color:inherit;text-decoration:none;background:transparent;border:0;border-bottom:1px solid var(--color-border-primary);border-radius:0;box-shadow:none;contain:layout style}
  .mrow-top-1{box-shadow:inset 3px 0 0 var(--color-rank-gold)}
  .mrow-top-2{box-shadow:inset 3px 0 0 var(--color-rank-silver)}
  .mrow-top-3{box-shadow:inset 3px 0 0 var(--color-rank-bronze)}
  .mrow-selected{background:var(--color-accent-primary-08)}
  .mrow-rank{display:flex;align-items:center;justify-content:center;min-width:0;color:var(--color-text-tertiary);font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
  .mrow-top .mrow-rank{color:var(--color-text-primary)}
  .mrow-rank .ssr-rank-medal,.mrow-rank .ssr-rank-number{width:auto;height:auto;background:none;color:inherit;font-size:13px;font-weight:700}
  .mrow-trader{display:flex;align-items:center;gap:10px;min-width:0}
  .mrow-trader .ssr-trader-avatar{width:32px;height:32px;min-width:32px;font-size:12px}
  .mrow-copy{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0}
  .mrow-name{max-width:100%;color:var(--color-text-primary);font-size:14px;font-weight:600;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mrow-tag{padding:0;border:0;border-radius:0;background:none;color:var(--color-text-tertiary);font-size:11px;font-weight:500;line-height:14px;white-space:nowrap}
  .mrow-score-cell{display:flex;align-items:center;justify-content:center;min-width:0}
  /* !important only to beat ScoreMiniBar's inline display:flex in the SSR cell. */
  .mrow-score-cell>:not(.mrow-score){display:none!important}
  .mrow-score{position:relative;display:inline-flex;align-items:center;justify-content:center;width:auto;min-width:40px;height:28px;padding:0 5px;border:1px solid var(--mrow-score-ring,var(--color-border-primary));border-radius:999px;background:transparent;color:var(--color-text-primary);font-size:18px;font-weight:700;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .ssr-supporting-metrics{display:contents}
  .mrow .mrow-m{grid-column:4;grid-row:1;display:none;align-items:center;justify-content:flex-end;min-width:0;padding:0;background:none;border-radius:0;text-align:right;white-space:nowrap;overflow:hidden}
  html:not([data-rank-metric]) .mrow .mrow-m-roi,html[data-rank-metric="roi"] .mrow .mrow-m-roi,html[data-rank-metric="pnl"] .mrow .mrow-m-pnl,html[data-rank-metric="win"] .mrow .mrow-m-win,html[data-rank-metric="mdd"] .mrow .mrow-m-mdd{display:flex}
  .mrow-head .mrow-m{display:none}
  html:not([data-rank-metric]) .mrow-head .mrow-m-roi,html[data-rank-metric="roi"] .mrow-head .mrow-m-roi,html[data-rank-metric="pnl"] .mrow-head .mrow-m-pnl,html[data-rank-metric="win"] .mrow-head .mrow-m-win,html[data-rank-metric="mdd"] .mrow-head .mrow-m-mdd{display:inline}
  .mrow-list .ranking-inline-signup{width:auto;margin:8px 12px}
}
.ssr-controls{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;gap:8px;flex-wrap:wrap;position:relative}
.ssr-range-bar{display:flex;gap:4px}
.ssr-range-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--color-border-primary);background:transparent;color:var(--color-text-secondary);font-size:12px;font-weight:600;cursor:pointer;transition:all 0.15s}
.ssr-range-btn:hover{background:var(--color-bg-hover);color:var(--color-text-primary)}
.ssr-range-active{background:var(--color-accent-primary-15,rgba(167,139,250,0.15));color:var(--color-accent-primary,#a78bfa);border-color:var(--color-accent-primary-30,rgba(167,139,250,0.3))}
.ssr-pagination{display:flex;align-items:center;gap:8px}
.ssr-page-btn{padding:6px 12px;border-radius:6px;border:1px solid var(--color-border-primary);background:transparent;color:var(--color-text-secondary);font-size:12px;cursor:pointer;transition:all 0.15s}
.ssr-page-btn:hover:not(:disabled){background:var(--color-bg-hover);color:var(--color-text-primary)}
.ssr-page-btn:disabled{opacity:0.4;cursor:not-allowed}
.ssr-page-info{font-size:12px;color:var(--color-text-tertiary);font-variant-numeric:tabular-nums;min-width:48px;text-align:center}
.ssr-loading-bar{position:fixed;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent 0%,var(--color-accent-primary,#a78bfa) 30%,var(--color-accent-primary,#a78bfa) 70%,transparent 100%);z-index:9999;animation:ssr-loading 1.2s ease-in-out infinite;box-shadow:0 0 8px var(--color-accent-primary,#a78bfa)}
@keyframes ssr-loading{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.ssr-controls[data-pending="true"] ~ .ssr-t,.ssr-controls[data-pending="true"]~table{opacity:0.6;transition:opacity 0.2s;pointer-events:none}
[data-theme='light'] .ssr-t{box-shadow:0 1px 3px rgba(0,0,0,0.05)}

/* Global tabular-nums for all number displays — prevents CLS from digit width shifts */
td,th,.ranking-row,.ssr-ranking-entry,.ssr-score-badge,.ssr-metric-value,.col-score,.col-pnl,.col-roi,.col-winrate,.col-mdd,.stat-value,.price-value,.pnl-value,.percentage-value,.rank-number,.roi-value,.metric-value,.number-display,[data-value]{font-variant-numeric:tabular-nums}

/* 预留空间 - 防止字体加载导致的CLS */
.font-loading body{letter-spacing:-0.011em}

/* Focus 样式 */
:focus-visible{outline:2px solid var(--accent-primary);outline-offset:2px}

/* Selection */
::selection{background:var(--accent-primary);color:#FFFFFF}

/* ============================================
   Scrollbar (Critical for layout width calculation)
   ============================================ */
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:var(--bg-secondary,#14121C)}
::-webkit-scrollbar-thumb{background:var(--border-secondary,#3A3848);border-radius:4px}
.scrollbar-hidden{scrollbar-width:none;-ms-overflow-style:none}
.scrollbar-hidden::-webkit-scrollbar{display:none}
`

/**
 * 获取内联的关键 CSS
 * 在生产环境中会被压缩
 */
export function getCriticalCss(): string {
  if (process.env.NODE_ENV === 'production') {
    // 生产环境：full minification pipeline (~30% smaller than whitespace-only)
    return criticalCss
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove CSS comments
      .replace(/\s+/g, ' ') // Collapse whitespace
      .replace(/\s*([{}:;,>+~])\s*/g, '$1') // Remove space around operators
      .replace(/;}/g, '}') // Remove trailing semicolons before }
      .trim()
  }
  // 开发环境：保持可读性
  return criticalCss
}

/**
 * 预加载字体
 * 确保关键字体尽早加载
 */
export function getFontPreloadLinks(): Array<{
  href: string
  as: string
  type: string
  crossOrigin: string
}> {
  return [
    {
      href: '/_next/static/media/inter-var.woff2',
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    },
  ]
}

/**
 * 资源提示
 * 预连接到关键域
 *
 * preconnect: Establishes early connection (DNS + TCP + TLS) -- use for origins fetched within seconds.
 * dns-prefetch: DNS lookup only -- cheaper fallback for browsers that cap preconnects.
 */
export function getResourceHints(): Array<{
  rel: string
  href: string
  crossOrigin?: 'anonymous' | 'use-credentials' | ''
}> {
  const hints: Array<{
    rel: string
    href: string
    crossOrigin?: 'anonymous' | 'use-credentials' | ''
  }> = [
    // Supabase preconnect REMOVED — homepage SSR fetches server-side only.
    // Client-side Supabase calls don't start until Phase 2 interaction (~4s+).
    // Preconnect was wasting a TCP+TLS handshake on initial load.
    // dns-prefetch only (no TCP/TLS) for top exchange avatar CDNs — cheap, saves ~100ms on first avatar
    { rel: 'dns-prefetch', href: 'https://bin.bnbstatic.com' },
    { rel: 'dns-prefetch', href: 'https://www.okx.com' },
    { rel: 'dns-prefetch', href: 'https://public.bnbstatic.com' },
  ]

  return hints
}
