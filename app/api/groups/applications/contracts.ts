import { z } from 'zod'

export const groupApplicationIdSchema = z.string().uuid()
export const groupApplicationOperationIdSchema = z.string().uuid()

const codePointBoundedString = (maximum: number, minimum = 0) =>
  z
    .string()
    .transform((value) => value.trim().normalize('NFC'))
    .refine((value) => Array.from(value).length >= minimum && Array.from(value).length <= maximum)

export const approveGroupApplicationInputSchema = z
  .object({
    operation_id: groupApplicationOperationIdSchema,
  })
  .strict()

export const rejectGroupApplicationInputSchema = z
  .object({
    operation_id: groupApplicationOperationIdSchema,
    reason: codePointBoundedString(500).nullable().optional(),
  })
  .strict()

export const reviewGroupApplicationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('approved'),
      application_id: z.string().uuid(),
      applicant_id: z.string().uuid(),
      group_id: z.string().uuid(),
      group_name: codePointBoundedString(50, 1),
      operation_id: z.string().uuid(),
      applied: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      application_id: z.string().uuid(),
      applicant_id: z.string().uuid(),
      group_name: codePointBoundedString(50, 1),
      reject_reason: codePointBoundedString(500).nullable(),
      operation_id: z.string().uuid(),
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
      'account_inactive',
      'pro_required',
      'name_taken',
      'operation_conflict',
    ] as const
  ).map((status) => z.object({ status: z.literal(status) }).strict()),
])

export type ReviewGroupApplicationResult = z.infer<typeof reviewGroupApplicationResultSchema>
