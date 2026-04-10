import type { MetadataRoute } from "next"
import { BASE_URL } from '@/lib/constants/urls'

export default function robots(): MetadataRoute.Robots {
  const base = BASE_URL
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: [
          "/admin",
          "/api/",
          "/settings",
          "/inbox",
          "/messages",
          "/my-posts",
          "/logout",
          "/onboarding",
          "/offline",
          "/s/",
          "/favorites",
          "/following",
          "/portfolio",
          "/notifications",
          "/channels",
          "/user-center",
          "/exchange",
          "/auth",
          "/reset-password",
          "/kol",
          "/tip",
          "/pricing/success",
          "/governance",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  }
}


