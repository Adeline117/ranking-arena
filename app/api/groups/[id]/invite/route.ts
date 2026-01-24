import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const INVITE_SECRET = process.env.INVITE_SECRET || supabaseServiceKey.slice(0, 32)

type RouteContext = { params: Promise<{ id: string }> }

function generateInviteToken(groupId: string, expiresAt: number): string {
  const payload = `${groupId}:${expiresAt}`
  const signature = crypto
    .createHmac('sha256', INVITE_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 16)
  return Buffer.from(`${payload}:${signature}`).toString('base64url')
}

export function verifyInviteToken(token: string): { groupId: string; valid: boolean } {
  try {
    const decoded = Buffer.from(token, 'base64url').toString()
    const parts = decoded.split(':')
    if (parts.length !== 3) return { groupId: '', valid: false }

    const [groupId, expiresAtStr, signature] = parts
    const expiresAt = parseInt(expiresAtStr, 10)

    // Check expiry
    if (Date.now() > expiresAt) return { groupId, valid: false }

    // Verify signature
    const payload = `${groupId}:${expiresAtStr}`
    const expectedSig = crypto
      .createHmac('sha256', INVITE_SECRET)
      .update(payload)
      .digest('hex')
      .slice(0, 16)

    if (signature !== expectedSig) return { groupId, valid: false }

    return { groupId, valid: true }
  } catch {
    return { groupId: '', valid: false }
  }
}

// GET: Verify invite token
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id: groupId } = await context.params
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('verify')

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 })
    }

    const result = verifyInviteToken(token)
    if (!result.valid || result.groupId !== groupId) {
      return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 400 })
    }

    return NextResponse.json({ success: true, valid: true })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// POST: Generate invite link
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id: groupId } = await context.params

    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: '身份验证失败' }, { status: 401 })
    }

    // Check requester is owner/admin
    const { data: membership } = await supabase
      .from('group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return NextResponse.json({ error: '无权限' }, { status: 403 })
    }

    // Generate 7-day invite token
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    const inviteToken = generateInviteToken(groupId, expiresAt)

    const inviteUrl = `/groups/${groupId}?invite=${inviteToken}`

    return NextResponse.json({
      success: true,
      invite_url: inviteUrl,
      expires_at: new Date(expiresAt).toISOString(),
    })
  } catch (error) {
    console.error('Generate invite error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
