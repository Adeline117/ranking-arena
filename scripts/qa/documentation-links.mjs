import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function isDocumentationMarkdownPath(path) {
  return /\.(?:md|markdown)$/i.test(path)
}

export function trackedRepositoryPaths(repositoryRoot = defaultRepositoryRoot) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || 'tracked repository paths must be discoverable')
  return result.stdout.split('\0').filter(Boolean).sort()
}

export function trackedDocumentationPaths(repositoryRoot = defaultRepositoryRoot) {
  return trackedRepositoryPaths(repositoryRoot).filter(
    (path) => path.startsWith('docs/') && isDocumentationMarkdownPath(path)
  )
}

function isEscaped(source, index) {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function blankRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' '
  }
}

function parseContainerFenceMarker(line) {
  const match = line.match(
    /^((?: {0,3}(?:> ?|(?:[-+*]|\d{1,9}[.)])[ \t]+))+ {0,3})(`{3,}|~{3,})(.*?)\r?$/
  )
  if (!match) return null

  return {
    character: match[2][0],
    container: match[1].includes('>') ? 'blockquote' : 'list',
    continuationIndent: match[1].length,
    length: match[2].length,
    markerOffset: match[1].length,
    remainder: match[3],
  }
}

function parseIndentedFenceMarker(line) {
  const match = line.match(/^( *)(`{3,}|~{3,})(.*?)\r?$/)
  if (!match) return null

  return {
    character: match[2][0],
    indent: match[1].length,
    length: match[2].length,
    markerOffset: match[1].length,
    remainder: match[3],
  }
}

function canOpenFence(marker) {
  return marker.character !== '`' || !marker.remainder.includes('`')
}

function isClosingFence(marker, fence) {
  return (
    marker.character === fence.character &&
    marker.length >= fence.length &&
    /^[ \t]*$/.test(marker.remainder)
  )
}

function isUnsupportedContainerClosing(marker, fence) {
  if (!isClosingFence(marker, fence)) return false
  if (marker.container) return marker.container === fence.container
  return (
    fence.container === 'list' &&
    marker.indent >= fence.continuationIndent &&
    marker.indent <= fence.continuationIndent + 3
  )
}

function maskMarkdownCode(markdown) {
  const characters = markdown.split('')
  let fence = null
  let unsupportedContainerFence = null
  const nonInlineBacktickRuns = new Set()
  let lineStart = 0

  while (lineStart < markdown.length) {
    const newline = markdown.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? markdown.length : newline + 1
    const line = markdown.slice(lineStart, newline === -1 ? markdown.length : newline)

    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*\r?$/)
      blankRange(characters, lineStart, lineEnd)
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) {
        fence = null
      }
    } else if (unsupportedContainerFence) {
      const marker = parseContainerFenceMarker(line) ?? parseIndentedFenceMarker(line)
      if (marker && isUnsupportedContainerClosing(marker, unsupportedContainerFence)) {
        const markerStart = lineStart + marker.markerOffset
        blankRange(characters, markerStart, markerStart + marker.length)
        unsupportedContainerFence = null
      } else if (marker?.character === '`' && canOpenFence(marker)) {
        nonInlineBacktickRuns.add(lineStart + marker.markerOffset)
      }
    } else {
      const containerOpening = parseContainerFenceMarker(line)
      const opening = parseIndentedFenceMarker(line)
      if (containerOpening && canOpenFence(containerOpening)) {
        unsupportedContainerFence = containerOpening
        const markerStart = lineStart + containerOpening.markerOffset
        blankRange(characters, markerStart, markerStart + containerOpening.length)
      } else if (opening && opening.indent <= 3 && canOpenFence(opening)) {
        fence = { character: opening.character, length: opening.length }
        blankRange(characters, lineStart, lineEnd)
      } else if (opening?.character === '`' && canOpenFence(opening)) {
        nonInlineBacktickRuns.add(lineStart + opening.markerOffset)
      }
    }

    lineStart = lineEnd
  }

  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== '`' || isEscaped(characters, index)) continue

    let runLength = 1
    while (characters[index + runLength] === '`') runLength += 1
    if (nonInlineBacktickRuns.has(index)) {
      index += runLength - 1
      continue
    }
    let closingStart = -1
    for (let cursor = index + runLength; cursor < characters.length; ) {
      if (characters[cursor] !== '`' || isEscaped(characters, cursor)) {
        cursor += 1
        continue
      }
      let closingLength = 1
      while (characters[cursor + closingLength] === '`') closingLength += 1
      if (nonInlineBacktickRuns.has(cursor)) {
        cursor += closingLength
        continue
      }
      if (closingLength === runLength) {
        closingStart = cursor
        break
      }
      cursor += closingLength
    }

    if (closingStart !== -1) {
      blankRange(characters, index, closingStart + runLength)
      index = closingStart + runLength - 1
    } else {
      index += runLength - 1
    }
  }

  return characters.join('')
}

