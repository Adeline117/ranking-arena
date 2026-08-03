import {
  isPostDraftMeaningful,
  postDraftStorageKey,
  readPostDraft,
  removePostDraft,
  savePostDraft,
  type GroupPostDraftData,
  type GroupPostDraftScope,
  type PostDraftStorage,
  type ProfilePostDraftData,
  type ProfilePostDraftScope,
} from './post-draft-storage'

const OWNER_A = '11111111-1111-4111-8111-111111111111'
const OWNER_B = '22222222-2222-4222-8222-222222222222'
const GROUP_A = '33333333-3333-4333-8333-333333333333'
const GROUP_B = '44444444-4444-4444-8444-444444444444'

class MemoryStorage implements PostDraftStorage {
  readonly values = new Map<string, string>()
  readonly getKeys: string[] = []
  readonly removedKeys: string[] = []

  getItem(key: string): string | null {
    this.getKeys.push(key)
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.removedKeys.push(key)
    this.values.delete(key)
  }
}

const profileScope: ProfilePostDraftScope = {
  ownerId: OWNER_A,
  destination: { type: 'profile', handle: 'alice' },
}

const groupScope: GroupPostDraftScope = {
  ownerId: OWNER_A,
  destination: { type: 'group', groupId: GROUP_A },
}

const profileDraft: ProfilePostDraftData = {
  title: 'Market outlook',
  content: 'First line\nSecond line',
  images: [{ url: 'https://cdn.example.com/chart.png', fileName: 'chart.png' }],
  videos: [
    {
      url: 'https://cdn.example.com/analysis.mp4',
      fileName: 'analysis.mp4',
      fileSize: 1_024,
    },
  ],
  pollEnabled: true,
  pollOptions: [
    { text: 'Bullish', votes: 0 },
    { text: 'Bearish', votes: 0 },
  ],
  pollType: 'multiple',
  pollDuration: 72,
  visibility: 'followers',
  isSensitive: true,
  contentWarning: 'Volatile market',
}

const groupDraft: GroupPostDraftData = {
  title: 'Group outlook',
  content: 'Members only',
  images: [{ url: 'https://cdn.example.com/group.png', fileName: 'group.png' }],
  videos: [
    {
      url: 'https://cdn.example.com/group.mp4',
      fileName: 'group.mp4',
      fileSize: 2_048,
      thumbnail: 'https://cdn.example.com/group-thumbnail.png',
    },
  ],
  pollEnabled: true,
  pollOptions: [
    { text: 'Join', votes: 0 },
    { text: 'Wait', votes: 0 },
  ],
  pollType: 'single',
  pollDuration: 24,
  isSensitive: true,
  contentWarning: 'Risk discussion',
}

function storedEnvelope(
  storage: MemoryStorage,
  scope: ProfilePostDraftScope | GroupPostDraftScope
) {
  const key = postDraftStorageKey(scope)!
  return { key, value: JSON.parse(storage.values.get(key)!) as Record<string, unknown> }
}

describe('post draft storage scope', () => {
  it('binds versioned keys to canonical owner and exact destination', () => {
    const uppercaseGroupScope: GroupPostDraftScope = {
      ownerId: OWNER_A.toUpperCase(),
      destination: { type: 'group', groupId: GROUP_A.toUpperCase() },
    }

    expect(postDraftStorageKey(uppercaseGroupScope)).toBe(
      `ranking-arena:post-draft:v1:${OWNER_A}:group:${GROUP_A}`
    )
    expect(postDraftStorageKey(profileScope)).toBe(
      `ranking-arena:post-draft:v1:${OWNER_A}:profile:alice`
    )
    expect(
      postDraftStorageKey({
        ownerId: OWNER_B,
        destination: { type: 'profile', handle: 'alice' },
      })
    ).not.toBe(postDraftStorageKey(profileScope))
    expect(
      postDraftStorageKey({
        ownerId: OWNER_A,
        destination: { type: 'group', groupId: GROUP_B },
      })
    ).not.toBe(postDraftStorageKey(groupScope))
  })

  it('rejects malformed owners, groups, and profile handles before storage access', () => {
    expect(
      postDraftStorageKey({
        ownerId: 'not-a-user',
        destination: { type: 'profile', handle: 'alice' },
      })
    ).toBeNull()
    expect(
      postDraftStorageKey({
        ownerId: OWNER_A,
        destination: { type: 'group', groupId: 'not-a-group' },
      })
    ).toBeNull()
    expect(
      postDraftStorageKey({
        ownerId: OWNER_A,
        destination: { type: 'profile', handle: '../alice' },
      })
    ).toBeNull()
  })
})

