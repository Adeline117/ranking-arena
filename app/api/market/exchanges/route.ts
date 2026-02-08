import { NextResponse } from 'next/server'
import { fetchExchangeVolumes } from '@/lib/utils/coingecko'

export async function GET() {
  try {
    const data = await fetchExchangeVolumes()
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=900',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch exchange volumes' },
      { status: 500 }
    )
  }
}
