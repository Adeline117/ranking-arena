import { redirect } from 'next/navigation'

/** Group conversations live in the unified inbox; detail URLs remain stable. */
export default function ChannelsIndexPage() {
  redirect('/inbox?tab=messages&chat=group')
}
