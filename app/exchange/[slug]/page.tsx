import { redirect } from 'next/navigation'

export default async function ExchangeRedirect({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  redirect(`/rankings/${slug}`)
}
