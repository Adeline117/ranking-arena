import { z } from 'zod'

export const HOT_DISCOVERY_REQUEST_TIMEOUT_MS = 15_000
export const HOT_DISCOVERY_PAGE_LIMIT = 30

const NullableText = z.string().nullable()
const NonnegativeCount = z.number().int().nonnegative()

const HotPostSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    content: z.string(),
    author_handle: z.string().min(1),
    author_avatar_url: NullableText.optional(),
    group_id: z.string().uuid().nullable(),
    group_name: NullableText.optional(),
    group_name_en: NullableText.optional(),
    comment_count: NonnegativeCount,
    like_count: NonnegativeCount,
    dislike_count: NonnegativeCount,
    view_count: NonnegativeCount,
    hot_score: z.number().finite(),
    created_at: z.string().datetime({ offset: true }),
    user_reaction: z.enum(['up', 'down']).nullable(),
  })
  // The shared posts endpoint returns additional, independently validated post
  // fields. Hot only adopts the fields above; accepting those documented
  // additions avoids coupling this focused reader to every post feature.
  .passthrough()

const HotPostsPageSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ posts: z.array(HotPostSchema).max(HOT_DISCOVERY_PAGE_LIMIT) }).strict(),
    meta: z
      .object({
        pagination: z
          .object({
            limit: z.literal(HOT_DISCOVERY_PAGE_LIMIT),
            offset: z.literal(0),
            has_more: z.boolean(),
          })
          .strict(),
        timestamp: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict()

const HotGroupSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    name_en: NullableText,
    description: NullableText,
    avatar_url: NullableText,
    member_count: NonnegativeCount,
  })
  .strict()

const HotGroupsPageSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        groups: z.array(HotGroupSchema).max(HOT_DISCOVERY_PAGE_LIMIT),
        pagination: z
          .object({
            limit: z.literal(HOT_DISCOVERY_PAGE_LIMIT),
            offset: z.literal(0),
            total: NonnegativeCount,
            has_more: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const { groups, pagination } = value.data
    if (groups.length > pagination.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'group page exceeds its authoritative total',
        path: ['data', 'groups'],
      })
    }
    if (
      pagination.has_more !==
      (groups.length === pagination.limit && pagination.total > groups.length)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'group pagination acknowledgement is inconsistent',
        path: ['data', 'pagination', 'has_more'],
      })
    }
  })

export type HotPostRow = z.infer<typeof HotPostSchema>
export type HotGroupRow = z.infer<typeof HotGroupSchema>

export function readHotPostsPage(value: unknown): HotPostRow[] | null {
  const parsed = HotPostsPageSchema.safeParse(value)
  return parsed.success ? parsed.data.data.posts : null
}

export function readHotGroupsPage(value: unknown): HotGroupRow[] | null {
  const parsed = HotGroupsPageSchema.safeParse(value)
  return parsed.success ? parsed.data.data.groups : null
}
