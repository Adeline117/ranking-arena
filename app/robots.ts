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
          "/dashboard",
          "/logout",
          "/onboarding",
          "/offline",
          "/s/",  // Snapshot tokens - private
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  }
}


