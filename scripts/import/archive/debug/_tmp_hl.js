// Hyperliquid refresh helper
const{createClient}=require("@supabase/supabase-js"),{readFileSync}=require("fs");
try{for(const l of readFileSync(".env.local","utf8").split("\n")){const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2]}}catch{}
const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
const clip=(v,l,h)=>Math.max(l,Math.min(h,v));
function cs(r){if(r==null)return null;return clip(Math.round((Math.min(70,r>0?Math.log(1+r/100)*25:Math.max(-70,r/100*50))+15)*10)/10,0,100)}
(async()=>{
  const d=JSON.parse(readFileSync("/tmp/hl.json","utf8"));
  const t=d.leaderboardRows.filter(x=>{const p=x.windowPerformances?.find(w=>w[0]==="month");return p&&p[1]?.roi}).map(x=>{const p=x.windowPerformances.find(w=>w[0]==="month")[1];return{id:x.ethAddress,roi:parseFloat(p.roi)*100,pnl:parseFloat(p.pnl)}}).filter(x=>x.roi>0).sort((a,b)=>b.roi-a.roi).slice(0,500);
  const now=new Date().toISOString();let s=0;
  for(let i=0;i<t.length;i+=50)try{await sb.from("trader_sources").upsert(t.slice(i,i+50).map(x=>({source:"hyperliquid",source_trader_id:x.id,handle:x.id.substring(0,10),market_type:"futures",is_active:true})),{onConflict:"source,source_trader_id"})}catch{}
  for(let i=0;i<t.length;i+=30){const{error}=await sb.from("trader_snapshots").upsert(t.slice(i,i+30).map((x,j)=>({source:"hyperliquid",source_trader_id:x.id,season_id:"30D",rank:i+j+1,roi:x.roi,pnl:x.pnl,arena_score:cs(x.roi),captured_at:now})),{onConflict:"source,source_trader_id,season_id"});if(!error)s+=Math.min(30,t.length-i)}
  console.log(s)
})();