function unescapeMarkdownPunctuation(value) {
  return value.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

function normalizeReferenceLabel(label) {
  return unescapeMarkdownPunctuation(label).trim().replace(/\s+/g, ' ').toLowerCase()
}

function findClosingBracket(source, openingIndex) {
  let depth = 0
  for (let cursor = openingIndex; cursor < source.length; cursor += 1) {
    if (isEscaped(source, cursor)) continue
    if (source[cursor] === '[') depth += 1
    else if (source[cursor] === ']') {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return -1
}

function parseBareDestination(source, start) {
  let cursor = start
  let depth = 0
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === '\\' && cursor + 1 < source.length) {
      cursor += 2
      continue
    }
    if (/\s/.test(character) && depth === 0) break
    if (character === '(') depth += 1
    else if (character === ')') {
      if (depth === 0) break
      depth -= 1
    }
    cursor += 1
  }
  if (cursor === start || depth !== 0) return null
  return { end: cursor, target: unescapeMarkdownPunctuation(source.slice(start, cursor)) }
}

function parseAngleDestination(source, start) {
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\n' || source[cursor] === '\r') return null
    if (source[cursor] === '<' && !isEscaped(source, cursor)) return null
    if (source[cursor] === '>' && !isEscaped(source, cursor)) {
      return {
        end: cursor + 1,
        target: unescapeMarkdownPunctuation(source.slice(start + 1, cursor)),
      }
    }
  }
  return null
}

function consumeWhitespace(source, start) {
  let cursor = start
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  return cursor
}

function parseOptionalTitle(source, start) {
  const opener = source[start]
  const closer = opener === '(' ? ')' : opener
  if (!['"', "'", '('].includes(opener)) return null

  let depth = opener === '(' ? 1 : 0
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\' && cursor + 1 < source.length) {
      cursor += 1
      continue
    }
    if (opener === '(' && source[cursor] === '(') depth += 1
    if (source[cursor] !== closer) continue
    if (opener === '(' && --depth > 0) continue
    return cursor + 1
  }
  return null
}

function parseReferenceDestination(source) {
  const start = consumeWhitespace(source, 0)
  const destination =
    source[start] === '<'
      ? parseAngleDestination(source, start)
      : parseBareDestination(source, start)
  if (!destination) return null

  const titleStart = consumeWhitespace(source, destination.end)
  if (titleStart === source.length) return destination.target
  if (titleStart === destination.end) return null
  const titleEnd = parseOptionalTitle(source, titleStart)
  if (titleEnd === null || consumeWhitespace(source, titleEnd) !== source.length) return null
  return destination.target
}

function extractReferenceDefinitions(source) {
  const definitions = new Map()
  const characters = source.split('')
  let lineStart = 0

  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? source.length : newline + 1
    const line = source.slice(lineStart, newline === -1 ? source.length : newline)
    const prefix = line.match(/^ {0,3}\[/)
    if (prefix) {
      const labelStart = prefix[0].length - 1
      const labelEnd = findClosingBracket(line, labelStart)
      if (labelEnd > labelStart + 1 && line[labelEnd + 1] === ':') {
        const label = normalizeReferenceLabel(line.slice(labelStart + 1, labelEnd))
        const target = parseReferenceDestination(line.slice(labelEnd + 2).replace(/\r$/, ''))
        if (label && target !== null) {
          if (!definitions.has(label)) definitions.set(label, target)
          blankRange(characters, lineStart, lineEnd)
        }
      }
    }
    lineStart = lineEnd
  }

  return { definitions, source: characters.join('') }
}

function parseInlineDestination(source, openingIndex) {
  let cursor = consumeWhitespace(source, openingIndex + 1)
  if (source[cursor] === ')') return { end: cursor, target: '' }

  const destination =
    source[cursor] === '<'
      ? parseAngleDestination(source, cursor)
      : parseBareDestination(source, cursor)
  if (!destination) return null

  cursor = consumeWhitespace(source, destination.end)
  if (source[cursor] === ')') return { end: cursor, target: destination.target }
  if (cursor === destination.end) return null

  const titleEnd = parseOptionalTitle(source, cursor)
  if (titleEnd === null) return null
  cursor = consumeWhitespace(source, titleEnd)
  if (source[cursor] !== ')') return null
  return { end: cursor, target: destination.target }
}

function isRepositoryRelativeTarget(target) {
  return (
    target !== '' &&
    !target.startsWith('#') &&
    !target.startsWith('/') &&
    !target.startsWith('//') &&
    !/^[a-z][a-z\d+.-]*:/i.test(target)
  )
}

function isImageOpening(source, openingIndex) {
  const markerIndex = openingIndex - 1
  return markerIndex >= 0 && source[markerIndex] === '!' && !isEscaped(source, markerIndex)
}

