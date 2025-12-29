"use client"

import { useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { createClient } from "@supabase/supabase-js"

function getBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY")
  return createClient(url, anon)
}

export default function NewPostPage() {
  const params = useParams<{ id: string }>()
  const groupId = params.id
  const router = useRouter()

  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [loading, setLoading] = useState(false)

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-xl space-y-4">
        <div className="text-2xl font-semibold">New Post</div>
        <div className="text-sm opacity-70">Group {groupId}</div>

        <input
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <textarea
          className="w-full min-h-[220px] rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none"
          placeholder="Write..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />

        <button
          disabled={loading}
          className="w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm hover:bg-white/15 disabled:opacity-50"
          onClick={async () => {
            setLoading(true)
            try {
              const supabase = getBrowserSupabase()
              const { error } = await supabase.from("posts").insert({
                group_id: groupId,
                title,
                content,
              })
              if (error) return alert(error.message)
              router.push(`/groups/${groupId}`)
            } finally {
              setLoading(false)
            }
          }}
        >
          {loading ? "Posting..." : "Publish"}
        </button>
      </div>
    </div>
  )
}
