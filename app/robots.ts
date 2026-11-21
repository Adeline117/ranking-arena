import type { MetadataRoute } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export default function robots(): MetadataRoute.Robots {
  const base = BASE_URL
  return {
    rules: [
      {
        userAgent: '*',
        // /api/og 是各页面 og:image 的分享图，屏蔽后谷歌和社交平台都取不到缩略图。
        allow: ['/', '/api/sitemap-xml', '/api/og'],
        disallow: [
          '/admin',
          '/api/',
          '/settings',
          '/inbox',
          '/messages',
          '/my-posts',
          '/logout',
          '/onboarding',
          '/offline',
          '/s/',
          '/favorites',
          '/following',
          '/portfolio',
          '/notifications',
          '/channels',
          '/user-center',
          '/exchange/auth',
          '/auth',
          '/reset-password',
          '/tip',
          '/pricing/success',
          '/governance',
        ],
      },
    ],
    sitemap: `${base}/api/sitemap-xml`,
  }
}
