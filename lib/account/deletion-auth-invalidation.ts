import 'server-only'

interface AccountDeletionAuthAdmin {
  updateUserById: (
    userId: string,
    attributes: { ban_duration: string }
  ) => Promise<{ error: { message: string } | null }>
}

// Hard deletion can be deferred beyond the advertised 30-day grace period by
// billing settlement or an operational outage. Keep Auth closed until either
// recovery explicitly sends `ban_duration: 'none'` or hard deletion removes
// the subject; 100 years is within Go's duration range and acts as reversible
// application-lifetime suspension rather than a deadline-sized lease.
export const ACCOUNT_DELETION_AUTH_BAN_DURATION = '876000h'

export async function enforceAccountDeletionAuthBan(
  authAdmin: AccountDeletionAuthAdmin,
  userId: string
): Promise<void> {
  let result: Awaited<ReturnType<AccountDeletionAuthAdmin['updateUserById']>>
  try {
    result = await authAdmin.updateUserById(userId, {
      ban_duration: ACCOUNT_DELETION_AUTH_BAN_DURATION,
    })
  } catch (error) {
    throw new Error(
      `Account deletion Auth ban threw: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }

  if (result.error) {
    throw new Error(`Account deletion Auth ban failed: ${result.error.message}`)
  }
}
