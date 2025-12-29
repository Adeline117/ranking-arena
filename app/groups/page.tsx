'use client'
import TopNav from '@/app/components/TopNav'
import RankingTable from "@/app/components/RankingTable"
import MarketPanel from "@/app/components/MarketPanel"


export default function GroupsPage() {
  return (
    <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
      <TopNav />
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '18px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: 16 }}>
          <section>  <RankingTable
    traders={[]}
    loading={false}
    loggedIn={false}
  />
</section>
          <section>
            <div style={{ border: '1px solid #1f1f1f', borderRadius: 16, background: '#0b0b0b', padding: 14 }}>
              <div style={{ fontWeight: 950 }}>小组推荐帖子（下一步把你现有帖子流搬进来）</div>
              <div style={{ marginTop: 8, color: '#a9a9a9' }}>未登录只看前10帖</div>
            </div>
          </section>
          <section><MarketPanel /></section>
        </div>
      </main>
    </div>
  )
}
