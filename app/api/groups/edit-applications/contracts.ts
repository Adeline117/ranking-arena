import { z } from 'zod'

const ROLE_NAMES_MAX_BYTES = 32 * 1024
const RULES_JSON_MAX_BYTES = 64 * 1024

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
  } catch {
    return false
  }
}

function isWellFormedWithoutNul(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit === 0) return false

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false
      index += 1
      continue
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false
  }

  return true
}

const normalizedText = (maximum: number, minimum = 0) =>
  z
    .string()
    .transform((value) => value.trim().normalize('NFC'))
    .refine(isWellFormedWithoutNul)
    .refine((value) => Array.from(value).length >= minimum && Array.from(value).length <= maximum)

const canonicalText = (maximum: number, minimum = 0) =>
  z.string().refine((value) => {
    const canonical = value.trim().normalize('NFC')
    const length = Array.from(value).length
    return (
      isWellFormedWithoutNul(value) && value === canonical && length >= minimum && length <= maximum
    )
  })

const nullableNormalizedText = (maximum: number) =>
  normalizedText(maximum)
    .nullable()
    .transform((value) => value || null)

const normalizedUuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())

const canonicalUuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())

const nullableAvatarUrlInput = normalizedText(2048)
  .nullable()
  .transform((value) => value || null)
  .refine((value) => value === null || isAbsoluteHttpUrl(value))

const nullableAvatarUrlResult = canonicalText(2048)
  .nullable()
  .refine((value) => value === null || isAbsoluteHttpUrl(value))

const localizedRoleNameInputSchema = z
  .object({
    zh: normalizedText(50),
    en: normalizedText(50),
  })
  .strict()

const localizedRoleNameResultSchema = z
  .object({
    zh: canonicalText(50),
    en: canonicalText(50),
  })
  .strict()

const roleNamesInputSchema = z
  .object({
    admin: localizedRoleNameInputSchema,
    member: localizedRoleNameInputSchema,
  })
  .strict()
  .refine((value) => jsonByteLength(value) <= ROLE_NAMES_MAX_BYTES)

const roleNamesResultSchema = z
  .object({
    admin: localizedRoleNameResultSchema,
    member: localizedRoleNameResultSchema,
  })
  .strict()
  .refine((value) => jsonByteLength(value) <= ROLE_NAMES_MAX_BYTES)

const ruleInputSchema = z
  .object({
    zh: normalizedText(2000),
    en: normalizedText(2000),
  })
  .strict()

const ruleResultSchema = z
  .object({
    zh: canonicalText(2000),
    en: canonicalText(2000),
  })
  .strict()

const rulesJsonInputSchema = z
  .array(ruleInputSchema)
  .max(100)
  .refine((value) => jsonByteLength(value) <= RULES_JSON_MAX_BYTES)

const rulesJsonResultSchema = z
  .array(ruleResultSchema)
  .max(100)
  .refine((value) => jsonByteLength(value) <= RULES_JSON_MAX_BYTES)

export const groupEditApplicationIdSchema = normalizedUuid
export const groupEditGroupIdSchema = normalizedUuid
export const groupEditOperationIdSchema = normalizedUuid

export const groupEditApplicationInputSchema = z
  .object({
    operation_id: groupEditOperationIdSchema,
    name: normalizedText(50, 1),
    name_en: nullableNormalizedText(50),
    description: nullableNormalizedText(500),
    description_en: nullableNormalizedText(500),
    avatar_url: nullableAvatarUrlInput,
    role_names: roleNamesInputSchema.nullable(),
    rules_json: rulesJsonInputSchema.nullable(),
    rules: nullableNormalizedText(10000),
    is_premium_only: z.boolean(),
  })
  .strict()

export const approveGroupEditApplicationInputSchema = z
  .object({
    operation_id: groupEditOperationIdSchema,
  })
  .strict()

export const rejectGroupEditApplicationInputSchema = z
  .object({
    operation_id: groupEditOperationIdSchema,
    reason: nullableNormalizedText(500).optional(),
  })
  .strict()

const groupEditApplicationSnapshotSchema = z
  .object({
    id: canonicalUuid,
    group_id: canonicalUuid,
    applicant_id: canonicalUuid,
    name: canonicalText(50, 1),
    name_en: canonicalText(50).nullable(),
    description: canonicalText(500).nullable(),
    description_en: canonicalText(500).nullable(),
    avatar_url: nullableAvatarUrlResult,
    role_names: roleNamesResultSchema.nullable(),
    rules_json: rulesJsonResultSchema.nullable(),
    rules: canonicalText(10000).nullable(),
    is_premium_only: z.boolean(),
    status: z.literal('pending'),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict()

export const submitGroupEditApplicationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('submitted'),
      operation_id: canonicalUuid,
      application: groupEditApplicationSnapshotSchema,
      applied: z.boolean(),
    })
    .strict(),
  ...(
    [
      'invalid',
      'account_inactive',
      'not_found',
      'dissolved',
      'forbidden',
      'premium_change_unsupported',
      'name_taken',
      'pending_exists',
      'operation_conflict',
    ] as const
  ).map((status) => z.object({ status: z.literal(status) }).strict()),
])

export const reviewGroupEditApplicationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('approved'),
      operation_id: canonicalUuid,
      application_id: canonicalUuid,
      applicant_id: canonicalUuid,
      group_id: canonicalUuid,
      group_name: canonicalText(50, 1),
      reviewed_at: z.string().datetime({ offset: true }),
      applied: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      operation_id: canonicalUuid,
      application_id: canonicalUuid,
      applicant_id: canonicalUuid,
      group_id: canonicalUuid,
      group_name: canonicalText(50, 1),
      reject_reason: canonicalText(500).nullable(),
      reviewed_at: z.string().datetime({ offset: true }),
      applied: z.boolean(),
    })
    .strict(),
  ...(
    [
      'invalid',
      'reviewer_inactive',
      'reviewer_unauthorized',
      'not_found',
      'already_processed',
      'dissolved',
      'owner_changed',
      'account_inactive',
      'premium_change_unsupported',
      'name_taken',
      'operation_conflict',
    ] as const
  ).map((status) => z.object({ status: z.literal(status) }).strict()),
])

export type GroupEditApplicationInput = z.infer<typeof groupEditApplicationInputSchema>
export type SubmitGroupEditApplicationResult = z.infer<
  typeof submitGroupEditApplicationResultSchema
>
export type ReviewGroupEditApplicationResult = z.infer<
  typeof reviewGroupEditApplicationResultSchema
>
