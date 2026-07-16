import {
  approveGroupEditApplicationInputSchema,
  groupEditApplicationInputSchema,
  groupEditApplicationIdSchema,
  groupEditGroupIdSchema,
  rejectGroupEditApplicationInputSchema,
  reviewGroupEditApplicationResultSchema,
  submitGroupEditApplicationResultSchema,
} from '../contracts'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '22222222-2222-4222-8222-222222222222'
const APPLICATION_ID = '33333333-3333-4333-8333-333333333333'
const OPERATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CREATED_AT = '2026-07-16T17:00:00.000Z'

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: OPERATION_ID,
    name: 'Atomic Group',
    name_en: 'Atomic Group',
    description: 'Description',
    description_en: null,
    avatar_url: 'https://example.com/avatar.png',
    role_names: {
      admin: { zh: '管理员', en: 'Admin' },
      member: { zh: '成员', en: 'Member' },
    },
    rules_json: [{ zh: '友善', en: 'Be kind' }],
    rules: 'Be kind',
    is_premium_only: false,
    ...overrides,
  }
}

function validSnapshot(overrides: Record<string, unknown> = {}) {
  const input = validInput()
  return {
    id: APPLICATION_ID,
    group_id: GROUP_ID,
    applicant_id: ACTOR_ID,
    name: input.name,
    name_en: input.name_en,
    description: input.description,
    description_en: input.description_en,
    avatar_url: input.avatar_url,
    role_names: input.role_names,
    rules_json: input.rules_json,
    rules: input.rules,
    is_premium_only: input.is_premium_only,
    status: 'pending',
    created_at: CREATED_AT,
    ...overrides,
  }
}

