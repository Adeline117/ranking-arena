'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import PortfolioOverview from '@/app/components/portfolio/PortfolioOverview'
import PositionList from '@/app/components/portfolio/PositionList'
import AddExchangeModal from '@/app/components/portfolio/AddExchangeModal'

interface Portfolio {
  id: string
  exchange: string
  label: string
  created_at: string
}

interface Position {
  id: string
  symbol: string
  side: 'long' | 'short'
  entry_price: number
  mark_price: number
  size: number
  pnl: number
  pnl_pct: number
  leverage: number
  updated_at: string
  user_portfolios?: { exchange: string; label: string }
}

interface Snapshot {
  total_equity: number
  total_pnl: number
  total_pnl_pct: number
  snapshot_at: string
}

export default function PortfolioPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState<string | null>(null)
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [snapshots] = useState<Snapshot[]>([])
  const [showAddModal, setShowAddModal] = useState(false)

  // Auth check
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.push('/login?redirect=/portfolio')
        return
      }
      supabase.auth.getSession().then(({ data: sessionData }) => {
        setToken(sessionData.session?.access_token ?? null)
      })
    })
  }, [router])

  const fetchHeaders = useCallback((): Record<string, string> => {
    if (!token) return {}
    return { Authorization: `Bearer ${token}` }
  }, [token])

  // Load portfolios
  const loadPortfolios = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch('/api/portfolio', { headers: fetchHeaders() })
      const json = await res.json()
      if (json.data) setPortfolios(json.data)
    } catch {
      // silent
    }
  }, [token, fetchHeaders])

  // Load positions
  const loadPositions = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch('/api/portfolio/positions', { headers: fetchHeaders() })
      const json = await res.json()
      if (json.data) setPositions(json.data)
    } catch {
      // silent
    }
  }, [token, fetchHeaders])

  useEffect(() => {
    if (!token) return
    setLoading(true)
    Promise.all([loadPortfolios(), loadPositions()]).finally(() => setLoading(false))
  }, [token, loadPortfolios, loadPositions])

  const handleAddExchange = async (data: { exchange: string; api_key: string; api_secret: string; label: string }) => {
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { ...fetchHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const json = await res.json()
      throw new Error(json.error || 'Failed to add exchange')
    }
    await loadPortfolios()
  }

  const handleSync = async (portfolioId: string) => {
    if (!token) return
    await fetch('/api/portfolio/sync', {
      method: 'POST',
      headers: { ...fetchHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio_id: portfolioId }),
    })
    await loadPositions()
  }

  const handleDelete = async (portfolioId: string) => {
    if (!token) return
    await fetch(`/api/portfolio?id=${portfolioId}`, {
      method: 'DELETE',
      headers: fetchHeaders(),
    })
    await Promise.all([loadPortfolios(), loadPositions()])
  }

  // Totals from positions
  const totalPnl = positions.reduce((sum, p) => sum + Number(p.pnl), 0)
  const totalEquity = positions.reduce((sum, p) => sum + Number(p.size) * Number(p.mark_price), 0)
  const totalPnlPct = totalEquity > 0 ? (totalPnl / totalEquity) * 100 : 0

  return (
    <>
      <TopNav />
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Portfolio</h1>
            <button style={styles.addBtn} onClick={() => setShowAddModal(true)}>
              + Connect Exchange
            </button>
          </div>

          <PortfolioOverview
            totalEquity={totalEquity}
            totalPnl={totalPnl}
            totalPnlPct={totalPnlPct}
            snapshots={snapshots}
            isLoading={loading}
          />

          {/* Connected exchanges */}
          {portfolios.length > 0 && (
            <div style={styles.section}>
              <h2 style={styles.sectionTitle}>Connected Exchanges</h2>
              <div style={styles.exchangeList}>
                {portfolios.map(p => (
                  <div key={p.id} style={styles.exchangeCard}>
                    <div style={styles.exchangeInfo}>
                      <span style={styles.exchangeName}>
                        {p.exchange.charAt(0).toUpperCase() + p.exchange.slice(1)}
                      </span>
                      {p.label !== p.exchange && (
                        <span style={styles.exchangeLabel}>{p.label}</span>
                      )}
                    </div>
                    <div style={styles.exchangeActions}>
                      <button style={styles.syncBtn} onClick={() => handleSync(p.id)}>
                        Sync
                      </button>
                      <button style={styles.deleteBtn} onClick={() => handleDelete(p.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Positions */}
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Open Positions</h2>
            <PositionList positions={positions} isLoading={loading} />
          </div>
        </div>
      </div>
      <MobileBottomNav />

      <AddExchangeModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSubmit={handleAddExchange}
      />
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    backgroundColor: 'var(--color-bg-primary)',
    paddingTop: '60px',
    paddingBottom: '80px',
  },
  container: {
    maxWidth: '960px',
    margin: '0 auto',
    padding: '24px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '12px',
  },
  title: {
    margin: 0,
    fontSize: '24px',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
  },
  addBtn: {
    padding: '10px 20px',
    borderRadius: '10px',
    border: 'none',
    backgroundColor: 'var(--color-brand)',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
  },
  exchangeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  exchangeCard: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderRadius: '12px',
    backgroundColor: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-primary)',
    flexWrap: 'wrap',
    gap: '8px',
  },
  exchangeInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  exchangeName: {
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    fontSize: '14px',
  },
  exchangeLabel: {
    fontSize: '12px',
    color: 'var(--color-text-secondary)',
  },
  exchangeActions: {
    display: 'flex',
    gap: '8px',
  },
  syncBtn: {
    padding: '6px 14px',
    borderRadius: '8px',
    border: '1px solid var(--color-border-primary)',
    backgroundColor: 'transparent',
    color: 'var(--color-brand)',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
  },
  deleteBtn: {
    padding: '6px 14px',
    borderRadius: '8px',
    border: '1px solid var(--color-border-primary)',
    backgroundColor: 'transparent',
    color: 'var(--color-error)',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
  },
}
