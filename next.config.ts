import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  
  // 性能优化
  compress: true,
  
  // 图片优化
  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
    ],
  },
  
  // 实验性功能
  experimental: {
    optimizePackageImports: ['@supabase/supabase-js'],
  },
  
  // 生产环境优化
  ...(process.env.NODE_ENV === 'production' && {
    swcMinify: true,
  }),
};

export default nextConfig;
