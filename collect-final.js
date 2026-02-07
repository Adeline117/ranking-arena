const {createClient}=require('@supabase/supabase-js');
const sb=createClient('https://iknktzifjdyujdccyhsv.supabase.co','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE');

const TABLE='library_items';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const keywords = [
  'cryptocurrency trading','blockchain technology','defi decentralized finance','bitcoin investing',
  'ethereum','technical analysis trading','quantitative trading','algorithmic trading','options trading',
  'futures trading','forex trading','stock market investing','value investing','day trading',
  'swing trading','risk management finance','portfolio management','financial derivatives',
  'market microstructure','behavioral finance','tokenomics','NFT digital art','web3 decentralized',
  'yield farming crypto','crypto mining','financial engineering','hedge fund strategies',
  'crypto regulation law','stablecoin','CBDC central bank digital'
];

// Load existing titles for dedup
async function getExistingTitles(){
  const titles=new Set();
  let offset=0;
  while(true){
    const {data}=await sb.from(TABLE).select('title').range(offset,offset+999);
    if(!data||data.length===0)break;
    data.forEach(d=>titles.add(d.title?.toLowerCase()));
    offset+=data.length;
    if(data.length<1000)break;
  }
  return titles;
}

async function fetchOpenLibrary(query) {
  const url=`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=100`;
  const res=await fetch(url);
  if(!res.ok)return[];
  const data=await res.json();
  return (data.docs||[]).map(d=>({
    title: d.title,
    author: (d.author_name||[]).join(', '),
    description: (d.first_sentence?.[0]||d.subtitle||'').substring(0,1000)||null,
    category: 'book',
    source: 'open_library',
    source_url: `https://openlibrary.org${d.key}`,
    cover_url: d.cover_i?`https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`:null,
    isbn: d.isbn?.[0]||null,
    language: (d.language||[])[0]||null,
    publish_date: d.first_publish_year?`${d.first_publish_year}-01-01`:null,
    is_free: d.ebook_access==='public',
    buy_url: `https://openlibrary.org${d.key}`,
  })).filter(b=>b.title&&b.author);
}

async function main(){
  console.log('Loading existing titles...');
  const existing=await getExistingTitles();
  console.log(`Found ${existing.size} existing items`);
  let totalInserted=0;

  // Open Library
  console.log('\n=== Open Library ===');
  for(let i=0;i<keywords.length;i++){
    const kw=keywords[i];
    let books=await fetchOpenLibrary(kw);
    // Dedupe
    books=books.filter(b=>!existing.has(b.title.toLowerCase()));
    if(books.length>0){
      for(let j=0;j<books.length;j+=50){
        const chunk=books.slice(j,j+50);
        const {error}=await sb.from(TABLE).insert(chunk);
        if(error){console.error(`  Insert err: ${error.message}`);break;}
        chunk.forEach(b=>existing.add(b.title.toLowerCase()));
        totalInserted+=chunk.length;
      }
    }
    console.log(`[${i+1}/30] "${kw}" → ${books.length} new (total new: ${totalInserted})`);
    await sleep(1500);
  }

  // SEC EDGAR
  console.log('\n=== SEC EDGAR ===');
  for(const q of ['cryptocurrency','bitcoin','blockchain','digital+assets','defi']){
    try{
      const url=`https://efts.sec.gov/LATEST/search-index?q=%22${q}%22&forms=10-K,S-1&dateRange=custom&startdt=2020-01-01&enddt=2026-02-06`;
      const r=await fetch(url,{headers:{'User-Agent':'ResearchBot/1.0 research@example.com'}});
      if(!r.ok){console.log(`EDGAR "${q}": HTTP ${r.status}`);continue;}
      const d=await r.json();
      const hits=d.hits?.hits||[];
      let docs=hits.slice(0,100).map(h=>{
        const s=h._source||h;
        return {
          title:`SEC ${s.form_type||'Filing'}: ${(s.entity_name||'Unknown').substring(0,200)}`,
          author:s.entity_name||'',
          description:`SEC ${s.form_type} filing by ${s.entity_name}. Filed: ${s.file_date}.`.substring(0,1000),
          category:'research_paper',source:'sec_edgar',
          source_url:s.file_url||'',language:'en',publish_date:s.file_date,is_free:true,
        };
      }).filter(d=>d.author&&!existing.has(d.title.toLowerCase()));
      if(docs.length>0){
        const {error}=await sb.from(TABLE).insert(docs);
        if(!error){totalInserted+=docs.length;docs.forEach(d=>existing.add(d.title.toLowerCase()));}
        else console.error(`  EDGAR insert err: ${error.message}`);
      }
      console.log(`EDGAR "${q}": ${docs.length} new inserted`);
    }catch(e){console.log(`EDGAR "${q}" error:`,e.message);}
    await sleep(1000);
  }

  const {count}=await sb.from(TABLE).select('*',{count:'exact',head:true});
  console.log(`\n✅ Done! Added ${totalInserted} items. Final count: ${count}`);
}

main().catch(console.error);
