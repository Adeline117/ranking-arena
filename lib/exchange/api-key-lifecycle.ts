import { z } from 'zod'

const uuidSchema = z.string().uuid()
const generationSchema = z.number().int().positive().safe()

const statusOnly = <T extends string>(status: T) => z.object({ status: z.literal(status) }).strict()

export const exchangeApiConnectionSaveResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('saved'),
      user_id: uuidSchema,
      exchange: z.string().min(1),
      connection_id: uuidSchema,
      generation: generationSchema,
      verified: z.boolean(),
    })
    .strict(),
  statusOnly('invalid'),
  statusOnly('missing_account'),
  statusOnly('suspended'),
])

export const traderAuthorizationBindResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('bound'),
      user_id: uuidSchema,
      platform: z.string().min(1),
      trader_id: z.string().min(1),
      connection_id: uuidSchema,
      connection_generation: generationSchema,
      authorization_id: uuidSchema,
      authorization_generation: generationSchema,
    })
    .strict(),
  statusOnly('invalid'),
  statusOnly('missing_account'),
  statusOnly('suspended'),
])

export const exchangeApiSyncClaimResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('claimed'),
      user_id: uuidSchema,
      exchange: z.string().min(1),
      connection_id: uuidSchema,
      generation: generationSchema,
      api_key_encrypted: z.string().min(1),
      api_secret_encrypted: z.string().min(1),
      passphrase_encrypted: z.string().nullable(),
      legacy_access_token_encrypted: z.string().nullable(),
    })
    .strict(),
  statusOnly('invalid'),
  statusOnly('missing_account'),
  statusOnly('suspended'),
  statusOnly('not_found'),
  statusOnly('inactive'),
  statusOnly('oauth_connection'),
  statusOnly('invalid_credentials'),
])

export const exchangeApiSyncFinishResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('recorded'),
      user_id: uuidSchema,
      connection_id: uuidSchema,
      generation: generationSchema,
      sync_status: z.enum(['success', 'error']),
      synced_at: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('superseded'),
      current_generation: generationSchema.optional(),
    })
    .strict(),
  statusOnly('invalid'),
  statusOnly('missing_account'),
  statusOnly('suspended'),
  statusOnly('not_found'),
  statusOnly('inactive'),
])

export type ExchangeApiSyncClaim = Extract<
  z.infer<typeof exchangeApiSyncClaimResultSchema>,
  { status: 'claimed' }
>
