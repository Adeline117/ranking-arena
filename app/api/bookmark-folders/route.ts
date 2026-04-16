/**
 * 收藏夹 API
 * GET /api/bookmark-folders - 获取用户的收藏夹列表
 * POST /api/bookmark-folders - 创建新收藏夹
 */

import { withAuth } from '@/lib/api/middleware'
import { badRequest, success, handleError } from '@/lib/api/response'
import { validateString, validateBoolean } from '@/lib/api/validation'

export const GET = withAuth(
  async ({ user, supabase }) => {
    try {
      // 尝试确保用户有默认收藏夹（如果表存在）
      try {
        await supabase.rpc('ensure_default_bookmark_folder', { p_user_id: user.id })
      } catch {
        // Intentionally swallowed: RPC function may not be deployed yet, folder creation continues without it
      }

      // 获取用户的所有收藏夹
      const { data: folders, error } = await supabase
        .from('bookmark_folders')
        .select('id, name, description, avatar_url, is_public, is_default, created_at')
        .eq('user_id', user.id)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true })

      if (error) {
        // 如果表不存在，返回空列表
        const ignoredCodes = ['42P01', 'PGRST116', 'PGRST204']
        if (ignoredCodes.includes(error.code || '')) {
          return success({ folders: [] })
        }
        throw error
      }

      return success({ folders: folders || [] })
    } catch (error: unknown) {
      return handleError(error, 'bookmark-folders GET')
    }
  },
  { name: 'bookmark-folders-list', rateLimit: 'read' }
)

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    try {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return badRequest('Invalid JSON body')
      }

      const name = validateString(body.name, {
        required: true,
        minLength: 1,
        maxLength: 50,
        fieldName: 'folder name',
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
          throw new Error('A folder with this name already exists')
        }
        throw error
      }

      return success({ folder }, 201)
    } catch (error: unknown) {
      return handleError(error, 'bookmark-folders POST')
    }
  },
  { name: 'bookmark-folders-create', rateLimit: 'write' }
)
