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
.top-nav{position:sticky;top:0;z-index:100;background:var(--glass-bg,rgba(11,10,16,0.85));backdrop-filter:blur(12px);height:56px;border-bottom:1px solid var(--glass-border,rgba(255,255,255,0.08))}
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
@keyframes pageEnter{
  from{opacity:0;transform:translateY(8px)}
  to{opacity:1;transform:translateY(0)}
}
@keyframes spin{to{transform:rotate(360deg)}}

/* 骨架屏 */
.skeleton{
  background:linear-gradient(90deg,rgba(255,255,255,0.05) 25%,rgba(255,255,255,0.1) 50%,rgba(255,255,255,0.05) 75%);
  background-size:1000px 100%;
  animation:shimmer 2s infinite linear;
}

/* 基础动画类 */
.page-enter{animation:pageEnter 0.3s ease-out forwards}

/* GPU-加速的网格背景 */
.mesh-gradient-bg{position:fixed;inset:0;opacity:0.5;pointer-events:none;z-index:0;transform:translateZ(0);backface-visibility:hidden;contain:strict layout paint}

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
