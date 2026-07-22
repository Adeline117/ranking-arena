#!/usr/bin/env node

/**
 * Supabase's generator cannot infer every SQL nullability or read-only view
 * contract. Keep the exceptions explicit and fail closed when the generated
 * AST no longer has the exact shape this postprocessor understands.
 */

import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { validatePostgrestVersion } from './attest-production-types-source.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript')

export const VIEW_OVERRIDES = {
  group_member_directory: {
    group_id: { type: 'string', nullable: false },
    joined_at: { type: 'string', nullable: false },
    role: {
      type: "Database['public']['Enums']['member_role']",
      nullable: false,
    },
    user_id: { type: 'string', nullable: false },
  },
  group_member_moderation_directory: {
    group_id: { type: 'string', nullable: false },
    joined_at: { type: 'string', nullable: false },
    mute_reason: { type: 'string', nullable: true },
    muted_until: { type: 'string', nullable: true },
    role: {
      type: "Database['public']['Enums']['member_role']",
      nullable: false,
    },
    user_id: { type: 'string', nullable: false },
  },
  own_group_memberships: {
    group_id: { type: 'string', nullable: false },
    joined_at: { type: 'string', nullable: false },
    muted_until: { type: 'string', nullable: true },
    pinned: { type: 'boolean', nullable: false },
    role: {
      type: "Database['public']['Enums']['member_role']",
      nullable: false,
    },
    user_id: { type: 'string', nullable: false },
  },
}

export const NULLABLE_RPC_ARGS = {
  activate_group_subscription_atomic: {
    p_checkout_session_id: { type: 'string', optional: false },
    p_currency: { type: 'string', optional: false },
    p_payment_intent_id: { type: 'string', optional: false },
    p_payment_provider: { type: 'string', optional: false },
  },
  activate_lifetime_membership_with_identity_atomic: {
    p_reservation_id: { type: 'string', optional: false },
  },
  activate_recurring_entitlement_payment_atomic: {
    p_stripe_payment_intent_id: { type: 'string', optional: false },
  },
  bind_group_pass_stripe_ownership_atomic: {
    p_payment_member_joined_at: { type: 'string', optional: false },
  },
  bind_stripe_customer_owner_atomic: {
    p_expected_previous_stripe_customer_id: { type: 'string', optional: false },
  },
  can_actor_read_activity_id: {
    p_actor_id: { type: 'string', optional: true },
  },
  can_service_actor_read_activity: {
    p_actor_id: { type: 'string', optional: true },
  },
  claim_stripe_payment_ownership_atomic: {
    p_stripe_payment_intent_id: { type: 'string', optional: false },
  },
  create_group_channel_atomic: {
    p_description: { type: 'string', optional: false },
  },
  finish_stripe_entitlement_effect_atomic: {
    p_error: { type: 'string', optional: false },
    p_external_ref: { type: 'string', optional: false },
    p_retry_after_seconds: { type: 'number', optional: false },
  },
  mutate_collection_item_atomic: {
    p_note: { type: 'string', optional: true },
  },
  mutate_user_collection_atomic: {
    p_collection_id: { type: 'string', optional: false },
    p_description: { type: 'string', optional: false },
    p_is_public: { type: 'boolean', optional: false },
    p_name: { type: 'string', optional: false },
  },
  reconcile_due_pro_entitlement_projections_atomic: {
    p_after_user_id: { type: 'string', optional: false },
  },
  reconcile_recurring_subscription_state_atomic: {
    p_canceled_at: { type: 'string', optional: false },
    p_current_invoice_id: { type: 'string', optional: false },
    p_grace_expires_at: { type: 'string', optional: false },
  },
  reconcile_stripe_entitlement_refund_atomic: {
    p_checkout_session_id: { type: 'string', optional: false },
    p_period_end: { type: 'string', optional: false },
    p_stripe_invoice_id: { type: 'string', optional: false },
    p_stripe_payment_intent_id: { type: 'string', optional: false },
    p_stripe_subscription_id: { type: 'string', optional: false },
    p_stripe_subscription_status: { type: 'string', optional: false },
    p_user_id: { type: 'string', optional: false },
  },
  record_charge_refund_tombstone_atomic: {
    p_stripe_payment_intent_id: { type: 'string', optional: false },
    p_user_id: { type: 'string', optional: false },
  },
  record_stripe_manual_review_atomic: {
    p_user_id: { type: 'string', optional: false },
  },
  resolve_content_report_atomic: {
    p_reason: { type: 'string', optional: false },
  },
  reserve_tip_checkout_atomic: {
    p_message: { type: 'string', optional: false },
  },
  release_lifetime_membership_reservation_atomic: {
    p_checkout_session_id: { type: 'string', optional: false },
    p_event_created_at: { type: 'string', optional: false },
    p_event_id: { type: 'string', optional: false },
  },
  review_group_application_atomic: {
    p_operation_id: { type: 'string', optional: true },
    p_reject_reason: { type: 'string', optional: true },
  },
  review_group_edit_application_atomic: {
    p_reject_reason: { type: 'string', optional: false },
  },
  submit_group_application_atomic: {
    p_avatar_url: { type: 'string', optional: true },
    p_description: { type: 'string', optional: true },
    p_description_en: { type: 'string', optional: true },
    p_name_en: { type: 'string', optional: true },
    p_operation_id: { type: 'string', optional: true },
    p_role_names: { type: 'Json', optional: true },
    p_rules: { type: 'string', optional: true },
    p_rules_json: { type: 'Json', optional: true },
  },
  submit_group_edit_application_atomic: {
    p_avatar_url: { type: 'string', optional: false },
    p_description: { type: 'string', optional: false },
    p_description_en: { type: 'string', optional: false },
    p_name_en: { type: 'string', optional: false },
    p_role_names: { type: 'Json', optional: false },
    p_rules: { type: 'string', optional: false },
    p_rules_json: { type: 'Json', optional: false },
  },
  toggle_post_bookmark_atomic: {
    p_folder_id: { type: 'string', optional: true },
  },
  upsert_pro_entitlement_grant_atomic: {
    p_expires_at: { type: 'string', optional: false },
  },
}

