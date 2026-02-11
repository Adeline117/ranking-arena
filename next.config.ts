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
  
  // Turbopack 配置 (Next.js 16 默认) - 处理服务端专用模块在客户端的导入
  turbopack: {
    resolveAlias: {
      // 客户端不需要的 Node.js 模块
      dns: { browser: './lib/stubs/empty.js' },
      'dns/promises': { browser: './lib/stubs/empty.js' },
      net: { browser: './lib/stubs/empty.js' },
      tls: { browser: './lib/stubs/empty.js' },
      fs: { browser: './lib/stubs/empty.js' },
      // Ignore optional wagmi/web3 peer dependencies we don't use
      '@react-native-async-storage/async-storage': './lib/stubs/empty.js',
      '@gemini-wallet/core': './lib/stubs/empty.js',
      'porto': './lib/stubs/empty.js',
      'porto/internal': './lib/stubs/empty.js',
    },
  },

  // Webpack fallback (for analyze mode / explicit --webpack builds)
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        dns: false,
        'dns/promises': false,
        net: false,
        tls: false,
        fs: false,
      }
    }
    config.plugins.push(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      new (require('webpack').IgnorePlugin)({
        resourceRegExp: /^(@react-native-async-storage\/async-storage|@gemini-wallet\/core|porto|porto\/internal)$/,
      })
    )
    return config
  },
  
  // TypeScript — 暂时跳过 build 时类型检查（CI 单独跑 tsc）
  typescript: {
    ignoreBuildErrors: true,
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
      {
        pathname: '/api/avatar/**',
      },
    ],

    // 远程图片域名白名单
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.arenafi.org',
      },
      {
        protocol: 'https',
        hostname: 'books.google.com',
      },
      {
        protocol: 'https',
        hostname: 'covers.openlibrary.org',
      },
      {
        protocol: 'https',
        hostname: '**.googleusercontent.com',
      },
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
        hostname: 's2.coinmarketcap.com',
      },
      {
        protocol: 'https',
        hostname: 'coin-images.coingecko.com',
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
      {
        protocol: 'https',
        hostname: '**.hbfile.net',
      },
      {
        protocol: 'https',
        hostname: '**.cloudfront.net',
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
      // BingX bb-os CDN
      {
        protocol: 'https',
        hostname: '**.bb-os.com',
      },
      // GMX
      {
        protocol: 'https',
        hostname: 'gmx.io',
      },
      // BTCC
      {
        protocol: 'https',
        hostname: '**.btuserlog.com',
      },
      // Bitfinex
      {
        protocol: 'https',
        hostname: '**.bitfinex.com',
      },
      // BTSE
      {
        protocol: 'https',
        hostname: '**.btse.com',
      },
      // dYdX
      {
        protocol: 'https',
        hostname: '**.dydx.exchange',
      },
      // Jupiter
      {
        protocol: 'https',
        hostname: '**.jup.ag',
      },
      // WhiteBit
      {
        protocol: 'https',
        hostname: '**.whitebit.com',
      },
      // Toobit
      {
        protocol: 'https',
        hostname: '**.toobit.com',
      },
      // Aevo
      {
        protocol: 'https',
        hostname: '**.aevo.xyz',
      },
      // Hyperliquid
      {
        protocol: 'https',
        hostname: '**.hyperliquid.xyz',
      },
      // UI Avatars fallback
      {
        protocol: 'https',
        hostname: 'ui-avatars.com',
      },
    ],
    
    // 图片尺寸配置 - 对齐 Tailwind 响应式断点
    deviceSizes: [375, 640, 768, 1024, 1280, 1536, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    
    // 最小缓存时间（秒）- 图片缓存 24 小时（头像/logo 变更不频繁）
    minimumCacheTTL: 86400,
    
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  
  // 服务端专用包（不打包到客户端）
  // 注意：@upstash/redis 使用 REST API，不需要在此配置
  serverExternalPackages: ['ccxt', 'puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth', 'pg', 'redis'],
  
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
      '@tanstack/react-query',
      'framer-motion',
      'ethers',
      'viem',
      '@rainbow-me/rainbowkit',
      'wagmi',
      'stripe',
      '@coinbase/wallet-sdk',
      '@metamask/sdk',
      'epubjs',
    ],

    // Enable optimized CSS loading
    optimizeCss: true,

    // Partial Prerendering — static shell + streaming dynamic parts
    ppr: 'incremental',

    // Optimize font loading
    optimizeServerReact: true,

    // Client-side router cache — keep prefetched pages fresh longer
    // Reduces redundant server requests on back/forward navigation
    staleTimes: {
      dynamic: 120,  // Cache dynamic pages for 2min on client (SWR handles freshness)
      static: 600,   // Cache static pages for 10min on client
    },
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
      `script-src 'self' 'unsafe-inline' ${process.env.NODE_ENV === 'development' ? "'unsafe-eval'" : ''} https://js.stripe.com https://challenges.cloudflare.com`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self' https://*.supabase.co https://*.stripe.com https://*.sentry.io https://*.ingest.us.sentry.io wss://*.supabase.co https://api.coingecko.com",
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

// 导出配置（Sentry + Bundle Analyzer）
export default withSentryConfig(withBundleAnalyzer(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  widenClientFileUpload: true,
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
    automaticVercelMonitors: true,
  },
});
