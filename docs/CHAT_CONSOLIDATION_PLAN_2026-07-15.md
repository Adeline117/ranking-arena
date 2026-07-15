# Channels / DMs consolidation

## Decision

Arena keeps two message transports because their authorization and data models
are materially different:

- Direct messages use conversations and `direct_messages` for two participants.
- Group chat uses channels, memberships, `channel_messages`, group read state,
  member administration, reactions, and replies.

They share one discovery surface: `/inbox`. The inbox exposes Notifications and
Messages; Messages can be filtered to All, Direct, or Group. `/channels` and
`/messages` are compatibility entry points that select the matching inbox view.
Existing `/channels/[channelId]` and `/messages/[conversationId]` detail URLs stay
stable, so no database migration or message-history rewrite is required.

## Implemented routing contract

- `/channels` redirects to `/inbox?tab=messages&chat=group`.
- `/messages` redirects to `/inbox?tab=messages&chat=direct`.
- `/notifications` redirects to `/inbox?tab=notifications`.
- Detail-page back/error navigation preserves the originating Group or Direct
  filter instead of dropping users on the default Notifications tab.

## Deliberately not merged

The channel and DM tables, RLS policies, APIs, realtime subscriptions, and read
models remain separate. Combining them would require a risky data migration and
would erase group-specific permission semantics without improving the user
experience. Future work may extract shared presentation components, but must not
collapse transport authorization rules.
