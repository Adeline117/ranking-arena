import assert from 'node:assert/strict'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const quizImagesDirectory = resolve(root, 'public/images/quiz')
const quizDataPath = resolve(root, 'app/(quiz)/quiz/components/quiz-data.ts')
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex')
const pngIendTrailer = Buffer.from('0000000049454e44ae426082', 'hex')
const maxPngDimension = 4096
const registryMutators = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
])

function parseDiagnostics(sourceFile) {
  return (sourceFile.parseDiagnostics ?? []).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    if (diagnostic.start === undefined) return message
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
    return `${line + 1}:${character + 1} ${message}`
  })
}

function unwrapExpression(expression) {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function isPersonalityTypesAccess(expression) {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return current.text === 'PERSONALITY_TYPES'
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return isPersonalityTypesAccess(current.expression)
  }
  return false
}

function calledMemberName(expression) {
  const current = unwrapExpression(expression)
  if (ts.isPropertyAccessExpression(current) && isPersonalityTypesAccess(current.expression)) {
    return current.name.text
  }
  if (
    ts.isElementAccessExpression(current) &&
    isPersonalityTypesAccess(current.expression) &&
    current.argumentExpression &&
    ts.isStringLiteralLike(current.argumentExpression)
  ) {
    return current.argumentExpression.text
  }
  return undefined
}

