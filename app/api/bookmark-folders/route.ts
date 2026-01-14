/**
 * 收藏夹 API
 * GET /api/bookmark-folders - 获取用户的收藏夹列表
 * POST /api/bookmark-folders - 创建新收藏夹
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  validateBoolean,
} from '@/lib/api'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 确保用户有默认收藏夹
    await supabase.rpc('ensure_default_bookmark_folder', { p_user_id: user.id })

    // 获取用户的所有收藏夹
    const { data: folders, error } = await supabase
      .from('bookmark_folders')
      .select('*')
      .eq('user_id', user.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true })

    if (error) throw error

    return success({ folders: folders || [] })
  } catch (error) {
    return handleError(error, 'bookmark-folders GET')
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const name = validateString(body.name, {
      required: true,
      minLength: 1,
      maxLength: 50,
      fieldName: '收藏夹名称',
    })!
    const description = validateString(body.description, { maxLength: 200 })
    const avatar_url = validateString(body.avatar_url, { maxLength: 500 })
    const is_public = validateBoolean(body.is_public) ?? false

    // 创建收藏夹
    const { data: folder, error } = await supabase
      .from('bookmark_folders')
      .insert({
        user_id: user.id,
        name,
        description,
        avatar_url,
        is_public,
        is_default: false,
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        throw new Error('已存在同名收藏夹')
      }
      throw error
    }

    return success({ folder }, 201)
  } catch (error) {
    return handleError(error, 'bookmark-folders POST')
  }
}

