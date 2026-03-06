export interface SessionInfo {
  id: string
  deviceInfo: { browser?: string; os?: string } | null
  ipAddress: string | null
  lastActiveAt: string | null
  isCurrent: boolean
}

export interface BlockedUserInfo {
  blockedId: string
  handle: string | null
  avatarUrl: string | null
  createdAt: string
}

export interface InitialValues {
  handle: string
  bio: string
  avatarUrl: string | null
  coverUrl: string | null
  notifyFollow: boolean
  notifyLike: boolean
  notifyComment: boolean
  notifyMention: boolean
  notifyMessage: boolean
  showFollowers: boolean
  showFollowing: boolean
  dmPermission: string
  showProBadge: boolean
}

export interface TouchedFields {
  handle: boolean
  newPassword: boolean
  confirmPassword: boolean
  newEmail: boolean
}
