import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  isDocumentationMarkdownPath,
  markdownLinkTargets,
  resolveRepositoryLink,
  trackedDocumentationPaths,
  trackedRepositoryPaths,
} from './documentation-links.mjs'

test('supports governed Markdown links and ignores code examples', () => {
  const markdown = [
    '[balanced](./guide_(v2_(final)).md#checks "Current checks")',
    '[full][guide   REF]',
    '[Collapsed][]',
    '[shortcut]',
    '[angle](<./folder/with space.markdown>)',
    '[escaped destination](./guide_\\(legacy\\).md)',
    '[![inline image](./images/logo_\\(dark\\).png)](./gallery_(v2).md)',
    '[![reference image][logo asset]][image page]',
    '![standalone reference image][logo asset]',
    '`[inline code](./missing-inline.md)`',
    '```md',
    '[fenced](./missing-fenced.md)',
    '[fenced-ref]: ./missing-reference.md',
    '```',
    '   ~~~md',
    '   [three-space fenced](./missing-three-space.md)',
    '   ~~~',
    '> ```md',
    '> [container example](./container-example.md)',
    '> ```',
    '[after blockquote](./after-blockquote.md)',
    '\\[escaped](./missing-escaped.md)',
    '[external](https://example.com/a_(b))',
    '[anchor](#section)',
    '[Guide Ref]: ./reference.MD "Reference title"',
    '[collapsed]: <./collapsed path.Markdown>',
    '[shortcut]: ./shortcut.md',
    '[logo asset]: ./images/logo.svg',
    '[image page]: ./image-page.md',
  ].join('\n')

  assert.deepEqual(markdownLinkTargets(markdown), [
    './guide_(v2_(final)).md#checks',
    './reference.MD',
    './collapsed path.Markdown',
    './shortcut.md',
    './folder/with space.markdown',
    './guide_(legacy).md',
    './images/logo_(dark).png',
    './gallery_(v2).md',
    './images/logo.svg',
    './image-page.md',
    './images/logo.svg',
    './container-example.md',
    './after-blockquote.md',
  ])
})

test('checks unsupported fence contents and following prose', () => {
  const fixtures = [
    {
      markdown: [
        '- ```md',
        '  [inside unordered backtick](./inside-unordered-backtick.md)',
        '  ````',
        '[after unordered backtick](./after-unordered-backtick.md)',
      ].join('\n'),
      name: 'unordered backtick fence',
      targets: ['./inside-unordered-backtick.md', './after-unordered-backtick.md'],
    },
    {
      markdown: [
        '- ~~~md',
        '  [inside unordered tilde](./inside-unordered-tilde.md)',
        '  ~~~',
        '[after unordered tilde](./after-unordered-tilde.md)',
      ].join('\n'),
      name: 'unordered tilde fence',
      targets: ['./inside-unordered-tilde.md', './after-unordered-tilde.md'],
    },
    {
      markdown: [
        '1. ````md',
        '   [inside ordered backtick](./inside-ordered-backtick.md)',
        '   `````',
        '[after ordered backtick](./after-ordered-backtick.md)',
      ].join('\n'),
      name: 'ordered backtick fence',
      targets: ['./inside-ordered-backtick.md', './after-ordered-backtick.md'],
    },
    {
      markdown: [
        '1. ~~~~md',
        '   [inside ordered tilde](./inside-ordered-tilde.md)',
        '   ~~~~~',
        '[after ordered tilde](./after-ordered-tilde.md)',
      ].join('\n'),
      name: 'ordered tilde fence',
      targets: ['./inside-ordered-tilde.md', './after-ordered-tilde.md'],
    },
    {
      markdown: [
        '- ````md',
        '  ```',
        '  [inside short close](./inside-short-close.md)',
        '  ```',
        '[after short close](./after-short-close.md)',
      ].join('\n'),
      name: 'short closing markers do not mask the remainder',
      targets: ['./inside-short-close.md', './after-short-close.md'],
    },
    {
      markdown: [
        '- ```md',
        '  [inside unclosed fence](./inside-unclosed-fence.md)',
        '[after unclosed fence](./after-unclosed-fence.md)',
      ].join('\n'),
      name: 'unclosed container fences do not mask the remainder',
      targets: ['./inside-unclosed-fence.md', './after-unclosed-fence.md'],
    },
    {
      markdown: [
        '- ```md',
        '  ~~~',
        '  [inside wrong close](./inside-wrong-close.md)',
        '  ~~~',
        '[after wrong close](./after-wrong-close.md)',
      ].join('\n'),
      name: 'wrong closing characters do not mask the remainder',
      targets: ['./inside-wrong-close.md', './after-wrong-close.md'],
    },
    {
      markdown: [
        '    ```md',
        '    [inside four-space backtick](./inside-four-space-backtick.md)',
        '    ```',
        '[after four-space backtick](./after-four-space-backtick.md)',
      ].join('\n'),
      name: 'four-space backtick markers remain checked',
      targets: ['./inside-four-space-backtick.md', './after-four-space-backtick.md'],
    },
    {
      markdown: [
        '    ~~~md',
        '    [inside four-space tilde](./inside-four-space-tilde.md)',
        '    ~~~',
        '[after four-space tilde](./after-four-space-tilde.md)',
      ].join('\n'),
      name: 'four-space tilde markers remain checked',
      targets: ['./inside-four-space-tilde.md', './after-four-space-tilde.md'],
    },
  ]

  for (const fixture of fixtures) {
    assert.deepEqual(markdownLinkTargets(fixture.markdown), fixture.targets, fixture.name)
  }
})

