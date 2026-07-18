import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deserialize, serialize } from 'node:v8'

const mockDescriptorOpen = jest.fn()
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => mockDescriptorOpen(...args),
  }
})
const actualFsPromises = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises')

import {
  DEX_STRICT_JSON_ERROR_CODES,
  DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE,
  DexStrictJsonDocumentError,
  inspectDexStrictJsonDocument,
  readDexStrictJsonDocument,
  type DexStrictJsonDocumentInput,
  type DexStrictJsonErrorCode,
  type DexStrictJsonSizeProfile,
} from '../lib/dex-strict-json-document'

const DEFAULT_PROFILE: DexStrictJsonSizeProfile = 'acquisition_run_manifest'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

type DescriptorHarness = Readonly<{
  maximumReadBytes?: number
  afterOpen?: (handle: FileHandle) => Promise<void>
  afterFirstRead?: (handle: FileHandle) => Promise<void>
  onRead?: () => void
  onClose?: () => void
}>

type OpenArguments = Parameters<typeof actualFsPromises.open>

function restoreDescriptorOpen(): void {
  mockDescriptorOpen.mockImplementation((...args: OpenArguments) => actualFsPromises.open(...args))
}

function installDescriptorHarness(harness: DescriptorHarness): void {
  const implementation = async (...args: OpenArguments) => {
    const handle = await actualFsPromises.open(...args)
    await harness.afterOpen?.(handle)
    let isFirstRead = true
    return {
      stat: (options: { bigint: true }) => handle.stat(options),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const firstRead = isFirstRead
        isFirstRead = false
        harness.onRead?.()
        const result = await handle.read(
          buffer,
          offset,
          Math.min(length, harness.maximumReadBytes ?? length),
          position
        )
        if (firstRead) await harness.afterFirstRead?.(handle)
        return result
      },
      close: async () => {
        harness.onClose?.()
        await handle.close()
      },
    }
  }
  mockDescriptorOpen.mockImplementation(implementation)
}

