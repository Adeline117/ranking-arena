import { redirect } from 'next/navigation'

// /rankings → / (homepage has the main ranking table)
// Legacy query params still redirect to exchange-specific pages
export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; ex?: string }>
}) {
  const params = await searchParams
  const exchange = params.platform || params.ex

  if (exchange) {
    redirect(`/rankings/${encodeURIComponent(exchange)}`)
  }

  redirect('/')
}
