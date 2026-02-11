import { NextRequest, NextResponse } from 'next/server'

/**
 * Proxy for R2 CDN files to handle CORS for pdf.js
 * Usage: /api/cdn-proxy?url=https://cdn.arenafi.org/papers/xxx.pdf
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url')
  if (!url || !url.startsWith('https://cdn.arenafi.org/')) {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      return NextResponse.json({ error: `Upstream ${resp.status}` }, { status: resp.status })
    }

    const buffer = await resp.arrayBuffer()
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/pdf',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Fetch failed' }, { status: 502 })
  }
}