function parseLinkOccurrence(source, openingIndex, labelEnd, definitions) {
  const label = source.slice(openingIndex + 1, labelEnd)
  const next = labelEnd + 1
  if (source[next] === '(') {
    const inline = parseInlineDestination(source, next)
    if (inline) return inline
  }

  if (source[next] === '[') {
    const referenceEnd = findClosingBracket(source, next)
    if (referenceEnd !== -1) {
      const explicitReference = source.slice(next + 1, referenceEnd)
      const target = definitions.get(normalizeReferenceLabel(explicitReference || label))
      if (target !== undefined) return { end: referenceEnd, target }
      return null
    }
  }

  const target = definitions.get(normalizeReferenceLabel(label))
  return target === undefined ? null : { end: labelEnd, target }
}

function collectMarkdownLinkTargets(source, definitions, { imagesOnly = false } = {}) {
  const targets = []

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '[' || isEscaped(source, index)) continue
    if (imagesOnly && !isImageOpening(source, index)) continue
    const labelEnd = findClosingBracket(source, index)
    if (labelEnd === -1) continue

    const occurrence = parseLinkOccurrence(source, index, labelEnd, definitions)
    if (!occurrence) continue
    targets.push(
      ...collectMarkdownLinkTargets(source.slice(index + 1, labelEnd), definitions, {
        imagesOnly: true,
      })
    )
    if (isRepositoryRelativeTarget(occurrence.target)) targets.push(occurrence.target)
    index = occurrence.end
  }

  return targets
}

export function markdownLinkTargets(markdown) {
  const masked = maskMarkdownCode(markdown)
  const { definitions, source } = extractReferenceDefinitions(masked)
  return collectMarkdownLinkTargets(source, definitions)
}

function isWithinPath(basePath, candidatePath) {
  const pathFromBase = relative(basePath, candidatePath)
  return (
    pathFromBase === '' ||
    (pathFromBase !== '..' && !pathFromBase.startsWith(`..${sep}`) && !isAbsolute(pathFromBase))
  )
}

function lstatRepositoryTarget(repositoryRoot, absolutePath, sourcePath, target) {
  const pathFromRoot = relative(repositoryRoot, absolutePath)
  const components = pathFromRoot ? pathFromRoot.split(sep) : []
  let candidatePath = repositoryRoot
  let candidateStat

  if (components.length === 0) {
    try {
      return lstatSync(repositoryRoot)
    } catch {
      assert.fail(`${sourcePath} has a missing local link target: ${target}`)
    }
  }

  for (const component of components) {
    candidatePath = join(candidatePath, component)
    try {
      candidateStat = lstatSync(candidatePath)
    } catch {
      assert.fail(`${sourcePath} has a missing local link target: ${target}`)
    }
    assert.ok(
      !candidateStat.isSymbolicLink(),
      `${sourcePath} link path component must not be a symlink: ${relative(
        repositoryRoot,
        candidatePath
      )}`
    )
  }

  return candidateStat
}

export function resolveRepositoryLink(
  sourcePath,
  target,
  {
    repositoryRoot = defaultRepositoryRoot,
    trackedPaths = new Set(trackedRepositoryPaths(repositoryRoot)),
  } = {}
) {
  const encodedPath = target.split(/[?#]/, 1)[0]
  if (!encodedPath) return null

  let decodedPath
  try {
    decodedPath = decodeURIComponent(encodedPath)
  } catch {
    assert.fail(`${sourcePath} contains invalid percent-encoding in link: ${target}`)
  }

  assert.ok(!decodedPath.includes('\0'), `${sourcePath} contains a NUL byte in link: ${target}`)
  const repositoryAbsolutePath = resolve(repositoryRoot)
  const repositoryRealPath = realpathSync(repositoryAbsolutePath)
  const absolutePath = resolve(dirname(resolve(repositoryAbsolutePath, sourcePath)), decodedPath)
  assert.ok(
    isWithinPath(repositoryAbsolutePath, absolutePath),
    `${sourcePath} link escapes the repository: ${target}`
  )

  const targetStat = lstatRepositoryTarget(repositoryAbsolutePath, absolutePath, sourcePath, target)

  const targetRealPath = realpathSync(absolutePath)
  assert.ok(
    isWithinPath(repositoryRealPath, targetRealPath),
    `${sourcePath} link resolves outside the repository: ${target}`
  )

  const repositoryPath = relative(repositoryAbsolutePath, absolutePath).split(sep).join('/')
  if (targetStat.isFile()) {
    assert.ok(
      trackedPaths.has(repositoryPath),
      `${sourcePath} link target must be tracked: ${target}`
    )
  } else if (targetStat.isDirectory()) {
    const descendantPrefix = repositoryPath ? `${repositoryPath}/` : ''
    assert.ok(
      [...trackedPaths].some((path) => path.startsWith(descendantPrefix)),
      `${sourcePath} link directory must contain a tracked path: ${target}`
    )
  } else {
    assert.fail(`${sourcePath} link target must be a regular file or directory: ${target}`)
  }

  return { absolutePath, repositoryPath }
}
