export interface ProvisionedLoginProfile {
  handle: string | null
  avatar_url?: string | null
}

export function requireProvisionedProfile<T extends ProvisionedLoginProfile>(
  profile: T | null,
  error: unknown
): T {
  if (error) {
    throw error instanceof Error ? error : new Error('Failed to load the provisioned profile.')
  }
  if (!profile) {
    throw new Error('Profile provisioning is incomplete. Please retry.')
  }
  return profile
}
