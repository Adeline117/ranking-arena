import { z } from 'zod'

export const channelIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())

const userIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())

export const createGroupChannelInputSchema = z
  .object({
    channelId: channelIdSchema.optional(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2_000).nullable().optional(),
    // A group has one owner, so at most 49 additional members fit the
    // product's 50-member cap.
    // The raw request may include the actor once. The route removes the actor
    // and duplicates, then enforces at most 49 additional members.
    memberIds: z.array(userIdSchema).min(1).max(50),
  })
  .strict()

export const addChannelMembersInputSchema = z
  .object({
    userIds: z.array(userIdSchema).min(1).max(50),
  })
  .strict()

export const removeChannelMemberInputSchema = z.object({ userId: userIdSchema }).strict()

export const updateChannelMemberRoleInputSchema = z
  .object({
    userId: userIdSchema,
    role: z.enum(['admin', 'member']),
  })
  .strict()
