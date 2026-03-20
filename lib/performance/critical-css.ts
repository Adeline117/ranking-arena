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

/* CSS Containment for rendering performance */
.trader-card-contained{contain:layout style paint}
.sidebar-contained{contain:layout style}

/* content-visibility:auto skips rendering of off-screen content until scrolled into view.
   Dramatically reduces initial rendering work (TBT) and improves Speed Index. */
.three-col-left,.three-col-right{content-visibility:auto;contain-intrinsic-size:auto 600px}

/* ============================================
   Ranking Table Grid — CRITICAL for CLS
   Without these, the grid renders with wrong columns
   until responsive.css loads async (causes 0.1+ CLS).
   ============================================ */
/* Mobile: Rank | Trader | ROI only */
.ranking-table-grid{grid-template-columns:36px 1fr 80px !important}
.ranking-table-grid .col-score,.ranking-table-grid .col-pnl,.ranking-table-grid .col-winrate,.ranking-table-grid .col-mdd{display:none !important}
@media(min-width:640px){.ranking-table-grid{grid-template-columns:40px 1fr 80px 60px 80px !important}.ranking-table-grid .col-score,.ranking-table-grid .col-pnl{display:flex !important}}
@media(min-width:768px){.ranking-table-grid{grid-template-columns:44px minmax(140px,1.5fr) 80px 80px 70px 70px 64px !important}.ranking-table-grid .col-score,.ranking-table-grid .col-pnl,.ranking-table-grid .col-winrate,.ranking-table-grid .col-mdd{display:flex !important}}

/* SSR ranking table — inline compact layout to prevent CLS before Phase 2 */
.ssr-t{display:flex;flex-direction:column;gap:0}
.ssr-hdr{display:grid;grid-template-columns:36px 1fr 50px 70px;gap:8px;padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-tertiary,#6B6B7B);border-bottom:1px solid var(--border-primary,#2A2836)}
.ssr-row{display:grid;grid-template-columns:36px 1fr 50px 70px;gap:8px;padding:8px 12px;align-items:center;text-decoration:none;color:inherit;border-bottom:1px solid var(--border-primary,rgba(42,40,54,0.5));min-height:52px;contain:layout style}
.ssr-r{text-align:right}
.ssr-rank{text-align:center;font-weight:700;font-size:13px;color:var(--text-secondary)}
.ssr-info{display:flex;align-items:center;gap:8px;min-width:0}
.ssr-av{width:36px;height:36px;border-radius:50%;overflow:hidden;flex-shrink:0;position:relative;display:flex;align-items:center;justify-content:center;background:var(--bg-tertiary,#1C1926);font-weight:700;font-size:14px;color:var(--text-tertiary)}
.ssr-name{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary)}
.ssr-src{font-size:11px;color:var(--text-tertiary);text-transform:capitalize}
.ssr-score{font-weight:800;font-size:14px;text-align:center;font-variant-numeric:tabular-nums}
.ssr-roi-val{font-weight:700;font-size:13px;text-align:right;font-variant-numeric:tabular-nums}
.ssr-roi-pos{color:var(--color-success,#2fe57d)}
.ssr-roi-neg{color:var(--color-error,#ff7c7c)}
.ssr-pnl{font-size:11px;color:var(--text-tertiary);text-align:right}
.ssr-wr,.ssr-mdd{font-size:12px;color:var(--text-secondary);text-align:right;font-variant-numeric:tabular-nums}
.ssr-score-s{color:#2fe57d}
.ssr-score-a{color:#7dd87d}
.ssr-score-b{color:#d4c952}
.ssr-score-c{color:#e8a83e}
.ssr-score-d{color:#ff7c7c}
.ssr-rank-circle{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;color:#000;font-weight:900;font-size:12px}
.ssr-rank-default{color:var(--text-tertiary)}
.ssr-row-gold{background:linear-gradient(90deg,rgba(255,215,0,0.06) 0%,transparent 60%)}
.ssr-row-silver{background:linear-gradient(90deg,rgba(192,192,192,0.05) 0%,transparent 60%)}
.ssr-row-bronze{background:linear-gradient(90deg,rgba(205,127,50,0.04) 0%,transparent 60%)}

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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://supabase.co'

  const hints: Array<{ rel: string; href: string; crossOrigin?: 'anonymous' | 'use-credentials' | '' }> = [
    // Google Fonts preconnect not needed — next/font inlines font CSS and self-hosts woff2 files.
    // Supabase -- API calls on every page (rankings, auth, etc.)
    { rel: 'preconnect', href: supabaseUrl, crossOrigin: 'anonymous' },
    // CDN -- images, assets (critical for LCP — trader avatars)
    { rel: 'preconnect', href: 'https://cdn.arenafi.org', crossOrigin: 'anonymous' },
    // Removed non-critical hints to reduce connection overhead on slow networks:
    // - dns-prefetch duplicates of preconnect origins (browser already resolves them)
    // - Exchange avatar CDNs (bin.bnbstatic.com, static.bitget.com, okx.com) — loaded lazily
    // - DiceBear (api.dicebear.com) — fallback only, rarely used
    // - CoinGecko (api.coingecko.com) — fetched server-side via API routes
    // - Sentry (ingest.us.sentry.io) — deferred, non-critical for page load
    // - Upstash (server-side only, browser never connects)
  ]

  return hints
}
