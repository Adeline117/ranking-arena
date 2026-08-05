export const SOURCE_CATALOG_CONTRACT = 'arena.canonical-baseline-source-catalog@1'

export const SOURCE_CATALOG_KEYS = Object.freeze([
  'acls',
  'columns',
  'constraints',
  'defaultPrivileges',
  'extensions',
  'functions',
  'indexes',
  'policies',
  'publications',
  'schemas',
  'tables',
  'triggers',
  'types',
  'views',
])

const nullableString = Object.freeze({ nullable: true, type: 'string' })
const stringArray = Object.freeze({ arrayOf: 'string' })
const nullableStringArray = Object.freeze({ arrayOf: 'string', nullable: true })

export const SOURCE_CATALOG_ROW_SHAPES = Object.freeze({
  acls: Object.freeze({ acl: 'string', name: 'string', objectKind: 'string', schema: 'string' }),
  columns: Object.freeze({
    defaultExpression: nullableString,
    generated: 'string',
    identity: 'string',
    name: 'string',
    notNull: 'boolean',
    ordinal: 'integer',
    relation: 'string',
    schema: 'string',
    type: 'string',
  }),
  constraints: Object.freeze({
    deferrable: 'boolean',
    definition: 'string',
    domain: 'string',
    initiallyDeferred: 'boolean',
    local: 'boolean',
    name: 'string',
    noInherit: 'boolean',
    objectKind: 'string',
    relation: 'string',
    schema: 'string',
    type: 'string',
    validated: 'boolean',
  }),
  defaultPrivileges: Object.freeze({
    acl: 'string',
    objectType: 'string',
    owner: 'string',
    schema: 'string',
  }),
  extensions: Object.freeze({ name: 'string', schema: 'string', version: 'string' }),
  functions: Object.freeze({
    configuration: nullableStringArray,
    definition: nullableString,
    identityArguments: 'string',
    kind: 'string',
    language: 'string',
    leakproof: 'boolean',
    name: 'string',
    result: nullableString,
    schema: 'string',
    securityDefiner: 'boolean',
    volatility: 'string',
  }),
  indexes: Object.freeze({
    definition: 'string',
    name: 'string',
    primary: 'boolean',
    ready: 'boolean',
    relation: 'string',
    schema: 'string',
    unique: 'boolean',
    valid: 'boolean',
  }),
  policies: Object.freeze({
    command: 'string',
    name: 'string',
    permissive: 'boolean',
    relation: 'string',
    roles: stringArray,
    schema: 'string',
    using: nullableString,
    withCheck: nullableString,
  }),
  publications: Object.freeze({
    allTables: 'boolean',
    columns: stringArray,
    deletes: 'boolean',
    inserts: 'boolean',
    membershipKind: 'string',
    name: 'string',
    relation: 'string',
    rowFilter: nullableString,
    schema: 'string',
    truncates: 'boolean',
    updates: 'boolean',
    viaPartitionRoot: 'boolean',
  }),
  schemas: Object.freeze({ acl: 'string', name: 'string', owner: 'string' }),
  tables: Object.freeze({
    forceRowSecurity: 'boolean',
    kind: 'string',
    name: 'string',
    owner: 'string',
    partitionBound: nullableString,
    persistence: 'string',
    rowSecurity: 'boolean',
    schema: 'string',
  }),
  triggers: Object.freeze({
    definition: 'string',
    enabled: 'string',
    name: 'string',
    relation: 'string',
    schema: 'string',
  }),
  types: Object.freeze({
    baseType: nullableString,
    category: 'string',
    collation: nullableString,
    compositeAttributes: Object.freeze({
      arrayOfObject: Object.freeze({
        collation: nullableString,
        name: 'string',
        ordinal: 'integer',
        type: 'string',
      }),
    }),
    defaultExpression: nullableString,
    enumLabels: stringArray,
    formatted: 'string',
    kind: 'string',
    name: 'string',
    notNull: 'boolean',
    owner: 'string',
    rangeCanonical: nullableString,
    rangeCollation: nullableString,
    rangeSubdiff: nullableString,
    rangeSubtype: nullableString,
    schema: 'string',
  }),
  views: Object.freeze({ definition: 'string', kind: 'string', name: 'string', schema: 'string' }),
})

function failDefault(message) {
  throw new Error(message)
}

function assertExactKeys(value, expected, label, fail) {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    fail(`${label} must be an object`)
  const actualKeys = Object.keys(value).sort()
  const expectedKeys = Object.keys(expected).sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail(`${label} must contain exactly: ${expectedKeys.join(', ')}`)
  }
}

function assertShape(value, descriptor, label, fail) {
  if (typeof descriptor === 'string') {
    if (descriptor === 'integer') {
      if (!Number.isInteger(value)) fail(`${label} must be an integer`)
      return
    }
    if (typeof value !== descriptor) fail(`${label} must be a ${descriptor}`)
    return
  }
  if (value === null && descriptor.nullable) return
  if (descriptor.type) {
    if (typeof value !== descriptor.type) fail(`${label} must be a ${descriptor.type}`)
    return
  }
  if (descriptor.arrayOf) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== descriptor.arrayOf)) {
      fail(`${label} must be an array of ${descriptor.arrayOf} values`)
    }
    return
  }
  if (descriptor.arrayOfObject) {
    if (!Array.isArray(value)) fail(`${label} must be an array`)
    for (const [index, entry] of value.entries()) {
      assertExactKeys(entry, descriptor.arrayOfObject, `${label}[${index}]`, fail)
      for (const [key, nestedDescriptor] of Object.entries(descriptor.arrayOfObject)) {
        assertShape(entry[key], nestedDescriptor, `${label}[${index}].${key}`, fail)
      }
    }
    return
  }
  fail(`${label} has an invalid contract descriptor`)
}

export function validateSourceCatalogRowContracts(catalog, { fail = failDefault } = {}) {
  assertExactKeys(catalog, SOURCE_CATALOG_ROW_SHAPES, 'source-catalog.json catalog', fail)
  for (const key of SOURCE_CATALOG_KEYS) {
    const rows = catalog[key]
    if (!Array.isArray(rows)) fail(`source-catalog.json catalog ${key} must be an array`)
    const shape = SOURCE_CATALOG_ROW_SHAPES[key]
    for (const [index, row] of rows.entries()) {
      const label = `source-catalog.json catalog ${key}[${index}]`
      assertExactKeys(row, shape, label, fail)
      for (const [field, descriptor] of Object.entries(shape)) {
        assertShape(row[field], descriptor, `${label}.${field}`, fail)
      }
      if (key === 'constraints' && !['domain', 'relation'].includes(row.objectKind)) {
        fail(`${label}.objectKind must be domain or relation`)
      }
      if (
        key === 'publications' &&
        !['allTables', 'relation', 'schema'].includes(row.membershipKind)
      ) {
        fail(`${label}.membershipKind is invalid`)
      }
    }
  }
}
