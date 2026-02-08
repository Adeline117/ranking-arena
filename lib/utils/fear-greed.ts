/**
 * Fear & Greed Index fetcher with in-memory caching
 * Source: https://alternative.me/crypto/fear-and-greed-index/
 */

export interface FearGreedData {
  value: number
  value_classification: string
  timestamp: string
}

interface FearGreedResponse {
  data: Array<{
    value: string
    value_classification: string
    timestamp: string
  }>
}

let cache: { data: FearGreedData[]; fetchedAt: number } | null = null
const CACHE_TTL = 60 * 60 * 1000 // 1 hour

export async function fetchFearGreedIndex(limit = 30): Promise<FearGreedData[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache.data
  }

  const res = await fetch(`https://api.alternative.me/fng/?limit=${limit}`, {
    next: { revalidate: 3600 },
  })

  if (!res.ok) {
    throw new Error(`Fear & Greed API error: ${res.status}`)
  }

  const json: FearGreedResponse = await res.json()

  const data: FearGreedData[] = json.data.map((d) => ({
    value: Number(d.value),
    value_classification: d.value_classification,
    timestamp: d.timestamp,
  }))

  cache = { data, fetchedAt: Date.now() }
  return data
}
