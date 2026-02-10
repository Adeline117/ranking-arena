import pg from "pg";

const pool = new pg.Pool({
  connectionString:
    "postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres",
  max: 3,
});

const BATCH = 20;

async function fetchCoverUrl(sourceUrl: string): Promise<string | null> {
  // Match works (OL...W) or editions (OL...M)
  const worksMatch = sourceUrl.match(/openlibrary\.org\/works\/(OL\d+W)/);
  const editionMatch = sourceUrl.match(/openlibrary\.org\/works\/(OL\d+M)/);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    if (worksMatch) {
      const res = await fetch(`https://openlibrary.org/works/${worksMatch[1]}.json`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = (await res.json()) as { covers?: number[] };
      const covers = data.covers?.filter((c: number) => c > 0) ?? [];
      if (covers.length === 0) return null;
      return `https://covers.openlibrary.org/b/id/${covers[0]}-M.jpg`;
    }

    if (editionMatch) {
      // For editions, try direct OLID cover
      const olid = editionMatch[1];
      // Also fetch JSON to check for cover IDs
      const res = await fetch(`https://openlibrary.org/books/${olid}.json`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = (await res.json()) as { covers?: number[] };
      const covers = data.covers?.filter((c: number) => c > 0) ?? [];
      if (covers.length > 0) {
        return `https://covers.openlibrary.org/b/id/${covers[0]}-M.jpg`;
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, source_url FROM library_items WHERE source='openlibrary' AND cover_url IS NULL ORDER BY id`
  );
  console.log(`Total: ${rows.length}`);

  let updated = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (row: { id: string; source_url: string }) => {
        const coverUrl = await fetchCoverUrl(row.source_url);
        return { id: row.id, coverUrl };
      })
    );

    for (const r of results) {
      if (r.coverUrl) {
        await pool.query(`UPDATE library_items SET cover_url = $1 WHERE id = $2`, [r.coverUrl, r.id]);
        updated++;
      } else {
        notFound++;
      }
    }

    if (i % 100 === 0) {
      console.log(`[${i}/${rows.length}] updated=${updated} noCover=${notFound}`);
    }
    await new Promise((r) => setTimeout(r, 1100));
  }

  console.log(`\nDone! Updated: ${updated} | No cover: ${notFound}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
