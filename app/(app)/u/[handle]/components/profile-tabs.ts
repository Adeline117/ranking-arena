import type { ProfileTabKey } from './types'

const USER_PROFILE_TABS = ['overview'] as const satisfies readonly ProfileTabKey[]
const TRADER_PROFILE_TABS = [
  'overview',
  'stats',
  'portfolio',
] as const satisfies readonly ProfileTabKey[]
const TRADER_PROFILE_TABS_WITH_POSTS = [
  ...TRADER_PROFILE_TABS,
  'posts',
] as const satisfies readonly ProfileTabKey[]

export function getAvailableProfileTabs(input: {
  hasTraderBinding: boolean
  hasPostsContent: boolean
}): readonly ProfileTabKey[] {
  if (!input.hasTraderBinding) return USER_PROFILE_TABS
  return input.hasPostsContent ? TRADER_PROFILE_TABS_WITH_POSTS : TRADER_PROFILE_TABS
}

export function canonicalProfileTab(
  value: string | null,
  availableTabs: readonly ProfileTabKey[]
): ProfileTabKey {
  return value !== null && availableTabs.some((tab) => tab === value)
    ? (value as ProfileTabKey)
    : 'overview'
}

export function profileTabIsAvailable(
  value: ProfileTabKey,
  availableTabs: readonly ProfileTabKey[]
): boolean {
  return availableTabs.includes(value)
}
