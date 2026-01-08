import type { MetadataRoute } from "next"

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"
  const now = new Date().toISOString()
  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/hot`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/groups`, lastModified: now, changeFrequency: "daily", priority: 0.7 },
  ]
}