describe('DEX same-read strict JSON documents', () => {
  let rootPath: string

  beforeEach(async () => {
    restoreDescriptorOpen()
    rootPath = await mkdtemp(join(tmpdir(), 'arena-dex-strict-json-'))
  })

  afterEach(async () => {
    restoreDescriptorOpen()
    await rm(rootPath, { recursive: true, force: true })
  })

  async function write(relativePath: string, contents: string | Uint8Array): Promise<void> {
    const filePath = join(rootPath, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, contents)
  }

  function input(
    relativePath: string,
    sizeProfile: DexStrictJsonSizeProfile = DEFAULT_PROFILE
  ): DexStrictJsonDocumentInput {
    return { rootPath, relativePath, sizeProfile }
  }

  function readUntyped(value: unknown): Promise<unknown> {
    return Reflect.apply(readDexStrictJsonDocument, undefined, [value]) as Promise<unknown>
  }

  async function expectCode(
    promise: Promise<unknown>,
    code: DexStrictJsonErrorCode
  ): Promise<void> {
    await expect(promise).rejects.toMatchObject({
      name: 'DexStrictJsonDocumentError',
      code,
    })
  }

  it('hashes and strictly parses one exact immutable byte snapshot', async () => {
    const originalBytes = Buffer.from('{"list":[true,null],"nested":{"count":1}}', 'utf8')
    await write('nested/manifest.json', originalBytes)

    const token = await readDexStrictJsonDocument(input('nested/manifest.json'))
    const first = inspectDexStrictJsonDocument(token)
    const second = inspectDexStrictJsonDocument(token)

    expect(first).toEqual({
      declared_size_profile: DEFAULT_PROFILE,
      raw_sha256: sha256(originalBytes),
      byte_length: originalBytes.byteLength,
      value: {
        list: [true, null],
        nested: { count: 1 },
      },
    })
    expect(first).not.toBe(second)
    expect(first.value).not.toBe(second.value)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.value)).toBe(true)
    const value = first.value as { list: readonly unknown[]; nested: { count: number } }
    expect(Object.isFrozen(value.list)).toBe(true)
    expect(Object.isFrozen(value.nested)).toBe(true)

    await write('nested/manifest.json', '{"replacement":true}')
    expect(inspectDexStrictJsonDocument(token)).toEqual(first)
    const replacement = inspectDexStrictJsonDocument(
      await readDexStrictJsonDocument(input('nested/manifest.json'))
    )
    expect(replacement.raw_sha256).not.toBe(first.raw_sha256)
    expect(replacement.value).toEqual({ replacement: true })
  })

  it('keeps raw-byte identity separate from parsed JSON equivalence', async () => {
    const compact = Buffer.from('{"value":1}', 'utf8')
    const formatted = Buffer.from('{\n  "value": 1\n}\n', 'utf8')
    await write('compact.json', compact)
    await write('formatted.json', formatted)

    const compactDocument = inspectDexStrictJsonDocument(
      await readDexStrictJsonDocument(input('compact.json'))
    )
    const formattedDocument = inspectDexStrictJsonDocument(
      await readDexStrictJsonDocument(input('formatted.json'))
    )

    expect(compactDocument.value).toEqual(formattedDocument.value)
    expect(compactDocument.raw_sha256).toBe(sha256(compact))
    expect(formattedDocument.raw_sha256).toBe(sha256(formatted))
    expect(compactDocument.raw_sha256).not.toBe(formattedDocument.raw_sha256)
  })

  it('loops over deterministic short reads and always closes the descriptor', async () => {
    const bytes = Buffer.from('{"nested":{"value":"short-read-proof"}}', 'utf8')
    await write('short-read.json', bytes)
    let readCalls = 0
    let closeCalls = 0
    installDescriptorHarness({
      maximumReadBytes: 2,
      onRead: () => {
        readCalls += 1
      },
      onClose: () => {
        closeCalls += 1
      },
    })
    try {
      const inspection = inspectDexStrictJsonDocument(
        await readDexStrictJsonDocument(input('short-read.json'))
      )
      expect(inspection.raw_sha256).toBe(sha256(bytes))
      expect(inspection.value).toEqual({ nested: { value: 'short-read-proof' } })
      expect(readCalls).toBeGreaterThan(bytes.byteLength / 2)
      expect(closeCalls).toBe(1)
    } finally {
      restoreDescriptorOpen()
    }
  })

  it.each([
    [
      'growth',
      async (filePath: string) => {
        await appendFile(filePath, ' ')
      },
    ],
    [
      'shrink',
      async (filePath: string) => {
        await truncate(filePath, 2)
      },
    ],
    [
      'same-size metadata change',
      async (filePath: string) => {
        await utimes(filePath, 1, 1)
      },
    ],
  ])('rejects a %s during the descriptor read and still closes it', async (_, mutate) => {
    const relativePath = 'mutating.json'
    const filePath = join(rootPath, relativePath)
    await write(relativePath, '{"value":"original"}')
    let closeCalls = 0
    installDescriptorHarness({
      afterFirstRead: async () => mutate(filePath),
      onClose: () => {
        closeCalls += 1
      },
    })
    try {
      await expectCode(readDexStrictJsonDocument(input(relativePath)), 'FILE_CHANGED_DURING_READ')
      expect(closeCalls).toBe(1)
    } finally {
      restoreDescriptorOpen()
    }
  })

  it('keeps reading the opened inode when its pathname is replaced', async () => {
    const originalBytes = Buffer.from('{"value":"opened-descriptor"}', 'utf8')
    const replacementBytes = Buffer.from('{"value":"replacement-path"}', 'utf8')
    const relativePath = 'replaceable.json'
    const filePath = join(rootPath, relativePath)
    const movedPath = join(rootPath, 'opened-inode.json')
    await write(relativePath, originalBytes)
    let closeCalls = 0
    installDescriptorHarness({
      afterOpen: async () => {
        await rename(filePath, movedPath)
        await writeFile(filePath, replacementBytes)
      },
      onClose: () => {
        closeCalls += 1
      },
    })
    try {
      const inspection = inspectDexStrictJsonDocument(
        await readDexStrictJsonDocument(input(relativePath))
      )
      expect(inspection.raw_sha256).toBe(sha256(originalBytes))
      expect(inspection.value).toEqual({ value: 'opened-descriptor' })
      expect(closeCalls).toBe(1)
    } finally {
      restoreDescriptorOpen()
    }

    const replacement = inspectDexStrictJsonDocument(
      await readDexStrictJsonDocument(input(relativePath))
    )
    expect(replacement.raw_sha256).toBe(sha256(replacementBytes))
    expect(replacement.value).toEqual({ value: 'replacement-path' })
  })

  it('closes the descriptor when a read hook fails unexpectedly', async () => {
    await write('read-failure.json', '{"value":true}')
    let closeCalls = 0
    installDescriptorHarness({
      afterFirstRead: async () => {
        throw new Error('simulated descriptor failure')
      },
      onClose: () => {
        closeCalls += 1
      },
    })
    try {
      await expectCode(readDexStrictJsonDocument(input('read-failure.json')), 'FILE_READ_FAILED')
      expect(closeCalls).toBe(1)
    } finally {
      restoreDescriptorOpen()
    }
  })

  it('mints an identity-bound token that copies and serialization cannot forge', async () => {
    await write('manifest.json', '{}')
    const token = await readDexStrictJsonDocument(input('manifest.json'))

    expect(Object.getPrototypeOf(token)).toBeNull()
    expect(Object.keys(token)).toEqual([])
    expect(Object.getOwnPropertySymbols(token)).toEqual([])
    expect(Object.isFrozen(token)).toBe(true)
    expect(() => JSON.stringify(token)).toThrow(/not serializable/)
    expect(() => inspectDexStrictJsonDocument({})).toThrow(/strict JSON document token/)
    expect(() => inspectDexStrictJsonDocument({ ...token })).toThrow(/strict JSON document token/)
    expect(() => inspectDexStrictJsonDocument(Object.create(token))).toThrow(
      /strict JSON document token/
    )
    expect(() => inspectDexStrictJsonDocument(inspectDexStrictJsonDocument(token))).toThrow(
      /strict JSON document token/
    )

    const serializedClone: unknown = deserialize(serialize(token))
    expect(() => inspectDexStrictJsonDocument(serializedClone)).toThrow(
      /strict JSON document token/
    )
    const descriptorCopy = Object.create(null) as object
    Object.defineProperties(descriptorCopy, Object.getOwnPropertyDescriptors(token))
    expect(() => inspectDexStrictJsonDocument(descriptorCopy)).toThrow(/strict JSON document token/)
  })

  it.each([
    ['same object', '{"a":1,"a":2}'],
    ['nested object', '{"outer":{"a":1,"a":2}}'],
    ['escape-equivalent keys', '{"a":1,"\\u0061":2}'],
  ])('rejects %s duplicate keys before native JSON semantics can erase them', async (_, text) => {
    await write('duplicate.json', text)
    await expectCode(readDexStrictJsonDocument(input('duplicate.json')), 'INVALID_STRICT_JSON')
  })

  it.each([
    ['comments', '{"value":1//comment\n}'],
    ['trailing comma', '{"value":1,}'],
    ['multiple roots', '{}{}'],
    ['empty input', ''],
    ['non-JSON whitespace', '\u00a0{}'],
    ['non-finite numeric result', '{"value":1e400}'],
    ['negative zero', '{"value":-0}'],
    ['isolated escaped surrogate', '{"value":"\\ud800"}'],
  ])('rejects %s as strict JSON', async (_, text) => {
    await write('invalid.json', text)
    await expectCode(readDexStrictJsonDocument(input('invalid.json')), 'INVALID_STRICT_JSON')
  })

  it('rejects JSON nested beyond the shared evidence-parser depth limit', async () => {
    const depth = 130
    await write('deep.json', `${'['.repeat(depth)}0${']'.repeat(depth)}`)
    await expectCode(readDexStrictJsonDocument(input('deep.json')), 'INVALID_STRICT_JSON')
  })

  it('rejects invalid UTF-8 before JSON parsing', async () => {
    await write('invalid-utf8.json', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d]))
    await expectCode(readDexStrictJsonDocument(input('invalid-utf8.json')), 'INVALID_UTF8')
  })

  it.each([
    ['UTF-8', Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])],
    ['UTF-16 BE', Buffer.from([0xfe, 0xff, 0x00, 0x7b, 0x00, 0x7d])],
    ['UTF-16 LE', Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00])],
    ['UTF-32 BE', Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x7b])],
    ['UTF-32 LE', Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x7b, 0x00, 0x00, 0x00])],
  ])('rejects a %s BOM rather than silently changing byte identity', async (_, bytes) => {
    await write('bom.json', bytes)
    await expectCode(readDexStrictJsonDocument(input('bom.json')), 'BOM_REJECTED')
  })

  it('freezes safe positive code-owned byte caps and the stable error-code list', () => {
    const originalManifestCap = DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE.acquisition_run_manifest
    expect(Object.isFrozen(DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE)).toBe(true)
    expect(Object.isFrozen(DEX_STRICT_JSON_ERROR_CODES)).toBe(true)
    expect(Object.isExtensible(DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE)).toBe(false)
    expect(
      Reflect.set(
        DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE,
        'acquisition_run_manifest',
        Number.MAX_SAFE_INTEGER
      )
    ).toBe(false)
    expect(
      Reflect.defineProperty(DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE, 'unbounded_profile', {
        value: Number.MAX_SAFE_INTEGER,
      })
    ).toBe(false)
    expect(DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE.acquisition_run_manifest).toBe(originalManifestCap)
    expect(
      Object.prototype.hasOwnProperty.call(
        DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE,
        'unbounded_profile'
      )
    ).toBe(false)
    for (const maximumBytes of Object.values(DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE)) {
      expect(Number.isSafeInteger(maximumBytes)).toBe(true)
      expect(maximumBytes).toBeGreaterThan(0)
      expect(maximumBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    }
  })

  it('accepts the exact cap and applies different caller-declared size profiles', async () => {
    const manifestMaximum = DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE.acquisition_run_manifest
    const exactlyAtCap = `{"value":"${'a'.repeat(manifestMaximum - 12)}"}`
    expect(Buffer.byteLength(exactlyAtCap)).toBe(manifestMaximum)
    await write('exact-cap.json', exactlyAtCap)

    const exactDocument = inspectDexStrictJsonDocument(
      await readDexStrictJsonDocument(input('exact-cap.json'))
    )
    expect(exactDocument.byte_length).toBe(manifestMaximum)

    const aboveManifestCap = `{"value":"${'b'.repeat(manifestMaximum - 11)}"}`
    expect(Buffer.byteLength(aboveManifestCap)).toBe(manifestMaximum + 1)
    await write('profile-sensitive.json', aboveManifestCap)

    await expectCode(readDexStrictJsonDocument(input('profile-sensitive.json')), 'FILE_TOO_LARGE')
    const transcriptDocument = inspectDexStrictJsonDocument(
      await readDexStrictJsonDocument(input('profile-sensitive.json', 'acquisition_transcript'))
    )
    expect(transcriptDocument).toMatchObject({
      declared_size_profile: 'acquisition_transcript',
      byte_length: manifestMaximum + 1,
    })
  })

  it.each([
    '../outside.json',
    '/absolute.json',
    'nested//manifest.json',
    'nested/../manifest.json',
    'nested\\manifest.json',
    'manifest.txt',
  ])('rejects an ambiguous or escaping relative path: %s', async (relativePath) => {
    await expectCode(readDexStrictJsonDocument(input(relativePath)), 'INVALID_RELATIVE_PATH')
  })

  it('rejects malformed inputs without invoking accessors or leaking proxy failures', async () => {
    const accessorTrap = jest.fn(() => {
      throw new Error('caller-getter-secret')
    })
    const accessorInput = Object.defineProperties(
      {},
      {
        rootPath: { enumerable: true, get: accessorTrap },
        relativePath: { enumerable: true, value: 'manifest.json' },
        sizeProfile: { enumerable: true, value: DEFAULT_PROFILE },
      }
    )
    const hiddenInput = Object.defineProperties(
      {},
      {
        rootPath: { enumerable: false, value: rootPath },
        relativePath: { enumerable: true, value: 'manifest.json' },
        sizeProfile: { enumerable: true, value: DEFAULT_PROFILE },
      }
    )
    const symbolInput = {
      ...input('manifest.json'),
      [Symbol('unexpected')]: true,
    }
    const proxyInput = new Proxy(input('manifest.json'), {
      ownKeys: () => {
        throw new Error('caller-proxy-secret')
      },
    })
    const forgedError = new DexStrictJsonDocumentError('INVALID_INPUT')
    forgedError.message = 'caller-forged-secret'
    const forgedErrorProxyInput = new Proxy(input('manifest.json'), {
      getOwnPropertyDescriptor: () => {
        throw forgedError
      },
    })

    for (const value of [
      undefined,
      null,
      [],
      new Date(),
      { ...input('manifest.json'), extra: true },
      { rootPath, relativePath: 'manifest.json', sizeProfile: 'unknown_profile' },
      accessorInput,
      hiddenInput,
      symbolInput,
      proxyInput,
      forgedErrorProxyInput,
    ]) {
      const rejection = readUntyped(value)
      await expectCode(rejection, 'INVALID_INPUT')
      await expect(rejection).rejects.not.toThrow(/caller-(getter|proxy|forged)-secret/)
    }
    expect(accessorTrap).not.toHaveBeenCalled()
  })

  it('rejects a relative root, a symlink root, and a non-directory root', async () => {
    await expectCode(
      readDexStrictJsonDocument({
        rootPath: '.',
        relativePath: 'manifest.json',
        sizeProfile: DEFAULT_PROFILE,
      }),
      'INVALID_ROOT'
    )
    await expectCode(
      readDexStrictJsonDocument({
        rootPath: join(rootPath, 'missing-root'),
        relativePath: 'manifest.json',
        sizeProfile: DEFAULT_PROFILE,
      }),
      'INVALID_ROOT'
    )

    const realRoot = await mkdtemp(join(tmpdir(), 'arena-dex-strict-real-root-'))
    const linkedRoot = `${realRoot}-link`
    try {
      await writeFile(join(realRoot, 'manifest.json'), '{}')
      await symlink(realRoot, linkedRoot, 'dir')
      await expectCode(
        readDexStrictJsonDocument({
          rootPath: linkedRoot,
          relativePath: 'manifest.json',
          sizeProfile: DEFAULT_PROFILE,
        }),
        'INVALID_ROOT'
      )

      const rootFile = join(rootPath, 'root-file')
      await writeFile(rootFile, '{}')
      await expectCode(
        readDexStrictJsonDocument({
          rootPath: rootFile,
          relativePath: 'manifest.json',
          sizeProfile: DEFAULT_PROFILE,
        }),
        'INVALID_ROOT'
      )
    } finally {
      await rm(linkedRoot, { force: true })
      await rm(realRoot, { recursive: true, force: true })
    }
  })

  it('rejects final and intermediate symlinks before opening artifact bytes', async () => {
    await write('real/manifest.json', '{}')
    await symlink('real/manifest.json', join(rootPath, 'linked.json'))
    await symlink('real', join(rootPath, 'linked-dir'), 'dir')

    await expectCode(readDexStrictJsonDocument(input('linked.json')), 'SYMLINK_REJECTED')
    await expectCode(
      readDexStrictJsonDocument(input('linked-dir/manifest.json')),
      'SYMLINK_REJECTED'
    )
  })

  it('rejects directories and missing paths without echoing local paths', async () => {
    await mkdir(join(rootPath, 'directory.json'))
    await expectCode(readDexStrictJsonDocument(input('directory.json')), 'NOT_REGULAR_FILE')

    const missing = readDexStrictJsonDocument(input('missing.json'))
    await expectCode(missing, 'FILE_READ_FAILED')
    await expect(missing).rejects.not.toThrow(rootPath)
  })

  it('never includes artifact contents in a parse error', async () => {
    const secretMarker = 'do-not-leak-this-api-key'
    await write('secret-invalid.json', `{"api_key":"${secretMarker}",}`)

    let caught: unknown
    try {
      await readDexStrictJsonDocument(input('secret-invalid.json'))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DexStrictJsonDocumentError)
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message).toContain('INVALID_STRICT_JSON')
    expect(message).not.toContain(secretMarker)
    expect(message).not.toContain(rootPath)
    expect(message).not.toContain('api_key')
  })
})
