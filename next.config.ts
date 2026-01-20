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
        hostname: 'api.dicebear.com', // 用于生成头像
      },
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
    ],
    
    // 图片尺寸配置 - 响应式断点
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048],
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
    optimizePackageImports: ['@supabase/supabase-js', '@upstash/redis', '@upstash/ratelimit', 'lodash', 'date-fns'],
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
  
  // 响应头配置 - 缓存优化
  async headers() {
    return [
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
        // API 响应添加安全头（包括 v1 版本）
        source: '/api/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
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
