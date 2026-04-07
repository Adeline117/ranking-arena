/**
 * 关键 CSS 内联优化
 * 提取首屏渲染必需的 CSS 样式
 *
 * Performance: This CSS is inlined in <head> to avoid render blocking
 * All non-critical CSS is loaded async after LCP
 */

/**
 * 关键 CSS - 首屏必需样式
 * 包含：布局、字体、颜色、响应式网格、基础动画
 */
export const criticalCss = `
/* SSR-only fallback: visible before client app renders */
.ssr-only { display: block; }
/* 基础重置和布局 */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%;tab-size:4;scroll-behavior:smooth}
body{margin:0;font-family:var(--font-inter),system-ui,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;overflow-x:hidden}

/* 关键布局样式 */
.top-nav{position:sticky;top:0;z-index:100;background:var(--bg-primary,#0B0A10);height:56px;border-bottom:1px solid var(--glass-border,rgba(255,255,255,0.08))}
main{min-height:100vh;background:var(--bg-primary,#0B0A10)}

/* 字体变量 */
:root{
  --font-inter:'Inter',system-ui,sans-serif;
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
.three-col-layout{display:grid;grid-template-columns:1fr;gap:20px;align-items:start;max-width:1400px;margin:0 auto;padding:0 16px;min-height:calc(100vh - 120px);contain:layout style}
@media(min-width:1024px){.three-col-layout{grid-template-columns:200px 1fr}}
@media(min-width:1280px){.three-col-layout{grid-template-columns:240px 1fr 260px}}
@media(max-width:1023px){.three-col-layout{display:block;padding:0 12px}.three-col-left,.three-col-right{display:none !important}}
.three-col-center{min-height:calc(100vh - 60px);min-width:0;overflow-x:hidden}

/* Safe Area (iPhone 刘海屏) */
.safe-area-inset-bottom{padding-bottom:env(safe-area-inset-bottom,0)}
.safe-area-inset-top{padding-top:env(safe-area-inset-top,0)}
.has-mobile-nav{padding-bottom:calc(var(--mobile-nav-height,60px) + env(safe-area-inset-bottom,0))}
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
  0%{background-position:-1000px 0}
  100%{background-position:1000px 0}
}
@keyframes fadeIn{
  from{opacity:0;transform:translateY(-4px)}
  to{opacity:1;transform:translateY(0)}
}
@keyframes spin{to{transform:rotate(360deg)}}

/* 骨架屏 */
.skeleton{
  background:linear-gradient(90deg,rgba(255,255,255,0.05) 25%,rgba(255,255,255,0.1) 50%,rgba(255,255,255,0.05) 75%);
  background-size:1000px 100%;
  animation:shimmer 2s infinite linear;
}

/* mesh-gradient-bg disabled for performance — expensive fixed-position compositor layer */
.mesh-gradient-bg{display:none}

/* ============================================
   Ranking Table Layout - LCP Element
   Minimum layout for the ranking table grid so
   rows render at the correct size before async CSS loads.
   ============================================ */
.ranking-table-grid{display:grid;gap:8px;align-items:center;min-height:52px;padding:0 16px;contain:layout style}
.ranking-row{display:grid;gap:8px;align-items:center;min-height:52px;padding:0 16px;transition:background 0.15s ease}
.sort-header{display:flex;align-items:center;gap:4px;background:none;border:none;padding:0;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;font-size:12px;font-weight:700;color:var(--text-tertiary,#6B6B7B)}
.toolbar-btn{display:flex;align-items:center;justify-content:center;gap:3px;padding:4px 8px;height:26px;border-radius:6px;border:1px solid var(--border-secondary,#3A3848);background:var(--bg-tertiary,#1C1926);color:var(--text-secondary,#A8A8B3);cursor:pointer;font-size:11px}

/* ============================================
   防止布局偏移 (CLS)
   ============================================ */
img{display:block;max-width:100%;height:auto}
video{display:block;max-width:100%}
iframe{display:block;max-width:100%}

/* Homepage layout — prevents CLS when Phase 2 mounts */
.home-page-root{min-height:100vh;background:var(--bg-primary,#0B0A10);color:var(--text-primary,#EDEDED)}
.home-page-container{max-width:1400px;margin:0 auto;padding:8px 16px}

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
   ============================================ */
/* Mobile: Rank | Trader | ROI only */
.ranking-table-grid{grid-template-columns:36px 1fr 80px !important}
.ranking-table-grid .col-score,.ranking-table-grid .col-pnl,.ranking-table-grid .col-winrate,.ranking-table-grid .col-mdd,.ranking-table-grid .col-sharpe,.ranking-table-grid .col-followers,.ranking-table-grid .col-trades,.ranking-table-grid .col-copiers{display:none !important}
@media(min-width:640px){.ranking-table-grid{grid-template-columns:40px 1fr 80px 60px 80px !important}.ranking-table-grid .col-score,.ranking-table-grid .col-pnl{display:flex !important}}
@media(min-width:768px){.ranking-table-grid{grid-template-columns:44px minmax(140px,1.5fr) 80px 80px 70px 70px 64px !important}.ranking-table-grid .col-score,.ranking-table-grid .col-pnl,.ranking-table-grid .col-winrate,.ranking-table-grid .col-mdd{display:flex !important}}

/* SSR ranking table — simple flex rows (no grid columns)
   Each row: [Rank] [Avatar+Name (flex:1)] [Score] [ROI+PnL]
   Same layout on mobile and desktop — no hide-mobile needed. */
.ssr-t{background:var(--color-bg-secondary);border-radius:16px;border:1px solid var(--color-border-primary);overflow:hidden}
.ssr-row{display:flex;align-items:center;gap:12px;padding:10px 16px;text-decoration:none;color:inherit;border-bottom:1px solid var(--color-border-primary);min-height:52px}
.ssr-row:hover{background:var(--color-bg-hover,#252232)}
.ssr-row:focus-visible{outline:2px solid var(--color-brand);outline-offset:-2px;border-radius:4px}
.ssr-row:active{transform:scale(0.998)}
.ssr-row-gold{background:linear-gradient(135deg,rgba(255,215,0,0.10) 0%,rgba(255,215,0,0.03) 40%,transparent 80%);box-shadow:inset 3px 0 0 var(--color-rank-gold,#FFD700)}
.ssr-row-silver{background:linear-gradient(135deg,rgba(192,192,192,0.08) 0%,rgba(192,192,192,0.02) 40%,transparent 80%);box-shadow:inset 3px 0 0 var(--color-rank-silver,#C0C0C0)}
.ssr-row-bronze{background:linear-gradient(135deg,rgba(205,127,50,0.08) 0%,rgba(205,127,50,0.02) 40%,transparent 80%);box-shadow:inset 3px 0 0 var(--color-rank-bronze,#CD7F32)}
.ssr-rank{font-size:13px;font-weight:800;text-align:center;display:flex;align-items:center;justify-content:center;min-width:36px}
.ssr-rank-default{color:var(--color-text-tertiary)}
.ssr-rank-circle{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--color-bg-primary,#0B0A10)}
.ssr-info{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.ssr-av{width:36px;height:36px;min-width:36px;aspect-ratio:1;border-radius:50%;background:linear-gradient(135deg,var(--color-accent-primary-30),var(--color-pro-gold-border,#a78bfa));display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--color-on-accent,#fff);overflow:hidden;position:relative;contain:layout style paint}
.ssr-av img{width:100%;height:100%;object-fit:cover;border-radius:50%;position:absolute;inset:0}
.ssr-name{font-size:13px;font-weight:600;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssr-src{font-size:11px;color:var(--color-text-tertiary);text-transform:capitalize}
.ssr-score{text-align:right;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.ssr-score-s{color:var(--color-accent-success,#22c55e)}.ssr-score-a{color:var(--color-score-a,#4ade80)}.ssr-score-b{color:var(--color-accent-primary,#a78bfa)}.ssr-score-c{color:var(--color-text-secondary,#94a3b8)}.ssr-score-d{color:var(--color-text-tertiary,#64748b)}
.ssr-roi{text-align:right;font-variant-numeric:tabular-nums}
.ssr-roi-val{font-size:13px;font-weight:600}
.ssr-roi-pos{color:var(--color-success)}.ssr-roi-neg{color:var(--color-danger)}
.ssr-pnl{font-size:10px;color:var(--color-text-tertiary)}
/* .ssr-wr and .ssr-mdd removed — table simplified to Rank+Trader+Score+ROI */
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
.ssr-loading-bar{position:absolute;top:0;left:0;right:0;height:2px;background:var(--color-accent-primary,#a78bfa);animation:ssr-loading 1s ease-in-out infinite}
@keyframes ssr-loading{0%{transform:scaleX(0);transform-origin:left}50%{transform:scaleX(1);transform-origin:left}50.1%{transform-origin:right}100%{transform:scaleX(0);transform-origin:right}}
[data-theme='light'] .ssr-t{box-shadow:0 1px 3px rgba(0,0,0,0.05)}

/* Global tabular-nums for all number displays — prevents CLS from digit width shifts */
td,th,.ranking-row,.ssr-row,.ssr-score,.ssr-roi-val,.ssr-wr,.ssr-mdd,.col-score,.col-pnl,.col-roi,.col-winrate,.col-mdd,.stat-value,.price-value,.pnl-value,.percentage-value,.rank-number,.roi-value,.metric-value,.number-display,[data-value]{font-variant-numeric:tabular-nums}

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
    // 生产环境：压缩后的 CSS
    return criticalCss.replace(/\s+/g, ' ').trim()
  }
  // 开发环境：保持可读性
  return criticalCss
}

/**
 * 预加载字体
 * 确保关键字体尽早加载
 */
export function getFontPreloadLinks(): Array<{ href: string; as: string; type: string; crossOrigin: string }> {
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
export function getResourceHints(): Array<{ rel: string; href: string; crossOrigin?: 'anonymous' | 'use-credentials' | '' }> {
  const hints: Array<{ rel: string; href: string; crossOrigin?: 'anonymous' | 'use-credentials' | '' }> = [
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
