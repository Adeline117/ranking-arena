import { z } from 'zod'

const statusOnly = <T extends string>(status: T) => z.object({ status: z.literal(status) }).strict()

export const twoFactorEnrollmentReadResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      totp_secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
    })
    .strict(),
  statusOnly('invalid_user'),
  statusOnly('user_not_found'),
  statusOnly('profile_not_found'),
  statusOnly('already_enabled'),
  statusOnly('secret_not_found'),
])

export const twoFactorEnrollmentStageResultSchema = z.discriminatedUnion('status', [
  statusOnly('staged'),
  statusOnly('invalid'),
  statusOnly('user_not_found'),
  statusOnly('profile_not_found'),
  statusOnly('already_enabled'),
])

export const twoFactorEnableResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('enabled'), code_count: z.literal(8) }).strict(),
  statusOnly('invalid'),
  statusOnly('invalid_codes'),
  statusOnly('user_not_found'),
  statusOnly('profile_not_found'),
  statusOnly('already_enabled'),
  statusOnly('secret_not_found'),
  statusOnly('secret_changed'),
])

export const twoFactorBackupCodeRotationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('rotated'), code_count: z.literal(8) }).strict(),
  statusOnly('invalid_user'),
  statusOnly('invalid_codes'),
  statusOnly('user_not_found'),
  statusOnly('profile_not_found'),
  statusOnly('not_enabled'),
  statusOnly('credential_inconsistent'),
])

export const twoFactorDisableResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('disabled'),
      code_count: z.number().int().nonnegative(),
      secret_count: z.number().int().min(0).max(1),
    })
    .strict(),
  statusOnly('invalid_user'),
  statusOnly('user_not_found'),
  statusOnly('profile_not_found'),
  statusOnly('not_enabled'),
])