describe('post draft storage contract', () => {
  it('round-trips every profile draft field without storing credentials', () => {
    const storage = new MemoryStorage()

    expect(savePostDraft(storage, profileScope, profileDraft)).toBe(true)
    expect(readPostDraft(storage, profileScope)).toEqual(profileDraft)

    const { value } = storedEnvelope(storage, profileScope)
    expect(value).toMatchObject({
      version: 1,
      ownerId: OWNER_A,
      destination: { type: 'profile', handle: 'alice' },
      draft: profileDraft,
    })
    expect(JSON.stringify(value)).not.toMatch(/token|authorization|credential/i)
  })

  it('round-trips every group draft field with its destination identity', () => {
    const storage = new MemoryStorage()

    expect(savePostDraft(storage, groupScope, groupDraft)).toBe(true)
    expect(readPostDraft(storage, groupScope)).toEqual(groupDraft)
    expect(storedEnvelope(storage, groupScope).value).toMatchObject({
      version: 1,
      ownerId: OWNER_A,
      destination: { type: 'group', groupId: GROUP_A },
      draft: groupDraft,
    })
  })

  it.each([
    ['version', (value: Record<string, unknown>) => ({ ...value, version: 2 })],
    ['owner', (value: Record<string, unknown>) => ({ ...value, ownerId: OWNER_B })],
    [
      'destination',
      (value: Record<string, unknown>) => ({
        ...value,
        destination: { type: 'profile', handle: 'bob' },
      }),
    ],
    ['extra body data', (value: Record<string, unknown>) => ({ ...value, accessToken: 'secret' })],
  ])('fails closed when the stored %s does not match', (_label, mutate) => {
    const storage = new MemoryStorage()
    expect(savePostDraft(storage, profileScope, profileDraft)).toBe(true)
    const { key, value } = storedEnvelope(storage, profileScope)
    storage.values.set(key, JSON.stringify(mutate(value)))

    expect(readPostDraft(storage, profileScope)).toBeNull()
    expect(storage.removedKeys).toEqual([])
  })

  it('fails closed on malformed JSON and strict nested fields', () => {
    const storage = new MemoryStorage()
    const key = postDraftStorageKey(profileScope)!
    storage.values.set(key, '{not-json')
    expect(readPostDraft(storage, profileScope)).toBeNull()

    expect(savePostDraft(storage, profileScope, profileDraft)).toBe(true)
    const envelope = storedEnvelope(storage, profileScope).value
    const draft = envelope.draft as Record<string, unknown>
    storage.values.set(key, JSON.stringify({ ...envelope, draft: { ...draft, unexpected: true } }))
    expect(readPostDraft(storage, profileScope)).toBeNull()
  })

  it('rejects credentials or fields that do not belong to the destination', () => {
    const storage = new MemoryStorage()
    expect(
      savePostDraft(storage, profileScope, {
        ...profileDraft,
        accessToken: 'secret',
      } as ProfilePostDraftData)
    ).toBe(false)
    expect(
      savePostDraft(storage, groupScope, {
        ...groupDraft,
        visibility: 'public',
      } as GroupPostDraftData)
    ).toBe(false)
    expect(storage.values.size).toBe(0)
  })

  it('never reads, migrates, or removes legacy ownerless drafts', () => {
    const storage = new MemoryStorage()
    const legacyKey = 'post_draft_alice'
    const legacyGroupKey = `group_post_draft_${GROUP_A}`
    const legacyValue = JSON.stringify({ title: 'Private draft', content: 'Owner unknown' })
    storage.values.set(legacyKey, legacyValue)
    storage.values.set(legacyGroupKey, legacyValue)

    expect(readPostDraft(storage, profileScope)).toBeNull()
    expect(readPostDraft(storage, groupScope)).toBeNull()
    expect(storage.values.get(legacyKey)).toBe(legacyValue)
    expect(storage.values.get(legacyGroupKey)).toBe(legacyValue)
    expect(storage.getKeys).toEqual([
      postDraftStorageKey(profileScope),
      postDraftStorageKey(groupScope),
    ])
    expect(storage.removedKeys).toEqual([])
  })

  it('removes only the exact current owner and destination draft', () => {
    const storage = new MemoryStorage()
    const otherOwnerScope: ProfilePostDraftScope = {
      ownerId: OWNER_B,
      destination: profileScope.destination,
    }
    const legacyKey = 'post_draft_alice'
    storage.values.set(legacyKey, 'legacy')
    expect(savePostDraft(storage, profileScope, profileDraft)).toBe(true)
    expect(savePostDraft(storage, otherOwnerScope, profileDraft)).toBe(true)

    expect(removePostDraft(storage, profileScope)).toBe(true)
    expect(readPostDraft(storage, profileScope)).toBeNull()
    expect(readPostDraft(storage, otherOwnerScope)).toEqual(profileDraft)
    expect(storage.values.get(legacyKey)).toBe('legacy')
  })
})

describe('meaningful post drafts', () => {
  const emptyProfileDraft: ProfilePostDraftData = {
    title: '',
    content: '',
    images: [],
    videos: [],
    pollEnabled: false,
    pollOptions: [
      { text: '', votes: 0 },
      { text: '', votes: 0 },
    ],
    pollType: 'single',
    pollDuration: 0,
    visibility: 'public',
    isSensitive: false,
    contentWarning: '',
  }

  it('treats the destination defaults as empty', () => {
    expect(isPostDraftMeaningful(profileScope.destination, emptyProfileDraft)).toBe(false)
    expect(
      isPostDraftMeaningful(groupScope.destination, {
        ...emptyProfileDraft,
        pollDuration: 24,
      })
    ).toBe(false)
  })

  it.each([
    { images: [{ url: 'https://cdn.example.com/a.png', fileName: 'a.png' }] },
    {
      videos: [{ url: 'https://cdn.example.com/a.mp4', fileName: 'a.mp4', fileSize: 100 }],
    },
    { pollEnabled: true },
    {
      pollOptions: [
        { text: 'Yes', votes: 0 },
        { text: '', votes: 0 },
      ],
    },
    { visibility: 'followers' as const },
    { isSensitive: true },
    { contentWarning: 'Spoiler' },
  ])('keeps non-text state guarded as an unsaved draft', (change) => {
    expect(
      isPostDraftMeaningful(profileScope.destination, { ...emptyProfileDraft, ...change })
    ).toBe(true)
  })
})
