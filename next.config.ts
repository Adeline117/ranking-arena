import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Bundle Analyzer 条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const withBundleAnalyzer = process.env.ANALYZE === 'true'
  ? require('@next/bundle-analyzer')({ enabled: true })
  : (config: NextConfig) => config;
/* eslint-enable @typescript-eslint/no-require-imports */

const nextConfig: NextConfig = {
  /* config options here */
  
  // Webpack 配置 - 处理服务端专用模块在客户端的导入
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // 为客户端构建提供空的模拟模块
      config.resolve.fallback = {
        ...config.resolve.fallback,
        dns: false,
        'dns/promises': false,
        net: false,
        tls: false,
        fs: false,
      }
    }
    return config
  },
  
  // 性能优化
  compress: true,
  
  // 图片优化 - CDN 优化配置
  images: {
    // 优先使用 AVIF（更小），回退到 WebP
    formats: ['image/avif', 'image/webp'],

    // 本地 API 路由图片（允许任意 query string）
    // 注意：省略 search 属性以允许任何查询字符串
    localPatterns: [
      {
        pathname: '/api/avatar',
        // search 省略以允许 ?url=* 等查询参数
      },
    ],

    // 远程图片域名白名单
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
      {
        protocol: 'https',
        hostname: 'assets.coingecko.com',
      },
      {
        protocol: 'https',
        hostname: 'api.dicebear.com',
      },
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      // Binance 头像 CDN
      {
        protocol: 'https',
        hostname: '**.bnbstatic.com',
      },
      {
        protocol: 'https',
        hostname: '**.tylhh.net',
      },
      {
        protocol: 'https',
        hostname: '**.nftstatic.com',
      },
      {
        protocol: 'https',
        hostname: '**.bscdnweb.com',
      },
      {
        protocol: 'https',
        hostname: '**.myqcloud.com',
      },
      // Bitget 头像 CDN
      {
        protocol: 'https',
        hostname: '**.bgstatic.com',
      },
      // MEXC 头像 CDN
      {
        protocol: 'https',
        hostname: '**.mocortech.com',
      },
      // Bybit 头像 CDN
      {
        protocol: 'https',
        hostname: '**.bybit.com',
      },
      {
        protocol: 'https',
        hostname: '**.staticimg.com',
      },
      {
        protocol: 'https',
        hostname: '**.bycsi.com',
      },
      // OKX 头像 CDN
      {
        protocol: 'https',
        hostname: '**.okx.com',
      },
      {
        protocol: 'https',
        hostname: '**.okcoin.com',
      },
      // KuCoin 头像 CDN
      {
        protocol: 'https',
        hostname: '**.kucoin.com',
      },
      // Gate.io 头像 CDN
      {
        protocol: 'https',
        hostname: '**.gateimg.com',
      },
      {
        protocol: 'https',
        hostname: '**.gate.io',
      },
      // HTX 头像 CDN
      {
        protocol: 'https',
        hostname: '**.htx.com',
      },
      {
        protocol: 'https',
        hostname: '**.huobi.com',
      },
      // BingX 头像 CDN
      {
        protocol: 'https',
        hostname: '**.bingx.com',
      },
      // CoinEx 头像 CDN
      {
        protocol: 'https',
        hostname: '**.coinex.com',
      },
      // LBank 头像 CDN
      {
        protocol: 'https',
        hostname: '**.lbkrs.com',
      },
      // Other exchanges
      {
        protocol: 'https',
        hostname: '**.phemex.com',
      },
      {
        protocol: 'https',
        hostname: '**.bitmart.com',
      },
      {
        protocol: 'https',
        hostname: '**.xt.com',
      },
      {
        protocol: 'https',
        hostname: '**.pionex.com',
      },
      {
        protocol: 'https',
        hostname: '**.weex.com',
      },
      {
        protocol: 'https',
        hostname: '**.wexx.one',
      },
      {
        protocol: 'https',
        hostname: '**.blofin.com',
      },
    ],
    
    // 图片尺寸配置 - 对齐 Tailwind 响应式断点
    deviceSizes: [375, 640, 768, 1024, 1280, 1536, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    
    // 最小缓存时间（秒）- 图片缓存 1 小时
    minimumCacheTTL: 3600,
    
    // 允许 dangerouslyAllowSVG（用于 dicebear 头像）
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  
  // 服务端专用包（不打包到客户端）
  // 注意：@upstash/redis 使用 REST API，不需要在此配置
  serverExternalPackages: [],
  
  // 实验性功能
  experimental: {
    // Tree-shaking optimization for large packages
    optimizePackageImports: [
      '@supabase/supabase-js',
      '@upstash/redis',
      '@upstash/ratelimit',
      'lodash',
      'date-fns',
      'lucide-react',
      '@sentry/nextjs',
      'zod',
      'zustand',
      'swr',
      'isomorphic-dompurify',
      'html2canvas',
      'react-easy-crop',
      'otpauth',
      'lightweight-charts',
    ],

    // Enable optimized CSS loading
    optimizeCss: true,

    // Optimize font loading
    optimizeServerReact: true,
  },
  
  // 生产环境不生成 source maps（减少构建大小）
  productionBrowserSourceMaps: false,
  
  // API 版本控制 - 将 /api/v1/* 重写到 /api/*
  // 这样可以保持向后兼容，同时支持版本化的 API 端点
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: '/api/:path*',
      },
    ];
  },
  
  // 响应头配置 - 缓存优化 + 安全头
  async headers() {
    // Content Security Policy - 允许必要的第三方服务
    const cspDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self' https://*.supabase.co https://*.stripe.com https://*.sentry.io wss://*.supabase.co https://api.coingecko.com",
      "frame-src 'self' https://js.stripe.com https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join('; ');

    // Permissions Policy - 限制浏览器功能访问
    const permissionsPolicy = [
      'camera=(self)',
      'microphone=()',
      'geolocation=()',
      'interest-cohort=()',
      'payment=(self)',
      'usb=()',
      'bluetooth=()',
    ].join(', ');

    return [
      {
        // 全局安全头
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Permissions-Policy',
            value: permissionsPolicy,
          },
          {
            key: 'Content-Security-Policy',
            value: cspDirectives,
          },
        ],
      },
      {
        // 静态资源缓存 1 年
        source: '/:all*(svg|jpg|jpeg|png|gif|ico|webp|avif|woff|woff2)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // Apple App Site Association - serve with correct content type
        source: '/.well-known/apple-app-site-association',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/json',
          },
        ],
      },
      {
        // API 响应添加版本头
        source: '/api/:path*',
        headers: [
          {
            key: 'X-API-Version',
            value: 'v1',
          },
        ],
      },
    ];
  },
  
  // Next.js 16 默认启用 SWC 压缩，无需配置
};

// Sentry 配置选项
// 注意：Next.js 16 + Sentry 已移除弃用的 disableLogger 和 automaticVercelMonitors
const sentryWebpackPluginOptions = {
  // 组织和项目名称（从环境变量获取）
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  
  // Auth token 用于上传 source maps 和创建 release
  authToken: process.env.SENTRY_AUTH_TOKEN,
  
  // 只在生产环境上传 source maps
  silent: !process.env.CI,
  
  // 上传 source maps 到 Sentry
  widenClientFileUpload: true,
  
  // 隐藏 source maps 不暴露给客户端
  hideSourceMaps: true,
  
  // 跳过没有 DSN 配置时的上传
  sourcemaps: {
    disable: !process.env.SENTRY_DSN,
  },
  
  // Webpack 相关配置（替代弃用的顶级选项）
  bundleSizeOptimizations: {
    // 移除 debug 日志（替代 disableLogger）
    excludeDebugStatements: true,
  },
  
  // 关闭遥测（可选）
  telemetry: false,
};

// 导出配置（包装 Bundle Analyzer + Sentry）
export default withBundleAnalyzer(withSentryConfig(nextConfig, sentryWebpackPluginOptions));