function assertNoPersonalityTypesMutations(sourceFile, declaration) {
  const mutations = []
  const declarationEnd = declaration.end

  function record(node, kind) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    mutations.push(`${kind} at ${line + 1}:${character + 1}`)
  }

  function visit(node) {
    if (node.getStart(sourceFile) > declarationEnd) {
      if (
        ts.isBinaryExpression(node) &&
        ts.isAssignmentOperator(node.operatorToken.kind) &&
        isPersonalityTypesAccess(node.left)
      ) {
        record(node, 'assignment')
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        isPersonalityTypesAccess(node.operand)
      ) {
        record(node, 'increment/decrement')
      } else if (ts.isDeleteExpression(node) && isPersonalityTypesAccess(node.expression)) {
        record(node, 'delete')
      } else if (ts.isCallExpression(node)) {
        const memberName = calledMemberName(node.expression)
        if (memberName && registryMutators.has(memberName)) {
          record(node, `${memberName}()`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  assert.equal(
    mutations.length,
    0,
    `PERSONALITY_TYPES must not be mutated after declaration: ${mutations.join('; ')}`
  )
}

function canonicalPersonalityTypeIds(
  source = readFileSync(quizDataPath, 'utf8'),
  fileName = quizDataPath
) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const diagnostics = parseDiagnostics(sourceFile)
  assert.equal(
    diagnostics.length,
    0,
    `${fileName} must have no TypeScript parse diagnostics: ${diagnostics.join('; ')}`
  )

  const declarations = []
  function collectDeclarations(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'PERSONALITY_TYPES'
    ) {
      declarations.push({ declaration: node, statement: node.parent.parent })
    }
    ts.forEachChild(node, collectDeclarations)
  }
  collectDeclarations(sourceFile)

  assert.equal(
    declarations.length,
    1,
    'PERSONALITY_TYPES must be declared exactly once at the top level'
  )
  const [{ declaration, statement }] = declarations
  assert.ok(
    ts.isVariableStatement(statement) && statement.parent === sourceFile,
    'PERSONALITY_TYPES unique declaration must be top-level'
  )
  const exported = statement.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  )
  const declaredConst = Boolean(statement.declarationList.flags & ts.NodeFlags.Const)
  assert.equal(
    exported && declaredConst,
    true,
    'PERSONALITY_TYPES must be declared as exported const'
  )

  const initializer = declaration.initializer
  assert.ok(
    initializer && ts.isArrayLiteralExpression(initializer),
    'PERSONALITY_TYPES initializer must be an array literal'
  )
  assertNoPersonalityTypesMutations(sourceFile, declaration)

  return initializer.elements.map((element, index) => {
    assert.ok(
      ts.isObjectLiteralExpression(element),
      `PERSONALITY_TYPES array element ${index + 1} must be an object literal`
    )

    for (const property of element.properties) {
      assert.equal(
        ts.isSpreadAssignment(property),
        false,
        `PERSONALITY_TYPES element ${index + 1} must not use spread properties`
      )
      assert.equal(
        Boolean(property.name && ts.isComputedPropertyName(property.name)),
        false,
        `PERSONALITY_TYPES element ${index + 1} must not use computed property names`
      )
    }

    const idProperties = element.properties.filter(
      (property) =>
        property.name &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === 'id'
    )
    assert.equal(
      idProperties.length,
      1,
      `PERSONALITY_TYPES element ${index + 1} must have exactly one static id property`
    )
    assert.ok(
      ts.isPropertyAssignment(idProperties[0]),
      `PERSONALITY_TYPES element ${index + 1} id must be a property assignment`
    )
    assert.ok(
      ts.isStringLiteralLike(idProperties[0].initializer),
      `PERSONALITY_TYPES element ${index + 1} id must be a static string literal`
    )
    return idProperties[0].initializer.text
  })
}

function assertPngAsset(contents, path) {
  assert.ok(contents.length >= 33, `${path} must contain a complete 33-byte PNG IHDR chunk`)
  assert.equal(
    contents.subarray(0, pngSignature.length).equals(pngSignature),
    true,
    `${path} must have the eight-byte PNG signature`
  )

  let chunkOffset = pngSignature.length
  let chunkCount = 0
  let ihdrCount = 0
  let idatBytes = 0
  let iendCount = 0

  while (chunkOffset < contents.length) {
    const chunkNumber = chunkCount + 1
    const remaining = contents.length - chunkOffset
    assert.ok(
      remaining >= 12,
      `${path} chunk ${chunkNumber} length/type/data/CRC prefix exceeds the file boundary`
    )

    const dataLength = contents.readUInt32BE(chunkOffset)
    const typeStart = chunkOffset + 4
    const dataStart = typeStart + 4
    const dataEnd = dataStart + dataLength
    const crcEnd = dataEnd + 4
    assert.ok(
      dataStart <= contents.length,
      `${path} chunk ${chunkNumber} type exceeds the boundary`
    )
    assert.ok(dataEnd <= contents.length, `${path} chunk ${chunkNumber} data exceeds the boundary`)
    assert.ok(crcEnd <= contents.length, `${path} chunk ${chunkNumber} CRC exceeds the boundary`)

    const type = contents.subarray(typeStart, dataStart).toString('ascii')
    assert.match(type, /^[A-Za-z]{4}$/, `${path} chunk ${chunkNumber} has an invalid type`)

    if (type === 'IHDR') {
      ihdrCount += 1
      assert.equal(chunkNumber, 1, `${path} IHDR must be the first chunk`)
      assert.equal(dataLength, 13, `${path} must have a 13-byte IHDR chunk`)
      const width = contents.readUInt32BE(dataStart)
      const height = contents.readUInt32BE(dataStart + 4)
      assert.ok(width > 0 && width <= maxPngDimension, `${path} width must be within 1..4096`)
      assert.ok(height > 0 && height <= maxPngDimension, `${path} height must be within 1..4096`)
    } else if (chunkNumber === 1) {
      assert.fail(`${path} must start with IHDR`)
    }

    if (type === 'IDAT') idatBytes += dataLength

    if (type === 'IEND') {
      iendCount += 1
      assert.equal(dataLength, 0, `${path} IEND must have zero data length`)
      assert.equal(crcEnd, contents.length, `${path} IEND must be the final chunk`)
      assert.equal(
        contents.subarray(chunkOffset, crcEnd).equals(pngIendTrailer),
        true,
        `${path} must end with the standard 12-byte IEND trailer`
      )
    }

    const storedCrc = contents.readUInt32BE(dataEnd)
    const computedCrc = crc32(contents.subarray(typeStart, dataEnd))
    assert.equal(storedCrc, computedCrc, `${path} chunk ${chunkNumber} CRC must be valid`)

    chunkOffset = crcEnd
    chunkCount += 1
  }

  assert.equal(ihdrCount, 1, `${path} must contain exactly one IHDR chunk`)
  assert.ok(idatBytes > 0, `${path} must contain non-empty IDAT image data`)
  assert.equal(iendCount, 1, `${path} must contain exactly one IEND chunk`)
}

test('every canonical quiz personality type has exactly one independent PNG', () => {
  const typeIds = canonicalPersonalityTypeIds()
  const uniqueTypeIds = [...new Set(typeIds)]
  const pngIds = readdirSync(quizImagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.png'))
    .map((entry) => {
      assert.equal(entry.isFile(), true, `${entry.name} must be a regular file`)
      const relativePath = `public/images/quiz/${entry.name}`
      assertPngAsset(readFileSync(resolve(root, relativePath)), relativePath)
      return basename(entry.name, '.png')
    })

  assert.equal(typeIds.length, 12, 'the canonical quiz registry must contain 12 personality types')
  assert.equal(uniqueTypeIds.length, typeIds.length, 'quiz personality type IDs must be unique')
  assert.deepEqual(pngIds.sort(), uniqueTypeIds.sort())
})

test('quiz registry AST rejects ambiguous or dynamic definitions', () => {
  const validRegistry = "export const PERSONALITY_TYPES = [{ id: 'x' }]"

  assert.throws(
    () => canonicalPersonalityTypeIds('export const PERSONALITY_TYPES = [', 'broken.ts'),
    /must have no TypeScript parse diagnostics/
  )
  assert.throws(
    () =>
      canonicalPersonalityTypeIds(
        "export let PERSONALITY_TYPES = [{ id: 'x' }]; PERSONALITY_TYPES = []"
      ),
    /must be declared as exported const/
  )
  assert.throws(
    () => canonicalPersonalityTypeIds("const PERSONALITY_TYPES = [{ id: 'x' }]"),
    /must be declared as exported const/
  )
  assert.throws(
    () =>
      canonicalPersonalityTypeIds(
        `${validRegistry}; function shadow() { const PERSONALITY_TYPES = [] }`
      ),
    /must be declared exactly once/
  )
  assert.throws(
    () => canonicalPersonalityTypeIds('export const PERSONALITY_TYPES = registry'),
    /initializer must be an array literal/
  )
  assert.throws(
    () => canonicalPersonalityTypeIds('export const PERSONALITY_TYPES = [...registry]'),
    /array element 1 must be an object literal/
  )
  assert.throws(
    () => canonicalPersonalityTypeIds("export const PERSONALITY_TYPES = [{ id: 'x', ...base }]"),
    /must not use spread properties/
  )
  assert.throws(
    () => canonicalPersonalityTypeIds("export const PERSONALITY_TYPES = [{ ['id']: 'x' }]"),
    /must not use computed property names/
  )
  assert.throws(
    () => canonicalPersonalityTypeIds('export const PERSONALITY_TYPES = [{ id: getId() }]'),
    /id must be a static string literal/
  )
  assert.throws(
    () => canonicalPersonalityTypeIds("export const PERSONALITY_TYPES = [{ id: 'x', id: 'y' }]"),
    /must have exactly one static id property/
  )
  assert.throws(
    () =>
      canonicalPersonalityTypeIds(
        "export const PERSONALITY_TYPES = [{ id() { return 'x' }, id: 'x' }]"
      ),
    /must have exactly one static id property/
  )
  assert.throws(
    () => canonicalPersonalityTypeIds(`${validRegistry}; PERSONALITY_TYPES = []`),
    /must not be mutated after declaration/
  )
  assert.throws(
    () =>
      canonicalPersonalityTypeIds(`${validRegistry}; PERSONALITY_TYPES[0] = { id: 'replacement' }`),
    /must not be mutated after declaration/
  )
  for (const mutator of registryMutators) {
    assert.throws(
      () => canonicalPersonalityTypeIds(`${validRegistry}; PERSONALITY_TYPES.${mutator}()`),
      /must not be mutated after declaration/
    )
  }
  assert.throws(
    () => canonicalPersonalityTypeIds(`${validRegistry}; PERSONALITY_TYPES['push']()`),
    /must not be mutated after declaration/
  )
})

test('quiz PNG validation rejects truncated, spoofed, and unreasonable assets', () => {
  const canonical = readFileSync(resolve(quizImagesDirectory, 'analyst.png'))
  for (const length of [24, 33, 100]) {
    assert.throws(
      () => assertPngAsset(canonical.subarray(0, length), `truncated-${length}.png`),
      /IHDR|IDAT|chunk|IEND/
    )
  }

  const badSignature = Buffer.from(canonical)
  badSignature[0] = 0
  assert.throws(() => assertPngAsset(badSignature, 'bad-signature.png'), /PNG signature/)

  const badIhdr = Buffer.from(canonical)
  badIhdr.write('IDAT', 12, 'ascii')
  assert.throws(() => assertPngAsset(badIhdr, 'bad-ihdr.png'), /start with IHDR/)

  const zeroWidth = Buffer.from(canonical)
  zeroWidth.writeUInt32BE(0, 16)
  assert.throws(() => assertPngAsset(zeroWidth, 'zero-width.png'), /width must be within/)

  const oversizedHeight = Buffer.from(canonical)
  oversizedHeight.writeUInt32BE(maxPngDimension + 1, 20)
  assert.throws(
    () => assertPngAsset(oversizedHeight, 'oversized-height.png'),
    /height must be within/
  )

  const overflowingChunk = Buffer.from(canonical)
  overflowingChunk.writeUInt32BE(0xffffffff, 33)
  assert.throws(() => assertPngAsset(overflowingChunk, 'overflowing-chunk.png'), /data exceeds/)

  assert.throws(() => assertPngAsset(canonical.subarray(0, -1), 'truncated-crc.png'), /boundary/)
  assert.throws(
    () => assertPngAsset(canonical.subarray(0, -pngIendTrailer.length), 'missing-iend.png'),
    /exactly one IEND/
  )

  const badIendTrailer = Buffer.from(canonical)
  badIendTrailer[badIendTrailer.length - 1] ^= 0xff
  assert.throws(
    () => assertPngAsset(badIendTrailer, 'bad-iend-trailer.png'),
    /standard 12-byte IEND trailer/
  )
  assert.throws(
    () => assertPngAsset(Buffer.concat([canonical, pngIendTrailer]), 'duplicate-iend.png'),
    /IEND must be the final chunk/
  )

  const ihdrOnly = Buffer.concat([canonical.subarray(0, 33), pngIendTrailer])
  assert.throws(() => assertPngAsset(ihdrOnly, 'no-idat.png'), /non-empty IDAT/)

  const corruptIdat = Buffer.from(canonical)
  const idatTypeOffset = corruptIdat.indexOf(Buffer.from('IDAT'))
  assert.ok(idatTypeOffset > 0, 'canonical mutation fixture must contain IDAT')
  corruptIdat[idatTypeOffset + 4] ^= 0xff
  assert.throws(() => assertPngAsset(corruptIdat, 'corrupt-idat.png'), /CRC must be valid/)
})

test('retired quiz composite sheets do not return', () => {
  for (const path of [
    'public/images/quiz/types-characters.jpg',
    'public/images/quiz/types-overview.jpg',
  ]) {
    assert.equal(
      lstatSync(resolve(root, path), { throwIfNoEntry: false }),
      undefined,
      `${path} is a retired composite sheet; use the independent personality PNGs`
    )
  }
})
