// app/groups/[id]/page.tsx
import Link from "next/link"
import { createClient } from "@supabase/supabase-js"
import GroupActions from "./ui/GroupActions"
import PostFooterActions from "./ui/PostFooterActions"

type Group = {
  id: string
  name: string
  subtitle?: string | null
}

type Post = {
  id: string
  group_id: string
  title: string
  content?: string | null
  created_at: string
  author_handle?: string | null
  like_count?: number | null
  comment_count?: number | null
}

function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY")
  return createClient(url, anon, { auth: { persistSession: false } })
}

export default async function GroupDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const groupId = params.id
  const supabase = getServerSupabase()

  // 1) 读 group
  const { data: group, error: groupErr } = await supabase
    .from("groups")
    .select("id,name,subtitle")
    .eq("id", groupId)
    .single()

  if (groupErr) {
    return (
      <div className="p-6">
        <div className="text-red-500">Failed to load group: {groupErr.message}</div>
      </div>
    )
  }

  // 2) 读 posts
  const { data: posts, error: postsErr } = await supabase
    .from("posts")
    .select("id,group_id,title,content,created_at,author_handle,like_count,comment_count")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })

  if (postsErr) {
    return (
      <div className="p-6">
        <div className="text-red-500">Failed to load posts: {postsErr.message}</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold">{group?.name}</div>
          {group?.subtitle ? (
            <div className="text-sm opacity-70 mt-1">{group.subtitle}</div>
          ) : null}
        </div>

        <Link href="/groups" className="text-sm underline opacity-80 hover:opacity-100">
          Back to Groups
        </Link>
      </div>

      {/* ✅ 插入点 1：Posts 上方（你要的 Group Actions） */}
      <GroupActions groupId={groupId} />

      {/* Posts */}
      <div className="space-y-3">
        <div className="text-lg font-semibold">Posts</div>

        {(!posts || posts.length === 0) && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm opacity-75">
            No posts yet.
          </div>
        )}

        {posts?.map((post: Post) => (
          <div key={post.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium">{post.title}</div>
              <div className="text-xs opacity-60">
                {new Date(post.created_at).toLocaleString()}
              </div>
            </div>

            {post.content ? (
              <div className="mt-2 text-sm opacity-80 whitespace-pre-wrap">
                {post.content}
              </div>
            ) : null}

            {/* ✅ 插入点 2：posts 卡片底部追加（Tip / 互动） */}
            <PostFooterActions post={post} />
          </div>
        ))}
      </div>
    </div>
  )
}