export const GROUP_CUTOVER_NULLABLE_RPC_ARGS = {
  lock_post_interaction_block_edges: {
    p_target_comment_id: { type: 'string', optional: true },
  },
  moderate_group_member_atomic: {
    p_reason: { type: 'string', optional: true },
  },
  moderate_group_mute_atomic: {
    p_muted_until: { type: 'string', optional: false },
    p_reason: { type: 'string', optional: false },
  },
  mutate_group_join_request_atomic: {
    p_answer_text: { type: 'string', optional: true },
  },
  record_post_impression: {
    p_metadata: { type: 'Json', optional: true },
  },
  send_direct_message_atomic: {
    p_media_name: { type: 'string', optional: true },
    p_media_type: { type: 'string', optional: true },
    p_media_url: { type: 'string', optional: true },
    p_reply_to_id: { type: 'string', optional: true },
  },
  submit_content_report: {
    p_description: { type: 'string', optional: true },
  },
}

// RETURNS TABLE columns do not carry SQL NOT NULL metadata, so the generator
// currently emits every scalar field as non-null. Keep only the columns whose
// function contracts deliberately return NULL in an explicit, reviewed list.
export const NULLABLE_RPC_RETURNS = {
  moderate_report_queue_atomic: {
    author_id: { type: 'string' },
    content_soft_deleted: { type: 'boolean' },
    strike_id: { type: 'string' },
    strike_type: { type: 'string' },
  },
  moderate_report_queue_atomic_v1_internal: {
    author_id: { type: 'string' },
    content_soft_deleted: { type: 'boolean' },
    strike_id: { type: 'string' },
    strike_type: { type: 'string' },
  },
  resolve_content_report_atomic: {
    content_soft_deleted: { type: 'boolean' },
  },
}

const GROUP_CUTOVER_MARKER_TABLE = 'group_mute_operations'

