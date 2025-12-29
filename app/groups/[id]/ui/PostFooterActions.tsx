"use client"

type Post = {
  id: string
  author_handle?: string | null
  like_count?: number | null
  comment_count?: number | null
}

export default function PostFooterActions({ post }: { post: Post }) {
  return (
    <div className="mt-3 flex items-center gap-4 text-xs opacity-70">
      <span>@{post.author_handle ?? "anonymous"}</span>
      <span>❤️ {post.like_count ?? 0}</span>
      <span>💬 {post.comment_count ?? 0}</span>

      <button
        className="ml-auto rounded-md border border-white/10 bg-white/5 px-2 py-1 hover:bg-white/10"
        onClick={async () => {
          const res = await fetch("/api/tip", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              post_id: post.id,
              amount_cents: 100,
            }),
          })
          const json = await res.json()
          if (!json.ok) return alert(json.error || "tip failed")
          alert("Tip 成功 ✅")
        }}
      >
        Tip $1
      </button>
    </div>
  )
}
