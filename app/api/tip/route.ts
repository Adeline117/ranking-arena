import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const runtime = "nodejs"

function getAdminSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
  return createClient(url, service, { auth: { persistSession: false } })
}

export async function POST(req: Request) {
  try {
    const supabase = getAdminSupabase()
    const body = await req.json()

    const post_id = String(body.post_id || "")
    const amount_cents = Number(body.amount_cents ?? 100)

    if (!post_id) {
      return NextResponse.json({ ok: false, error: "missing post_id" }, { status: 400 })
    }

    // ✅ MVP：写 gifts（你确保 gifts 表至少有 post_id / amount_cents）
    const { error } = await supabase.from("gifts").insert({
      post_id,
      amount_cents,
    })

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "unknown" }, { status: 500 })
  }
}
