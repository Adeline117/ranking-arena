/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

describe('post media upload purpose callers', () => {
  it.each([
    ['app/(app)/u/[handle]/new/page.tsx', 'post_image'],
    ['app/(app)/post/[id]/edit/page.tsx', 'post_image'],
    ['app/(app)/groups/[id]/new/page.tsx', 'post_image'],
    ['app/(app)/groups/apply/page.tsx', 'group_avatar'],
  ])('%s sends its exact image lifecycle purpose', (relativePath, purpose) => {
    const caller = source(relativePath)
    const exactPurpose = `formData.append('purpose', '${purpose}')`

    expect(
      caller.match(new RegExp(exactPurpose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))
    ).toHaveLength(1)
    expect(caller).toMatch(
      new RegExp(
        `formData\\.append\\('file',[\\s\\S]{0,160}${exactPurpose.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&'
        )}`
      )
    )
  })
})
