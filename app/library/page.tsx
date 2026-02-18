import { redirect } from 'next/navigation'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Library | Arena',
  description: 'Enter. Outperform. Browse trading books, papers, and whitepapers.',
}


export default function LibraryPage() {
  redirect('/rankings/resources')
}
