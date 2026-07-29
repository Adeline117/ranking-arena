import 'server-only'

interface AccountDeletionAuthAdmin {
  updateUserById: (
    userId: string,
    attributes: { ban_duration: string }
  ) => Promise<{ error: { message: string } | null }>
}

export async function enforceAccountDeletionAuthBan(
  authAdmin: AccountDeletionAuthAdmin,
  userId: string
): Promise<void> {
  let result: Awaited<ReturnType<AccountDeletionAuthAdmin['updateUserById']>>
  try {
    result = await authAdmin.updateUserById(userId, { ban_duration: '720h' })
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
