'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'

export default function AdminPage() {
  const [traders, setTraders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)

    const { data } = await supabase
      .from('traders')
      .select('*')
      .order('roi', { ascending: false })

    setTraders(data || [])
    setLoading(false)
  }

  async function updateROI(id: string, roi: number) {
    await supabase
      .from('traders')
      .update({ roi })
      .eq('id', id)

    await load()
  }

  return (
    <main style={{ padding: 40 }}>
      <h1>Admin — Update ROI</h1>

      {loading && <p>Loading…</p>}

      {!loading &&
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Trader</th>
              <th>ROI %</th>
              <th>Update</th>
            </tr>
          </thead>

          <tbody>
            {traders.map(t => (
              <tr key={t.id}>
                <td>{t.handle}</td>
                <td>{t.roi}</td>
                <td>
                  <button onClick={() => updateROI(t.id, t.roi + 10)}>
                    +10%
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    </main>
  )
}
