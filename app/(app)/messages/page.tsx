import { redirect } from 'next/navigation'
import { features } from '@/lib/features'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Messages',
  description: 'Your private messages on Arena.',
  robots: { index: false, follow: false },
}


export default function MessagesPage() {
  if (!features.social) redirect('/')
  redirect('/inbox')
}