function memberName(member, sourceFile) {
  if (!member.name) return null
  const text = member.name.getText(sourceFile)
  return text.replace(/^['"]|['"]$/g, '')
}

function propertyMap(typeNode, sourceFile, label) {
  if (!ts.isTypeLiteralNode(typeNode)) {
    throw new Error(`${label} is no longer a type literal`)
  }

  const result = new Map()
  for (const member of typeNode.members) {
    if (!ts.isPropertySignature(member)) {
      throw new Error(`${label} contains an unsupported non-property member`)
    }
    const name = memberName(member, sourceFile)
    if (!name) throw new Error(`${label} contains an unnamed property`)
    if (result.has(name)) throw new Error(`${label}.${name} is duplicated`)
    result.set(name, member)
  }
  return result
}

function requiredProperty(properties, name, label) {
  const member = properties.get(name)
  if (!member) throw new Error(`${label}.${name} is missing`)
  if (!member.type) throw new Error(`${label}.${name} has no type`)
  return member
}

function databaseSections(sourceFile) {
  const aliases = sourceFile.statements.filter(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'Database'
  )
  if (aliases.length !== 1) {
    throw new Error(`expected one Database type alias, found ${aliases.length}`)
  }

  const database = propertyMap(aliases[0].type, sourceFile, 'Database')
  const publicMember = requiredProperty(database, 'public', 'Database')
  const publicSchema = propertyMap(publicMember.type, sourceFile, 'Database.public')

  const result = {}
  for (const section of ['Tables', 'Views', 'Functions']) {
    const member = requiredProperty(publicSchema, section, 'Database.public')
    result[section] = propertyMap(member.type, sourceFile, `Database.public.${section}`)
  }
  return {
    Database: database,
    DatabaseAlias: aliases[0],
    ...result,
  }
}

function isNullType(typeNode) {
  return ts.isLiteralTypeNode(typeNode) && typeNode.literal.kind === ts.SyntaxKind.NullKeyword
}

function normalizedTypeText(text) {
  return text.replaceAll('"', "'").replace(/\s+/g, '')
}

function inspectNullableType(typeNode, sourceFile, expectedType, label) {
  const members = ts.isUnionTypeNode(typeNode) ? [...typeNode.types] : [typeNode]
  const nullMembers = members.filter(isNullType)
  const baseMembers = members.filter((member) => !isNullType(member))

  if (nullMembers.length > 1 || baseMembers.length !== 1) {
    throw new Error(`${label} has an unsupported union type`)
  }

  const actualBase = normalizedTypeText(baseMembers[0].getText(sourceFile))
  const expectedBase = normalizedTypeText(expectedType)
  if (actualBase !== expectedBase) {
    throw new Error(`${label} changed type: expected ${expectedType}, found ${actualBase}`)
  }

  return { nullable: nullMembers.length === 1 }
}

function renderViewType(viewMember, sourceFile, fields) {
  const column = sourceFile.getLineAndCharacterOfPosition(viewMember.getStart(sourceFile)).character
  const indent = ' '.repeat(column)
  const rows = Object.entries(fields).map(([name, contract]) => {
    const suffix = contract.nullable ? ' | null' : ''
    return `${indent}    ${name}: ${contract.type}${suffix}`
  })

  return [
    '{',
    `${indent}  Row: {`,
    ...rows,
    `${indent}  }`,
    `${indent}  Relationships: []`,
    `${indent}}`,
  ].join('\n')
}

function collectInternalSupabaseEdit(sourceFile, sections, expectedPostgrestVersion, edits) {
  const version = validatePostgrestVersion(expectedPostgrestVersion)
  const internal = sections.Database.get('__InternalSupabase')

  if (!internal) {
    const publicMember = requiredProperty(sections.Database, 'public', 'Database')
    const position = publicMember.getStart(sourceFile)
    const column = sourceFile.getLineAndCharacterOfPosition(position).character
    const indent = ' '.repeat(column)
    edits.push({
      start: position,
      end: position,
      text: [
        '// Allows to automatically instantiate createClient with right options',
        `${indent}// instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)`,
        `${indent}__InternalSupabase: {`,
        `${indent}  PostgrestVersion: '${version}'`,
        `${indent}}`,
        indent,
      ].join('\n'),
      label: '__InternalSupabase insertion',
    })
    return
  }

  if (internal.questionToken) {
    throw new Error('Database.__InternalSupabase became optional')
  }
  const internalProperties = propertyMap(internal.type, sourceFile, 'Database.__InternalSupabase')
  if (internalProperties.size !== 1) {
    throw new Error('Database.__InternalSupabase field set changed')
  }

  const postgrestVersion = requiredProperty(
    internalProperties,
    'PostgrestVersion',
    'Database.__InternalSupabase'
  )
  if (postgrestVersion.questionToken) {
    throw new Error('Database.__InternalSupabase.PostgrestVersion became optional')
  }
  if (
    !ts.isLiteralTypeNode(postgrestVersion.type) ||
    !ts.isStringLiteral(postgrestVersion.type.literal)
  ) {
    throw new Error('Database.__InternalSupabase.PostgrestVersion is no longer a string literal')
  }

  const actualVersion = validatePostgrestVersion(postgrestVersion.type.literal.text)
  if (actualVersion !== version) {
    throw new Error(
      `Database.__InternalSupabase.PostgrestVersion mismatch: expected ${version}, found ${actualVersion}`
    )
  }
}

function collectViewEdits(sourceFile, sections, edits) {
  for (const [viewName, expectedFields] of Object.entries(VIEW_OVERRIDES)) {
    const view = requiredProperty(sections.Views, viewName, 'Database.public.Views')
    const viewProperties = propertyMap(view.type, sourceFile, `Database.public.Views.${viewName}`)
    const allowed = new Set(['Row', 'Insert', 'Update', 'Relationships'])
    for (const propertyName of viewProperties.keys()) {
      if (!allowed.has(propertyName)) {
        throw new Error(`Database.public.Views.${viewName}.${propertyName} is unexpected`)
      }
    }

    const row = requiredProperty(viewProperties, 'Row', `Database.public.Views.${viewName}`)
    const rowProperties = propertyMap(row.type, sourceFile, `Database.public.Views.${viewName}.Row`)
    if (rowProperties.size !== Object.keys(expectedFields).length) {
      throw new Error(`Database.public.Views.${viewName}.Row field set changed`)
    }

    let needsReplacement = viewProperties.has('Insert') || viewProperties.has('Update')

    for (const [fieldName, contract] of Object.entries(expectedFields)) {
      const field = requiredProperty(
        rowProperties,
        fieldName,
        `Database.public.Views.${viewName}.Row`
      )
      if (field.questionToken) {
        throw new Error(`Database.public.Views.${viewName}.Row.${fieldName} became optional`)
      }
      const actual = inspectNullableType(
        field.type,
        sourceFile,
        contract.type,
        `Database.public.Views.${viewName}.Row.${fieldName}`
      )
      if (actual.nullable !== contract.nullable) needsReplacement = true
    }

    const relationships = requiredProperty(
      viewProperties,
      'Relationships',
      `Database.public.Views.${viewName}`
    )
    if (!ts.isTupleTypeNode(relationships.type)) {
      throw new Error(`Database.public.Views.${viewName}.Relationships changed shape`)
    }
    if (relationships.type.elements.length !== 0) needsReplacement = true

    if (needsReplacement) {
      edits.push({
        start: view.type.getStart(sourceFile),
        end: view.type.getEnd(),
        text: renderViewType(view, sourceFile, expectedFields),
        label: `view ${viewName}`,
      })
    }
  }
}

function collectRpcEdits(sourceFile, functions, manifest, edits) {
  for (const [functionName, expectedArgs] of Object.entries(manifest)) {
    const fn = requiredProperty(functions, functionName, 'Database.public.Functions')
    const fnProperties = propertyMap(
      fn.type,
      sourceFile,
      `Database.public.Functions.${functionName}`
    )
    const args = requiredProperty(fnProperties, 'Args', `Database.public.Functions.${functionName}`)
    const argProperties = propertyMap(
      args.type,
      sourceFile,
      `Database.public.Functions.${functionName}.Args`
    )

    for (const [argName, contract] of Object.entries(expectedArgs)) {
      const arg = requiredProperty(
        argProperties,
        argName,
        `Database.public.Functions.${functionName}.Args`
      )
      if (Boolean(arg.questionToken) !== contract.optional) {
        throw new Error(
          `Database.public.Functions.${functionName}.Args.${argName} optional marker changed`
        )
      }
      const actual = inspectNullableType(
        arg.type,
        sourceFile,
        contract.type,
        `Database.public.Functions.${functionName}.Args.${argName}`
      )
      if (!actual.nullable) {
        edits.push({
          start: arg.type.getEnd(),
          end: arg.type.getEnd(),
          text: ' | null',
          label: `RPC ${functionName}.${argName}`,
        })
      }
    }
  }
}

function collectRpcReturnEdits(sourceFile, functions, manifest, edits) {
  for (const [functionName, expectedReturns] of Object.entries(manifest)) {
    const fn = requiredProperty(functions, functionName, 'Database.public.Functions')
    const fnProperties = propertyMap(
      fn.type,
      sourceFile,
      `Database.public.Functions.${functionName}`
    )
    const returns = requiredProperty(
      fnProperties,
      'Returns',
      `Database.public.Functions.${functionName}`
    )
    if (!ts.isArrayTypeNode(returns.type) || !ts.isTypeLiteralNode(returns.type.elementType)) {
      throw new Error(
        `Database.public.Functions.${functionName}.Returns is no longer a table row array`
      )
    }
    const returnProperties = propertyMap(
      returns.type.elementType,
      sourceFile,
      `Database.public.Functions.${functionName}.Returns[]`
    )

    for (const [fieldName, contract] of Object.entries(expectedReturns)) {
      const field = requiredProperty(
        returnProperties,
        fieldName,
        `Database.public.Functions.${functionName}.Returns[]`
      )
      if (field.questionToken) {
        throw new Error(
          `Database.public.Functions.${functionName}.Returns[].${fieldName} became optional`
        )
      }
      const actual = inspectNullableType(
        field.type,
        sourceFile,
        contract.type,
        `Database.public.Functions.${functionName}.Returns[].${fieldName}`
      )
      if (!actual.nullable) {
        edits.push({
          start: field.type.getEnd(),
          end: field.type.getEnd(),
          text: ' | null',
          label: `RPC return ${functionName}.${fieldName}`,
        })
      }
    }
  }
}

function applyEdits(sourceText, edits) {
  const ordered = [...edits].sort((left, right) => {
    if (left.start !== right.start) return right.start - left.start
    return right.end - left.end
  })

  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].start < ordered[index].end) {
      throw new Error(
        `semantic type edits overlap: ${ordered[index - 1].label} and ${ordered[index].label}`
      )
    }
  }

  return ordered.reduce(
    (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
    sourceText
  )
}

