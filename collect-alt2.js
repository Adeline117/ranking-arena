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

async function fetchOpenLibrary(query, page=1) {
  const url=`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=100&page=${page}`;
  const res=await fetch(url);
  if(!res.ok){console.error(`OL HTTP ${res.status} for "${query}"`);return[];}
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
    publish_date: d.first_publish_year?String(d.first_publish_year):null,
    is_free: d.ebook_access==='public',
    buy_url: `https://openlibrary.org${d.key}`,
  })).filter(b=>b.title&&b.author);
}

async function insertBatch(items){
  // Insert in chunks of 50
  let inserted=0;
  for(let i=0;i<items.length;i+=50){
    const chunk=items.slice(i,i+50);
    const {error}=await sb.from(TABLE).upsert(chunk,{onConflict:'title,author',ignoreDuplicates:true});
    if(error){console.error('Insert error:',error.message);return inserted;}
    inserted+=chunk.length;
  }
  return inserted;
}

async function main(){
  let totalInserted=0;
  
  // 1. Open Library
  console.log('=== Open Library ===');
  for(let i=0;i<keywords.length;i++){
    const kw=keywords[i];
    const books=await fetchOpenLibrary(kw);
    if(books.length>0){
      const n=await insertBatch(books);
      totalInserted+=n;
    }
    console.log(`[${i+1}/${keywords.length}] "${kw}" → ${books.length} books (total: ${totalInserted})`);
    await sleep(1500);
  }

  // 2. SEC EDGAR full-text search
  console.log('\n=== SEC EDGAR ===');
  const edgarQueries=['cryptocurrency','bitcoin','blockchain','digital+assets','defi'];
  for(const q of edgarQueries){
    try{
      const url=`https://efts.sec.gov/LATEST/search-index?q=%22${q}%22&forms=10-K,S-1&dateRange=custom&startdt=2020-01-01&enddt=2026-02-06`;
      const r=await fetch(url,{headers:{'User-Agent':'ResearchBot/1.0 research@example.com'}});
      if(!r.ok){console.log(`EDGAR "${q}": HTTP ${r.status}`);continue;}
      const d=await r.json();
      const hits=d.hits?.hits||[];
      console.log(`EDGAR "${q}": ${hits.length} results`);
      const docs=hits.slice(0,100).map(h=>{
        const s=h._source||h;
        return {
          title:`SEC ${s.form_type||'Filing'}: ${(s.entity_name||'Unknown').substring(0,200)}`,
          author:s.entity_name||'SEC',
          description:`SEC ${s.form_type} filing by ${s.entity_name}. Filed: ${s.file_date}. CIK: ${s.file_num||''}`.substring(0,1000),
          category:'research_paper',source:'sec_edgar',
          source_url:s.file_url||`https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(s.entity_name||'')}`,
          language:'en',publish_date:s.file_date,is_free:true,
        };
      }).filter(d=>d.author&&d.author!=='SEC');
      if(docs.length>0){
        const n=await insertBatch(docs);
        totalInserted+=n;
        console.log(`  Inserted ${n} EDGAR docs`);
      }
    }catch(e){console.log(`EDGAR "${q}" error:`,e.message);}
    await sleep(1000);
  }

  const {count}=await sb.from(TABLE).select('*',{count:'exact',head:true});
  console.log(`\n✅ Done! Added ~${totalInserted}. Final library count: ${count}`);
}

main().catch(console.error);
