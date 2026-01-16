import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  /* config options here */
  
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
  
  // 实验性功能
  experimental: {
    optimizePackageImports: ['@supabase/supabase-js', '@upstash/redis', '@upstash/ratelimit', 'lodash', 'date-fns'],
    instrumentationHook: true,
  },
  
  // 生产环境不生成 source maps（减少构建大小）
  productionBrowserSourceMaps: false,
  
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
        // API 响应添加安全头
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
        ],
      },
    ];
  },
  
  // Next.js 16 默认启用 SWC 压缩，无需配置
};

// Sentry 配置选项
const sentryWebpackPluginOptions = {
  // 组织和项目名称（从环境变量获取）
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  
  // 只在生产环境上传 source maps
  silent: !process.env.CI,
  
  // 上传 source maps 到 Sentry
  widenClientFileUpload: true,
  
  // 自动检测 release
  automaticVercelMonitors: true,
  
  // 隐藏 source maps 不暴露给客户端
  hideSourceMaps: true,
  
  // 禁用日志（减少噪音）
  disableLogger: true,
  
  // 跳过没有 DSN 配置时的上传
  sourcemaps: {
    disable: !process.env.SENTRY_DSN,
  },
};

// 导出配置（包装 Sentry）
export default withSentryConfig(nextConfig, sentryWebpackPluginOptions);
