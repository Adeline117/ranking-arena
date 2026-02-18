#!/usr/bin/env node
/**
 * Add metadata exports to pages that don't have them.
 * Only for server-renderable pages (not 'use client' pages that need generateMetadata in layout).
 */
import fs from 'fs'
import path from 'path'

const METADATA_MAP = {
  'app/settings/page.tsx': { title: 'Settings | Arena', desc: 'Manage your Arena account settings.' },
  'app/messages/page.tsx': { title: 'Messages | Arena', desc: 'Your private messages on Arena.' },
  'app/my-posts/page.tsx': { title: 'My Posts | Arena', desc: 'View and manage your posts.' },
  'app/inbox/page.tsx': { title: 'Inbox | Arena', desc: 'Your notifications and updates.' },
  'app/multi-chain/page.tsx': { title: 'Multi-Chain Assets | Arena', desc: 'Track your assets across multiple blockchains.' },
  'app/favorites/page.tsx': { title: 'Bookmarks | Arena', desc: 'Your bookmarked content on Arena.' },
  'app/library/page.tsx': { title: 'Library | Arena', desc: 'Enter. Outperform. Browse trading books, papers, and whitepapers.' },
  'app/groups/page.tsx': { title: 'Groups | Arena', desc: 'Join trading discussion groups on Arena.' },
  'app/groups/apply/page.tsx': { title: 'Create Group | Arena', desc: 'Create a new discussion group on Arena.' },
  'app/kol/apply/page.tsx': { title: 'Apply as KOL | Arena', desc: 'Apply to become a verified KOL on Arena.' },
  'app/status/page.tsx': { title: 'System Status | Arena', desc: 'Arena platform status and health checks.' },
  'app/logout/page.tsx': { title: 'Logout | Arena', desc: 'Sign out of your Arena account.' },
}

for (const [filePath, meta] of Object.entries(METADATA_MAP)) {
  const full = path.resolve(filePath)
  if (!fs.existsSync(full)) { console.log(`SKIP (not found): ${filePath}`); continue }
  
  let content = fs.readFileSync(full, 'utf-8')
  
  if (content.includes('export const metadata') || content.includes('generateMetadata')) {
    console.log(`SKIP (has metadata): ${filePath}`)
    continue
  }
  
  // For 'use client' pages, we can't add metadata export directly
  // Need to add in a separate layout.tsx or skip
  if (content.startsWith("'use client'") || content.startsWith('"use client"')) {
    console.log(`CLIENT: ${filePath} — needs layout.tsx metadata`)
    continue
  }
  
  // Add metadata import and export at the top (after imports)
  const metadataExport = `\nimport type { Metadata } from 'next'\n\nexport const metadata: Metadata = {\n  title: '${meta.title}',\n  description: '${meta.desc}',\n}\n`
  
  // Find the last import line
  const lines = content.split('\n')
  let lastImportIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('import ') || lines[i].startsWith('} from ')) lastImportIdx = i
  }
  
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, metadataExport)
    fs.writeFileSync(full, lines.join('\n'))
    console.log(`ADDED: ${filePath}`)
  } else {
    console.log(`SKIP (no imports): ${filePath}`)
  }
}

console.log('\nDone!')