describe('group edit application contracts', () => {
  it('normalizes every textual input with NFC/trim and canonicalizes UUID casing', () => {
    const parsed = groupEditApplicationInputSchema.parse(
      validInput({
        operation_id: OPERATION_ID.toUpperCase(),
        name: '  Cafe\u0301  ',
        name_en: '  Name  ',
        description: '  ',
        role_names: {
          admin: { zh: '  管理员 ', en: ' Admin ' },
          member: { zh: ' 成员 ', en: ' Member ' },
        },
        rules_json: [{ zh: ' 友善 ', en: ' Be kind ' }],
        rules: '  Be kind  ',
      })
    )

    expect(parsed).toEqual(
      expect.objectContaining({
        operation_id: OPERATION_ID,
        name: 'Café',
        name_en: 'Name',
        description: null,
        role_names: {
          admin: { zh: '管理员', en: 'Admin' },
          member: { zh: '成员', en: 'Member' },
        },
        rules_json: [{ zh: '友善', en: 'Be kind' }],
        rules: 'Be kind',
      })
    )
    expect(groupEditGroupIdSchema.parse('BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB')).toBe(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    expect(groupEditApplicationIdSchema.parse('CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC')).toBe(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
  })

  it('counts Unicode code points and enforces JSON item/count/byte bounds', () => {
    expect(
      groupEditApplicationInputSchema.safeParse(validInput({ name: '😀'.repeat(50) })).success
    ).toBe(true)
    expect(
      groupEditApplicationInputSchema.safeParse(validInput({ name: '😀'.repeat(51) })).success
    ).toBe(false)
    expect(
      groupEditApplicationInputSchema.safeParse(
        validInput({ rules_json: Array.from({ length: 101 }, () => ({ zh: '', en: '' })) })
      ).success
    ).toBe(false)
    expect(
      groupEditApplicationInputSchema.safeParse(
        validInput({
          rules_json: Array.from({ length: 100 }, () => ({
            zh: '😀'.repeat(100),
            en: '😀'.repeat(100),
          })),
        })
      ).success
    ).toBe(false)
  })

  it.each(['nul\u0000byte', '\ud800', '\udc00'])(
    'rejects PostgreSQL-incompatible text input and result data %#',
    (invalidText) => {
      expect(
        groupEditApplicationInputSchema.safeParse(validInput({ name: invalidText })).success
      ).toBe(false)
      expect(
        groupEditApplicationInputSchema.safeParse(
          validInput({ rules_json: [{ zh: invalidText, en: 'valid' }] })
        ).success
      ).toBe(false)
      expect(
        rejectGroupEditApplicationInputSchema.safeParse({
          operation_id: OPERATION_ID,
          reason: invalidText,
        }).success
      ).toBe(false)
      expect(
        submitGroupEditApplicationResultSchema.safeParse({
          status: 'submitted',
          operation_id: OPERATION_ID,
          application: validSnapshot({ description: invalidText }),
          applied: true,
        }).success
      ).toBe(false)
      expect(
        reviewGroupEditApplicationResultSchema.safeParse({
          status: 'approved',
          operation_id: OPERATION_ID,
          application_id: APPLICATION_ID,
          applicant_id: ACTOR_ID,
          group_id: GROUP_ID,
          group_name: invalidText,
          reviewed_at: CREATED_AT,
          applied: true,
        }).success
      ).toBe(false)
    }
  )

  it('still accepts well-formed astral Unicode by code point rather than UTF-16 unit', () => {
    const fiftyAstralCharacters = '😀'.repeat(50)

    const parsed = groupEditApplicationInputSchema.safeParse(
      validInput({ name: fiftyAstralCharacters })
    )

    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.name).toBe(fiftyAstralCharacters)
  })

  it.each([
    validInput({ actor_id: ACTOR_ID }),
    validInput({ group_id: GROUP_ID }),
    validInput({ name: '' }),
    validInput({ avatar_url: '/relative/avatar.png' }),
    validInput({ avatar_url: 'javascript:alert(1)' }),
    validInput({ role_names: { admin: { zh: 'x', en: 'y', role: 'owner' } } }),
    validInput({ rules_json: [{ zh: 'x', en: 'y', approved_by: ACTOR_ID }] }),
    (() => {
      const { description: _description, ...incomplete } = validInput()
      return incomplete
    })(),
  ])('rejects incomplete, invalid, or authority-bearing submit input %#', (input) => {
    expect(groupEditApplicationInputSchema.safeParse(input).success).toBe(false)
  })

  it('keeps approve/reject bodies exact and requires an operation id', () => {
    expect(
      approveGroupEditApplicationInputSchema.safeParse({ operation_id: OPERATION_ID }).success
    ).toBe(true)
    expect(approveGroupEditApplicationInputSchema.safeParse({}).success).toBe(false)
    expect(
      approveGroupEditApplicationInputSchema.safeParse({
        operation_id: OPERATION_ID,
        reviewer_id: ACTOR_ID,
      }).success
    ).toBe(false)
    expect(
      rejectGroupEditApplicationInputSchema.parse({
        operation_id: OPERATION_ID,
        reason: '  Cafe\u0301  ',
      }).reason
    ).toBe('Café')
    expect(
      rejectGroupEditApplicationInputSchema.safeParse({
        operation_id: OPERATION_ID,
        reason: '😀'.repeat(501),
      }).success
    ).toBe(false)
  })

  it('accepts only a complete, canonical submit result without extra fields', () => {
    const valid = {
      status: 'submitted',
      operation_id: OPERATION_ID,
      application: validSnapshot(),
      applied: true,
    }
    expect(submitGroupEditApplicationResultSchema.safeParse(valid).success).toBe(true)
    expect(
      submitGroupEditApplicationResultSchema.safeParse({ ...valid, reviewer_id: ACTOR_ID }).success
    ).toBe(false)
    expect(
      submitGroupEditApplicationResultSchema.safeParse({
        ...valid,
        application: validSnapshot({ avatar_url: '/relative.png' }),
      }).success
    ).toBe(false)
    expect(
      submitGroupEditApplicationResultSchema.safeParse({
        ...valid,
        operation_id: OPERATION_ID.toUpperCase(),
      }).success
    ).toBe(false)
  })

  it('keeps review result variants exact and decision-specific', () => {
    const common = {
      operation_id: OPERATION_ID,
      application_id: APPLICATION_ID,
      applicant_id: ACTOR_ID,
      group_id: GROUP_ID,
      group_name: 'Atomic Group',
      reviewed_at: CREATED_AT,
      applied: true,
    }
    expect(
      reviewGroupEditApplicationResultSchema.safeParse({ status: 'approved', ...common }).success
    ).toBe(true)
    expect(
      reviewGroupEditApplicationResultSchema.safeParse({
        status: 'rejected',
        ...common,
        reject_reason: null,
      }).success
    ).toBe(true)
    expect(
      reviewGroupEditApplicationResultSchema.safeParse({
        status: 'approved',
        ...common,
        reject_reason: null,
      }).success
    ).toBe(false)
    expect(reviewGroupEditApplicationResultSchema.safeParse({ status: 'root' }).success).toBe(false)
  })
})
