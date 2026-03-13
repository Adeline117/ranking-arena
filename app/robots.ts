import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"
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
          "/multi-chain",
          "/frame/",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  }
}


