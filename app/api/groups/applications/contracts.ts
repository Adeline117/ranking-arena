import { z } from 'zod'

export const groupApplicationIdSchema = z.string().uuid()

export const rejectGroupApplicationInputSchema = z
  .object({
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict()

export const reviewGroupApplicationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('approved'),
      application_id: z.string().uuid(),
      applicant_id: z.string().uuid(),
      group_id: z.string().uuid(),
      group_name: z.string().min(1).max(50),
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      application_id: z.string().uuid(),
      applicant_id: z.string().uuid(),
      group_name: z.string().min(1).max(50),
      reject_reason: z.string().max(500).nullable(),
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
    ] as const
  ).map((status) => z.object({ status: z.literal(status) }).strict()),
])

export type ReviewGroupApplicationResult = z.infer<typeof reviewGroupApplicationResultSchema>
