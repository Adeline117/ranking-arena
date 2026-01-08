'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'

export default function AdminPage() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)

    const { data } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, roi, win_rate, followers, captured_at')
      .order('roi', { ascending: false })
      .limit(50)

    setRows(data || [])
    setLoading(false)
  }

  return (
    <main style={{ padding: 40 }}>
      <h1>Admin — Update ROI</h1>

      {loading && <p>Loading…</p>}

      {!loading &&
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Source</th>
              <th>Trader ID</th>
              <th>ROI (90D)</th>
              <th>WinRate</th>
              <th>Followers</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((r) => (
              <tr key={`${r.source}-${r.source_trader_id}`}>
                <td>{String(r.source || '').toUpperCase()}</td>
                <td>{r.source_trader_id}</td>
                <td>{r.roi}</td>
                <td>{r.win_rate}</td>
                <td>{r.followers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    </main>
  )
}
