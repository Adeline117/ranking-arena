import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 1. Pipeline logs last 24h
  const since = new Date(Date.now() - 24*60*60*1000).toISOString();
  const { data: logs } = await supabase
    .from('pipeline_logs')
    .select('job_name, status, started_at, records_processed, error_message')
    .gte('started_at', since)
    .order('started_at', { ascending: false });

  const jobs: Record<string, any> = {};
  for (const row of logs || []) {
    if (!jobs[row.job_name]) jobs[row.job_name] = { success: 0, error: 0, running: 0, total_records: 0, errors: [] as string[] };
    const j = jobs[row.job_name];
    if (row.status === 'success') { j.success++; j.total_records += row.records_processed || 0; }
    else if (row.status === 'error') { j.error++; j.errors.push((row.error_message || '').substring(0, 120)); }
    else if (row.status === 'running') { j.running++; }
  }

  console.log('=== Pipeline Logs (Last 24h) ===');
  let totalS = 0, totalE = 0;
  for (const [name, s] of Object.entries(jobs).sort((a: any, b: any) => a[0].localeCompare(b[0]))) {
    const st = s as any;
    const total = st.success + st.error;
    const rate = total > 0 ? Math.round(st.success / total * 100) : 0;
    const icon = st.error > 0 ? 'FAIL' : 'OK';
    totalS += st.success; totalE += st.error;
    console.log(`${icon} ${name}: ${rate}% (${st.success}/${total}) records=${st.total_records}${st.running > 0 ? ` running=${st.running}` : ''}`);
    if (st.errors.length > 0) {
      const unique = [...new Set(st.errors as string[])].slice(0, 2);
      console.log(`   errors: ${unique.join(' | ')}`);
    }
  }
  console.log(`\nOVERALL: ${totalS} success, ${totalE} errors, ${totalS+totalE > 0 ? Math.round(totalS/(totalS+totalE)*100) : 0}% success rate`);

  // 2. Data freshness - use SQL for efficiency
  console.log('\n=== Data Freshness by Platform ===');

  // Get latest snapshot per source from trader_profiles_v2 (which stores current data)
  const { data: freshness } = await supabase
    .from('trader_profiles_v2')
    .select('source, updated_at')
    .order('updated_at', { ascending: false });

  const latestBySource: Record<string, string> = {};
  const traderCounts: Record<string, number> = {};
  for (const r of freshness || []) {
    traderCounts[r.source] = (traderCounts[r.source] || 0) + 1;
    if (!latestBySource[r.source]) latestBySource[r.source] = r.updated_at;
  }

  const now = Date.now();
  for (const src of Object.keys(latestBySource).sort()) {
    const age = Math.round((now - new Date(latestBySource[src]).getTime()) / (1000*60*60));
    const icon = age <= 12 ? '🟢' : age <= 48 ? '🟡' : '🔴';
    console.log(`${icon} ${src}: ${latestBySource[src].substring(0,16)} (${age}h ago) | ${traderCounts[src]} traders`);
  }

  const total = Object.values(traderCounts).reduce((a, b) => a + b, 0);
  console.log(`\nTotal traders in profiles_v2: ${total}`);

  // 3. Check for stuck running jobs
  console.log('\n=== Stuck Jobs (running > 1h) ===');
  const oneHourAgo = new Date(Date.now() - 60*60*1000).toISOString();
  const { data: stuck } = await supabase
    .from('pipeline_logs')
    .select('job_name, started_at')
    .eq('status', 'running')
    .lt('started_at', oneHourAgo)
    .order('started_at', { ascending: true });

  if (stuck && stuck.length > 0) {
    for (const s of stuck) {
      const age = Math.round((now - new Date(s.started_at).getTime()) / (1000*60*60));
      console.log(`⚠️ ${s.job_name}: started ${age}h ago`);
    }
  } else {
    console.log('None');
  }
}

main();
