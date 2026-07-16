import { z } from 'zod'

export const MAX_PUSH_TOKEN_LENGTH = 4_096

export const PushSubscriptionTokenSchema = z
  .string()
  .min(1)
  .max(MAX_PUSH_TOKEN_LENGTH)
  .refine((value) => value.trim() === value, 'Token must not contain outer whitespace')

export const PushSubscriptionTokenBodySchema = z
  .object({ token: PushSubscriptionTokenSchema })
  .strict()

export const PushSubscriptionRegistrationSchema = z
  .object({
    token: PushSubscriptionTokenSchema,
    provider: z.enum(['fcm', 'apns', 'web']),
    deviceId: z.string().min(1).max(256).optional(),
    deviceName: z.string().min(1).max(256).optional(),
    platform: z.enum(['ios', 'android', 'web']).optional(),
    endpoint: z.string().min(1).max(MAX_PUSH_TOKEN_LENGTH).optional(),
    p256dh: z.string().min(1).max(2_048).optional(),
    auth: z.string().min(1).max(2_048).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider !== 'web') return

    if (value.token !== value.endpoint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message: 'Web Push token must match endpoint',
      })
    }

    if (!value.p256dh || !value.auth) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['p256dh'],
        message: 'Web Push keys are required',
      })
    }

    try {
      if (!value.endpoint || new URL(value.endpoint).protocol !== 'https:') throw new Error()
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message: 'Web Push endpoint must use HTTPS',
      })
    }
  })

export type PushSubscriptionRegistrationInput = z.infer<typeof PushSubscriptionRegistrationSchema>
