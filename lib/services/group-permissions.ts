import { SupabaseClient } from '@supabase/supabase-js'

export type GroupRole = 'owner' | 'admin' | 'member'

export async function getGroupRole(supabase: SupabaseClient, userId: string, groupId: string): Promise<GroupRole | null> {
  const { data } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()
  return data?.role || null
}

export function canManageMembers(role: GroupRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

export function canModerateContent(role: GroupRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

export function canEditSettings(role: GroupRole | null): boolean {
  return role === 'owner'
}

export function canKickRole(actorRole: GroupRole | null, targetRole: GroupRole | null): boolean {
  if (!canManageMembers(actorRole)) return false
  if (targetRole === 'owner') return false
  if (actorRole === 'admin' && targetRole === 'admin') return false
  return true
}
