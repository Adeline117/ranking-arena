import { redirect } from 'next/navigation'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Messages | Arena',
  description: 'Your private messages on Arena.',
}


export default function MessagesPage() {
  redirect('/inbox')
}
