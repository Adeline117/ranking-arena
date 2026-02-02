// Binance Spot refresh helper
const{createClient}=require("@supabase/supabase-js"),{spawnSync}=require("child_process"),{readFileSync}=require("fs");
try{for(const l of readFileSync(".env.local","utf8").split("\n")){const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2]}}catch{}
const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
const clip=(v,l,h)=>Math.max(l,Math.min(h,v));
function cs(r,d,w){if(r==null)return null;return clip(Math.round((Math.min(70,r>0?Math.log(1+r/100)*25:Math.max(-70,r/100*50))+(d!=null?Math.max(0,15*(1-d/100)):7.5)+(w!=null?Math.min(15,w/100*15):7.5))*10)/10,0,100)}
(async()=>{
  const all=[];
  for(let p=1;p<=25;p++){
    const r=spawnSync("curl",["-s","-m","10","--compressed","-x","http://127.0.0.1:7890","-X","POST",
      "https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list",
      "-H","Content-Type: application/json","-H","User-Agent: Mozilla/5.0",
      "-d",JSON.stringify({pageNumber:p,pageSize:20,timeRange:"30D",dataType:"ROI",order:"DESC",portfolioType:"ALL"})],{encoding:"utf8"});
    try{const d=JSON.parse(r.stdout);const list=d.data?.list||[];if(!list.length)break;
    for(const it of list)all.push({id:it.leadPortfolioId||"",n:it.nickname||"",roi:it.roi!=null?parseFloat(it.roi):null,pnl:it.pnl!=null?parseFloat(it.pnl):null,wr:it.winRate!=null?parseFloat(it.winRate)*100:null,dd:it.mdd!=null?parseFloat(it.mdd):null})}catch{break}
  }
  const now=new Date().toISOString();let saved=0;
  for(let i=0;i<all.length;i+=50)try{await sb.from("trader_sources").upsert(all.slice(i,i+50).map(t=>({source:"binance_spot",source_trader_id:t.id,handle:t.n||t.id,market_type:"spot",is_active:true})),{onConflict:"source,source_trader_id"})}catch{}
  for(let i=0;i<all.length;i+=30){const{error}=await sb.from("trader_snapshots").upsert(all.slice(i,i+30).map((t,j)=>({source:"binance_spot",source_trader_id:t.id,season_id:"30D",rank:i+j+1,roi:t.roi,pnl:t.pnl,win_rate:t.wr,max_drawdown:t.dd,arena_score:cs(t.roi,t.dd,t.wr),captured_at:now})),{onConflict:"source,source_trader_id,season_id"});if(!error)saved+=Math.min(30,all.length-i)}
  console.log(saved)
})();
