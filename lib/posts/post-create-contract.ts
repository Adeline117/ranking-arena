import { z } from 'zod'

const URL_CONTROL_OR_SPACE_PATTERN = /[\u0000-\u001f\u007f\s]/
const NormalizedUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const CanonicalUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())

const trimmedString = (minimum: number, maximum: number) =>
  z
    .string()
    .transform((value) => value.trim().normalize('NFC'))
    .pipe(z.string().min(minimum).max(maximum))

const exactTrimmedString = (minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => value === value.trim() && value === value.normalize('NFC'))

const ImageUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value === value.trim())
  .refine((value) => !URL_CONTROL_OR_SPACE_PATTERN.test(value))
  .refine((value) => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  })

const ImageListSchema = z
  .array(ImageUrlSchema)
  .max(9)
  .refine((images) => new Set(images).size === images.length, {
    message: 'Duplicate images are not allowed',
  })

const PollOptionSchema = trimmedString(1, 100)

const PollOptionsSchema = z
  .array(PollOptionSchema)
  .min(2)
  .max(6)
  .refine(
    (options) =>
      new Set(options.map((option) => option.normalize('NFKC').toLowerCase())).size ===
      options.length,
    { message: 'Duplicate poll options are not allowed' }
  )

const ContentWarningRequestSchema = z.union([
  z
    .string()
    .transform((value) => value.trim().normalize('NFC'))
    .pipe(z.string().max(200)),
  z.null(),
])

export const PostCreateRequestSchema = z
  .object({
    operation_id: NormalizedUuidSchema.optional(),
    title: trimmedString(1, 200),
    content: trimmedString(1, 10_000),
    group_id: NormalizedUuidSchema.nullable().optional(),
    images: ImageListSchema.default([]),
    poll_enabled: z.boolean().default(false),
    poll_options: PollOptionsSchema.optional(),
    poll_type: z.enum(['single', 'multiple']).nullable().optional(),
    poll_duration_hours: z.number().int().min(0).max(168).nullable().optional(),
    visibility: z.enum(['public', 'followers', 'group']).default('public'),
    is_sensitive: z.boolean().default(false),
    content_warning: ContentWarningRequestSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const isGroupPost = value.group_id !== undefined && value.group_id !== null
    if (isGroupPost !== (value.visibility === 'group')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['visibility'],
        message: isGroupPost
          ? 'Group posts must use group visibility'
          : 'Group visibility requires a group',
      })
    }

    if (!value.poll_enabled) {
      for (const field of ['poll_options', 'poll_type', 'poll_duration_hours'] as const) {
        if (value[field] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} requires an enabled poll`,
          })
        }
      }
    } else if (value.poll_options !== undefined) {
      if (value.poll_type === undefined || value.poll_type === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['poll_type'],
          message: 'Custom polls require a poll type',
        })
      }
      if (value.poll_duration_hours === undefined || value.poll_duration_hours === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['poll_duration_hours'],
          message: 'Custom polls require a duration',
        })
      }
    } else if (value.poll_type !== undefined && value.poll_type !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['poll_type'],
        message: 'Poll type requires custom poll options',
      })
    } else if (value.poll_duration_hours !== undefined && value.poll_duration_hours !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['poll_duration_hours'],
        message: 'Poll duration requires custom poll options',
      })
    }

    if (
      !value.is_sensitive &&
      value.content_warning !== undefined &&
      value.content_warning !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content_warning'],
        message: 'Content warnings require sensitive content',
      })
    }
  })

const AtomicCreatedPostSchema = z
  .object({
    id: CanonicalUuidSchema,
    author_id: CanonicalUuidSchema,
    author_handle: exactTrimmedString(1, 64),
    group_id: CanonicalUuidSchema.nullable(),
    title: exactTrimmedString(1, 200),
    content: exactTrimmedString(1, 10_000),
    images: ImageListSchema,
    poll_enabled: z.boolean(),
    poll_id: CanonicalUuidSchema.nullable(),
    visibility: z.enum(['public', 'followers', 'group']),
    is_sensitive: z.boolean(),
    content_warning: exactTrimmedString(0, 200).nullable(),
    language: z.string().min(1).max(16),
    mentions: z.array(z.string()),
    hashtags: z.array(z.string()),
    author_arena_score: z.number(),
    author_is_verified: z.boolean(),
    content_version: z.number().int().nonnegative(),
    status: z.literal('active'),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict()

const AtomicCreatedPollSchema = z
  .object({
    id: CanonicalUuidSchema,
    post_id: CanonicalUuidSchema,
    question: z.string(),
    options: z
      .array(
        z
          .object({
            text: exactTrimmedString(1, 100),
            votes: z.number().int().nonnegative(),
            index: z.number().int().nonnegative(),
          })
          .strict()
      )
      .min(2)
      .max(6),
    type: z.enum(['single', 'multiple']),
    end_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()

const AtomicCreatePostResultFields = {
  status: z.enum(['created', 'replayed']),
  applied: z.boolean(),
  operation_id: CanonicalUuidSchema,
  actor_id: CanonicalUuidSchema,
  post: AtomicCreatedPostSchema,
  poll: AtomicCreatedPollSchema.nullable(),
} as const

function validateAtomicCreatePostResult(
  value: {
    status: 'created' | 'replayed'
    applied: boolean
    actor_id: string
    post: z.infer<typeof AtomicCreatedPostSchema>
    poll: z.infer<typeof AtomicCreatedPollSchema> | null
  },
  context: z.RefinementCtx
) {
  if ((value.status === 'created') !== value.applied) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['applied'],
      message: 'Created operations must be applied exactly once',
    })
  }

  if (value.actor_id !== value.post.author_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actor_id'],
      message: 'Actor must match the post author',
    })
  }

  const hasPollId = value.post.poll_id !== null
  const hasPoll = value.poll !== null
  if (hasPollId !== hasPoll || (!value.post.poll_enabled && (hasPollId || hasPoll))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['poll'],
      message: 'Poll evidence is inconsistent with the post',
    })
  }

  if (
    value.poll !== null &&
    (value.post.poll_id !== value.poll.id || value.poll.post_id !== value.post.id)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['poll'],
      message: 'Poll identity must match the created post',
    })
  }
}

export const AtomicCreatePostAckSchema = z
  .object(AtomicCreatePostResultFields)
  .strict()
  .superRefine(validateAtomicCreatePostResult)

export const PostCreateApiSuccessSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        post: AtomicCreatedPostSchema,
        poll: AtomicCreatedPollSchema.nullable(),
        operation: z
          .object({
            status: z.enum(['created', 'replayed']),
            applied: z.boolean(),
            operation_id: CanonicalUuidSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    validateAtomicCreatePostResult(
      {
        ...value.data.operation,
        actor_id: value.data.post.author_id,
        post: value.data.post,
        poll: value.data.poll,
      },
      context
    )
  })

export type PostCreateRequest = z.infer<typeof PostCreateRequestSchema>
export type AtomicCreatePostAck = z.infer<typeof AtomicCreatePostAckSchema>
export type PostCreateApiSuccess = z.infer<typeof PostCreateApiSuccessSchema>
