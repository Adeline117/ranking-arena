import {
  readGroupMemberPreferencesMutationAcknowledgement,
  readGroupMemberPreferencesSnapshot,
} from './member-prefs-contract'

const viewerId = '11111111-1111-4111-8111-111111111111'
const groupId = '22222222-2222-4222-8222-222222222222'
const timestamp = '2026-08-03T12:00:00.000Z'

function snapshot() {
  return {
    success: true,
    data: {
      preferences: {
        viewer_id: viewerId,
        group_id: groupId,
        self_notify_muted: false,
        pinned: true,
      },
    },
    meta: { timestamp },
  }
}

describe('group member preferences client contract', () => {
  it('accepts only an exact viewer and group bound snapshot', () => {
    expect(readGroupMemberPreferencesSnapshot(snapshot(), { viewerId, groupId })).toEqual({
      viewerId,
      groupId,
      selfNotifyMuted: false,
      pinned: true,
    })
    expect(
      readGroupMemberPreferencesSnapshot({ ...snapshot(), extra: true }, { viewerId, groupId })
    ).toBeNull()
    expect(
      readGroupMemberPreferencesSnapshot(
        {
          ...snapshot(),
          data: {
            preferences: { ...snapshot().data.preferences, viewer_id: groupId },
          },
        },
        { viewerId, groupId }
      )
    ).toBeNull()
    expect(
      readGroupMemberPreferencesSnapshot(
        {
          ...snapshot(),
          data: {
            preferences: { ...snapshot().data.preferences, pinned: 1 },
          },
        },
        { viewerId, groupId }
      )
    ).toBeNull()
  })

  it('binds a mutation receipt to the requested field and final value', () => {
    const value = {
      ...snapshot(),
      data: {
        preferences: {
          ...snapshot().data.preferences,
          self_notify_muted: true,
        },
        mutation: { field: 'self_notify_muted', value: true },
      },
    }
    const expected = {
      viewerId,
      groupId,
      field: 'self_notify_muted' as const,
      value: true,
    }
    expect(readGroupMemberPreferencesMutationAcknowledgement(value, expected)).toEqual({
      viewerId,
      groupId,
      selfNotifyMuted: true,
      pinned: true,
    })
    expect(
      readGroupMemberPreferencesMutationAcknowledgement(
        {
          ...value,
          data: { ...value.data, mutation: { field: 'pinned', value: true } },
        },
        expected
      )
    ).toBeNull()
    expect(
      readGroupMemberPreferencesMutationAcknowledgement(
        {
          ...value,
          data: {
            ...value.data,
            preferences: { ...value.data.preferences, self_notify_muted: false },
          },
        },
        expected
      )
    ).toBeNull()
  })
})
