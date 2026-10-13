import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const newPostPageSource = readFileSync(
  join(process.cwd(), 'app/(app)/groups/[id]/new/page.tsx'),
  'utf8'
)
const contentEditorSource = readFileSync(
  join(process.cwd(), 'app/(app)/groups/[id]/new/components/ContentEditor.tsx'),
  'utf8'
)
const typesSource = readFileSync(join(process.cwd(), 'app/(app)/groups/[id]/new/types.ts'), 'utf8')

describe('new group post link-preview V1 containment', () => {
  it('does not request or render a remote link preview for post body URLs', () => {
    expect(newPostPageSource).not.toContain('/api/posts/link-preview')
    expect(newPostPageSource).not.toContain('linkPreview')
    expect(contentEditorSource).not.toContain('LinkPreview')
    expect(contentEditorSource).not.toContain('linkPreview')
    expect(typesSource).not.toContain('LinkPreview')
  })

  it('keeps editor body text wired through to normal post creation', () => {
    expect(newPostPageSource).toContain("const [content, setContent] = useState('')")
    expect(newPostPageSource).toContain('content={content}')
    expect(newPostPageSource).toContain('setContent={setContent}')
    expect(newPostPageSource).toContain('let finalContent = content')
    expect(newPostPageSource).toContain('content: finalContent')
  })

  it('removes the now-unused loading copy from every shipped locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'ko']) {
      const localeSource = readFileSync(join(process.cwd(), `lib/i18n/${locale}.ts`), 'utf8')
      expect(localeSource).not.toContain('fetchingLinkPreview:')
    }
  })
})