function writeFixture(path, contents = '') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function runFixtureGit(repositoryRoot, args) {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`)
}

test('discovers extensions and fails closed at repository boundaries', (t) => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'arena-doc-contract-repository.'))
  const outsideRoot = mkdtempSync(join(tmpdir(), 'arena-doc-contract-outside.'))
  t.after(() => {
    rmSync(repositoryRoot, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
  })

  writeFixture(join(repositoryRoot, 'docs', 'README.md'), '# Fixture\n')
  writeFixture(join(repositoryRoot, 'docs', 'UPPER.MD'), '# Upper\n')
  writeFixture(join(repositoryRoot, 'docs', 'nested', 'reference.Markdown'), '# Reference\n')
  writeFixture(join(repositoryRoot, 'docs', 'not-doc.mdx'), '# MDX\n')
  writeFixture(join(repositoryRoot, 'docs', 'untracked.md'), '# Untracked\n')
  writeFixture(join(repositoryRoot, 'docs', 'untracked-directory', 'file.txt'), 'untracked\n')
  writeFixture(join(repositoryRoot, 'tracked-directory', 'file.txt'), 'tracked\n')
  writeFixture(join(outsideRoot, 'outside.md'), '# Outside\n')
  symlinkSync('UPPER.MD', join(repositoryRoot, 'docs', 'symlink.md'))
  symlinkSync('nested', join(repositoryRoot, 'docs', 'inside-link'), 'dir')
  symlinkSync(outsideRoot, join(repositoryRoot, 'docs', 'outside-link'), 'dir')

  runFixtureGit(repositoryRoot, ['init', '--quiet'])
  runFixtureGit(repositoryRoot, [
    'add',
    '--',
    'docs/README.md',
    'docs/UPPER.MD',
    'docs/nested/reference.Markdown',
    'docs/not-doc.mdx',
    'tracked-directory/file.txt',
  ])

  assert.deepEqual(trackedDocumentationPaths(repositoryRoot), [
    'docs/README.md',
    'docs/UPPER.MD',
    'docs/nested/reference.Markdown',
  ])
  assert.equal(isDocumentationMarkdownPath('docs/guide.MARKDOWN'), true)
  assert.equal(isDocumentationMarkdownPath('docs/guide.mdx'), false)

  const trackedPaths = new Set(trackedRepositoryPaths(repositoryRoot))
  const options = { repositoryRoot, trackedPaths }
  assert.equal(
    resolveRepositoryLink('docs/README.md', './UPPER.MD', options).repositoryPath,
    'docs/UPPER.MD'
  )
  assert.equal(
    resolveRepositoryLink('docs/README.md', '../tracked-directory', options).repositoryPath,
    'tracked-directory'
  )
  assert.throws(
    () => resolveRepositoryLink('docs/README.md', './untracked.md', options),
    /link target must be tracked/
  )
  assert.throws(
    () => resolveRepositoryLink('docs/README.md', './untracked-directory', options),
    /link directory must contain a tracked path/
  )
  assert.throws(
    () => resolveRepositoryLink('docs/README.md', './symlink.md', options),
    /link path component must not be a symlink: docs\/symlink\.md/
  )
  assert.throws(
    () => resolveRepositoryLink('docs/README.md', './inside-link/reference.Markdown', options),
    /link path component must not be a symlink: docs\/inside-link/
  )
  assert.throws(
    () => resolveRepositoryLink('docs/README.md', './outside-link/outside.md', options),
    /link path component must not be a symlink: docs\/outside-link/
  )
  assert.throws(
    () => resolveRepositoryLink('docs/README.md', '../../outside.md', options),
    /link escapes the repository/
  )
  assert.throws(
    () => resolveRepositoryLink('docs/README.md', './bad%ZZ.md', options),
    /invalid percent-encoding/
  )
  assert.throws(
    () => resolveRepositoryLink('docs/README.md', './bad%00.md', options),
    /contains a NUL byte/
  )
  assert.throws(
    () => resolveRepositoryLink('docs/README.md', './missing.md', options),
    /missing local link target/
  )
})
