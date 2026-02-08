import { NextResponse } from 'next/server'
import { fetchFearGreedIndex } from '@/lib/utils/fear-greed'

export async function GET() {
  try {
    const data = await fetchFearGreedIndex(30)
    return NextResponse.json(
      { current: data[0], history: data },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800',
        },
      }
    )
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Fear & Greed Index' },
      { status: 500 }
    )
  }
}
