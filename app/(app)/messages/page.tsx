import { redirect } from 'next/navigation'
import { features } from '@/lib/features'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Messages',
  description: 'Your private messages on Arena.',
}


export default function MessagesPage() {
  if (!features.social) redirect('/')
  redirect('/inbox')
}
