import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const migrationPath = 'supabase/migrations/00028_add_rules_json.sql'
const migration = readFileSync(join(root, migrationPath), 'utf8')
const createStart = migration.indexOf('CREATE TABLE IF NOT EXISTS public.group_edit_applications')
const createEnd = migration.indexOf(');', createStart)
const tableDefinition = migration.slice(createStart, createEnd)

function sqlFilesUnder(path: string): string[] {
  const absolutePath = join(root, path)

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolutePath, entry.name)
    if (entry.isDirectory()) return sqlFilesUnder(relative(root, child))
    return entry.isFile() && entry.name.endsWith('.sql') ? [relative(root, child)] : []
  })
}

describe('group edit applications fresh-migration baseline', () => {
  it('creates the relation before its first ALTER in the canonical chain', () => {
    const alter = migration.indexOf('ALTER TABLE public.group_edit_applications')

    expect(createStart).toBeGreaterThan(0)
    expect(createEnd).toBeGreaterThan(createStart)
    expect(alter).toBeGreaterThan(createEnd)

    const earlierMigrations = readdirSync(join(root, 'supabase/migrations'))
      .filter((name) => name.endsWith('.sql') && name < '00028_add_rules_json.sql')
      .map((name) => readFileSync(join(root, 'supabase/migrations', name), 'utf8'))
      .join('\n')

    expect(earlierMigrations).not.toMatch(/\bgroup_edit_applications\b/i)
  })

  it('defines every live column, required default, and deletion contract', () => {
    for (const column of [
      /id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/,
      /name text/,
      /name_en text/,
      /description text/,
      /description_en text/,
      /avatar_url text/,
      /rules_json jsonb DEFAULT NULL/,
      /rules text/,
      /role_names jsonb/,
      /is_premium_only boolean/,
      /status text NOT NULL DEFAULT 'pending'/,
      /reject_reason text/,
      /reviewed_at timestamptz/,
      /created_at timestamptz DEFAULT now\(\)/,
    ]) {
      expect(tableDefinition).toMatch(column)
    }

    expect(tableDefinition).toMatch(
      /group_id uuid NOT NULL REFERENCES public\.groups\(id\) ON DELETE CASCADE/
    )
    expect(tableDefinition).toMatch(
      /applicant_id uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/
    )
    expect(tableDefinition).toMatch(
      /reviewed_by uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/
    )
    expect(migration).toContain(
      'ALTER TABLE public.group_edit_applications ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).not.toMatch(/CREATE\s+TRIGGER/i)
  })

  it('has no out-of-band SQL definition that fresh installs must run first', () => {
    const definitions = ['supabase', 'scripts']
      .flatMap(sqlFilesUnder)
      .filter((path) =>
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?group_edit_applications\b/i.test(
          readFileSync(join(root, path), 'utf8')
        )
      )

    expect(definitions).toEqual([migrationPath])
  })
})
