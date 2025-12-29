"use client"

import Link from "next/link"

export default function GroupActions({ groupId }: { groupId: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="text-sm opacity-80">Group Actions</div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href={`/groups/${groupId}/new`}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
        >
          + New Post
        </Link>

        <button
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
          onClick={() => alert("下一关：申请入组（做题/小作文）")}
        >
          Apply to Join
        </button>

        <button
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
          onClick={() => alert("下一关：组规/举报")}
        >
          Report / Rules
        </button>
      </div>
    </div>
  )
}
