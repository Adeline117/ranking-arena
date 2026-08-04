import {
  readChatSettingsLoadAcknowledgement,
  readChatSettingsMutationAcknowledgement,
  type ChatSettings,
  type ChatSettingsPatch,
} from '../chat-settings-contract'

const identity = {
  actorId: '11111111-1111-4111-8111-111111111111',
  targetId: '22222222-2222-4222-8222-222222222222',
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

const settings: ChatSettings = {
  remark: null,
  is_muted: false,
  is_pinned: false,
  is_blocked: false,
  cleared_before: null,
  updated_at: '2026-08-03T12:00:00.000Z',
}

function mutationAck(
  updates: ChatSettingsPatch,
  nextSettings: ChatSettings,
  blockStatus: string | null = null
) {
  return {
    actor_id: identity.actorId,
    target_id: identity.targetId,
    conversation_id: identity.conversationId,
    applied_fields: ['remark', 'is_muted', 'is_pinned', 'is_blocked', 'clear_history'].filter(
      (field) => Object.prototype.hasOwnProperty.call(updates, field)
    ),
    block_status: blockStatus,
    settings: nextSettings,
  }
}

describe('chat settings HTTP acknowledgement contract', () => {
  it('accepts only a load bound to the exact actor, target and conversation', () => {
    const acknowledgement = {
      actor_id: identity.actorId,
      target_id: identity.targetId,
      conversation_id: identity.conversationId,
      settings,
    }

    expect(readChatSettingsLoadAcknowledgement(acknowledgement, identity)).toEqual(settings)
    expect(
      readChatSettingsLoadAcknowledgement(
        { ...acknowledgement, target_id: '33333333-3333-4333-8333-333333333333' },
        identity
      )
    ).toBeNull()
    expect(
      readChatSettingsLoadAcknowledgement({ ...acknowledgement, extra: true }, identity)
    ).toBeNull()
  })

  it.each([
    [{ remark: 'Café' }, { ...settings, remark: 'Café' }, null],
    [{ is_muted: true }, { ...settings, is_muted: true }, null],
    [{ is_pinned: true }, { ...settings, is_pinned: true }, null],
    [{ is_blocked: true }, { ...settings, is_blocked: true }, 'blocked'],
    [
      { clear_history: true },
      {
        ...settings,
        cleared_before: '2026-08-03T12:00:01.000Z',
        updated_at: '2026-08-03T12:00:01.000Z',
      },
      null,
    ],
  ] as Array<[ChatSettingsPatch, ChatSettings, string | null]>)(
    'accepts the exact desired-state acknowledgement %#',
    (updates, nextSettings, blockStatus) => {
      expect(
        readChatSettingsMutationAcknowledgement(
          mutationAck(updates, nextSettings, blockStatus),
          identity,
          updates
        )
      ).toEqual(nextSettings)
    }
  )

  it('rejects mismatched action, desired state, block evidence and clear-history revision', () => {
    expect(
      readChatSettingsMutationAcknowledgement(
        { ...mutationAck({ is_muted: true }, { ...settings, is_muted: true }), applied_fields: [] },
        identity,
        { is_muted: true }
      )
    ).toBeNull()
    expect(
      readChatSettingsMutationAcknowledgement(
        mutationAck({ is_pinned: true }, settings),
        identity,
        { is_pinned: true }
      )
    ).toBeNull()
    expect(
      readChatSettingsMutationAcknowledgement(
        mutationAck({ is_blocked: true }, { ...settings, is_blocked: true }, 'unblocked'),
        identity,
        { is_blocked: true }
      )
    ).toBeNull()
    expect(
      readChatSettingsMutationAcknowledgement(
        mutationAck(
          { clear_history: true },
          {
            ...settings,
            cleared_before: '2026-08-03T12:00:00.000Z',
            updated_at: '2026-08-03T12:00:01.000Z',
          }
        ),
        identity,
        { clear_history: true }
      )
    ).toBeNull()
  })
})
