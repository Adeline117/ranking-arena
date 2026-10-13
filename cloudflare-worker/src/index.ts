const RETIRED_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

const worker = {
  fetch(): Response {
    return new Response(
      JSON.stringify({
        error: 'LEGACY_PROXY_IMPORT_NOT_PUBLISHED',
        message:
          'Legacy proxy and import execution is temporarily unavailable during V1 verification.',
      }),
      { headers: RETIRED_HEADERS, status: 410 }
    )
  },
}

export default worker