export function postprocessDatabaseTypes(
  sourceText,
  fileName = 'database.types.ts',
  expectedPostgrestVersion
) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const parseDiagnostics = sourceFile.parseDiagnostics ?? []
  if (parseDiagnostics.length > 0) {
    throw new Error(`generated database types contain ${parseDiagnostics.length} parse errors`)
  }

  const sections = databaseSections(sourceFile)
  const edits = []
  collectInternalSupabaseEdit(sourceFile, sections, expectedPostgrestVersion, edits)
  collectViewEdits(sourceFile, sections, edits)
  collectRpcEdits(sourceFile, sections.Functions, NULLABLE_RPC_ARGS, edits)
  collectRpcReturnEdits(sourceFile, sections.Functions, NULLABLE_RPC_RETURNS, edits)

  const cutoverFunctionNames = Object.keys(GROUP_CUTOVER_NULLABLE_RPC_ARGS)
  const presentCutoverFunctions = cutoverFunctionNames.filter((name) =>
    sections.Functions.has(name)
  )
  const cutoverActive = sections.Tables.has(GROUP_CUTOVER_MARKER_TABLE)
  if (cutoverActive) {
    collectRpcEdits(sourceFile, sections.Functions, GROUP_CUTOVER_NULLABLE_RPC_ARGS, edits)
  } else if (presentCutoverFunctions.length > 0) {
    throw new Error(
      `partial group cutover schema: ${presentCutoverFunctions.join(', ')} exist without ${GROUP_CUTOVER_MARKER_TABLE}`
    )
  }

  return applyEdits(sourceText, edits)
}

function runCli() {
  const input = process.argv[2]
  const output = process.argv[3] ?? input
  if (!input) {
    throw new Error('usage: node scripts/postprocess-database-types.mjs <input> [output]')
  }

  const source = readFileSync(input, 'utf8')
  const processed = postprocessDatabaseTypes(source, input, process.env.POSTGREST_VERSION)
  const tempDirectory = mkdtempSync(join(dirname(resolve(output)), '.database-types-postprocess.'))
  const temp = join(tempDirectory, 'database.types.ts')
  try {
    writeFileSync(temp, processed, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    chmodSync(temp, 0o644)
    renameSync(temp, output)
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli()
  } catch (error) {
    console.error(`[database-types] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
