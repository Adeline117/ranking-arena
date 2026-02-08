import { NextResponse } from 'next/server'
import { fetchVolumes } from '@/lib/utils/defillama'

export async function GET() {
  try {
    const data = await fetchVolumes()
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=900',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch DEX volumes' },
      { status: 500 }
    )
  }
}
