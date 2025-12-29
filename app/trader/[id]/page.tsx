import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';

// 类型定义可以保留：
type Trader = {
  id: string;
  handle: string;
  bio: string | null;
  roi: number;
  win_rate: number;
  followers: number;
};

type TraderSeason = {
  id: string;
  trader_id: string;
  season: string;
  roi: number;
  max_drawdown: number;
  arena_score: number;
};

type PageProps = {
  params: { id: string };
};

export default async function TraderPage({ params }: PageProps) {
  // ① 取 trader 基本信息
  const {
    data: traderData,
    error: traderError,
  } = await supabase
    .from('traders')              // ❌ 删掉 <Trader>
    .select('*')
    .eq('id', params.id)
    .single();

  const trader = traderData as Trader | null;

  if (traderError || !trader) {
    return (
      <main style={{ padding: 40 }}>
        <h1>Trader not found</h1>
        <p>We couldn&apos;t find this trader.</p>
        <Link href="/app">← Back to ranking</Link>
      </main>
    );
  }

  // ② 取这个 trader 的赛季历史
  const { data: seasonsData } = await supabase
    .from('trader_seasons')      // ❌ 删掉 <TraderSeason>
    .select('*')
    .eq('trader_id', params.id)
    .order('season', { ascending: false });

  const seasons = (seasonsData ?? []) as TraderSeason[];

  return (
    <main style={{ padding: 40 }}>
      <p style={{ marginBottom: 12 }}>
        <Link href="/app">← Back to ranking</Link>
      </p>

      <h1 style={{ marginTop: 18 }}>{trader.handle}</h1>
      <p>
        当前 ROI: {trader.roi.toFixed(1)}% · 粉丝 {trader.followers}
      </p>

      <p style={{ fontSize: 13, color: '#9c9aaf', marginBottom: 16 }}>
        {trader.bio || '这个 Trader 还没有写个人简介。'}
      </p>

      <h2 style={{ marginTop: 24 }}>Season history</h2>

      {seasons.length > 0 ? (
        <table
          style={{
            marginTop: 8,
            borderCollapse: 'collapse',
            minWidth: 480,
          }}
        >
          <thead>
            <tr>
              <th style={{ padding: 6, borderBottom: '1px solid #555' }}>Season</th>
              <th style={{ padding: 6, borderBottom: '1px solid #555' }}>ROI %</th>
              <th style={{ padding: 6, borderBottom: '1px solid #555' }}>Max DD %</th>
              <th style={{ padding: 6, borderBottom: '1px solid #555' }}>Arena score</th>
            </tr>
          </thead>
          <tbody>
            {seasons.map((s) => (
              <tr key={s.id}>
                <td style={{ padding: 6 }}>{s.season}</td>
                <td style={{ padding: 6 }}>{s.roi}</td>
                <td style={{ padding: 6 }}>{s.max_drawdown}</td>
                <td style={{ padding: 6 }}>{s.arena_score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ marginTop: 8 }}>No season history yet.</p>
      )}
    </main>
  );
}
