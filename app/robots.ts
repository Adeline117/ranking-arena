import type { MetadataRoute } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export default function robots(): MetadataRoute.Robots {
  const base = BASE_URL
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
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
          '/exchange',
          '/auth',
          '/reset-password',
          '/tip',
          '/pricing/success',
          '/governance',
        ],
      },
    ],
    sitemap: [
      `${base}/sitemap/0.xml`,
      `${base}/sitemap/1.xml`,
      `${base}/sitemap/2.xml`,
      `${base}/sitemap/3.xml`,
      `${base}/sitemap/4.xml`,
      `${base}/sitemap/5.xml`,
      `${base}/sitemap/6.xml`,
      `${base}/sitemap/7.xml`,
      `${base}/sitemap/999.xml`,
    ],
  }
}
