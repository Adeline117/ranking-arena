/**
 * 关键 CSS 内联优化
 * 提取首屏渲染必需的 CSS 样式
 */

/**
 * 关键 CSS - 首屏必需样式
 * 包含：布局、字体、颜色、基础动画
 */
export const criticalCss = `
/* 基础重置和布局 */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%;tab-size:4}
body{margin:0;font-family:var(--font-inter),system-ui,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}

/* 关键布局样式 */
.top-nav{position:sticky;top:0;z-index:100;background:rgba(11,10,16,0.8);backdrop-filter:blur(12px);height:56px;border-bottom:1px solid rgba(255,255,255,0.1)}
main{min-height:100vh;background:var(--bg-primary,#0B0A10)}

/* 字体变量 */
:root{
  --font-inter:'Inter',system-ui,sans-serif;
  --font-noto-sans-sc:'Noto Sans SC','Inter',system-ui,sans-serif;
}

/* 深色主题颜色 */
[data-theme="dark"]{
  --bg-primary:#0B0A10;
  --bg-secondary:#14131B;
  --text-primary:#FFFFFF;
  --text-secondary:#B4B3BA;
  --accent-primary:#9575CD;
  --border-primary:rgba(255,255,255,0.1);
}

/* 浅色主题颜色 */
[data-theme="light"]{
  --bg-primary:#FFFFFF;
  --bg-secondary:#F5F5F5;
  --text-primary:#1A1A1A;
  --text-secondary:#666666;
  --accent-primary:#7C3AED;
  --border-primary:rgba(0,0,0,0.1);
}

/* 加载骨架屏动画 */
@keyframes shimmer{
  0%{background-position:-1000px 0}
  100%{background-position:1000px 0}
}
.skeleton{
  background:linear-gradient(90deg,rgba(255,255,255,0.05) 25%,rgba(255,255,255,0.1) 50%,rgba(255,255,255,0.05) 75%);
  background-size:1000px 100%;
  animation:shimmer 2s infinite linear;
}

/* 隐藏类 */
.hide-mobile{display:flex}
.show-mobile-flex{display:none}
@media(max-width:768px){
  .hide-mobile{display:none}
  .show-mobile-flex{display:flex}
}

/* 防止布局偏移 */
img{display:block;max-width:100%}
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
 */
export function getResourceHints(): Array<{ rel: string; href: string; crossOrigin?: 'anonymous' | 'use-credentials' | '' }> {
  return [
    { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
    { rel: 'dns-prefetch', href: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://supabase.co' },
  ]
}
