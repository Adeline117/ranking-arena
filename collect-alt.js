const {createClient}=require('@supabase/supabase-js');
const sb=createClient('https://iknktzifjdyujdccyhsv.supabase.co','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE');

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const keywords = [
  'cryptocurrency trading','blockchain technology','defi decentralized finance','bitcoin investing',
  'ethereum','technical analysis','quantitative trading','algorithmic trading','options trading',
  'futures trading','forex trading','stock market investing','value investing','day trading',
  'swing trading','risk management','portfolio management','financial derivatives',
  'market microstructure','behavioral finance','tokenomics','NFT','web3','yield farming',
  'crypto mining','financial engineering','hedge fund','crypto regulation','stablecoin','CBDC'
];

async function fetchOpenLibrary(query, page=1) {
  const url=`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=100&page=${page}`;
  const res=await fetch(url);
  if(!res.ok){console.error(`OL HTTP ${res.status} for "${query}"`);return[];}
  const data=await res.json();
  return (data.docs||[]).map(d=>({
    title: d.title,
    author: (d.author_name||[]).join(', '),
    description: (d.first_sentence?.[0]||'').substring(0,1000),
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

async function fetchEDGAR() {
  // EDGAR full-text search
  const queries=['cryptocurrency','bitcoin','blockchain','digital assets','defi'];
  const allDocs=[];
  for(const q of queries){
    const url=`https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(q)}%22&forms=10-K,S-1,10-Q&dateRange=custom&startdt=2020-01-01&enddt=2026-02-06`;
    try{
      const r=await fetch(url,{headers:{'User-Agent':'ResearchBot/1.0 research@example.com','Accept':'application/json'}});
      if(r.ok){
        const d=await r.json();
        const hits=d.hits?.hits||[];
        console.log(`EDGAR "${q}": ${hits.length} hits`);
        for(const h of hits.slice(0,50)){
          const s=h._source||h;
          allDocs.push({
            title:`${s.form_type||'Filing'}: ${s.entity_name||'Unknown'} (${s.file_date||''})`,
            author:s.entity_name||'',
            description:`SEC ${s.form_type} filing. ${s.file_description||''}`.substring(0,1000),
            category:'research_paper',source:'sec_edgar',
            source_url:s.file_url||'',language:'en',
            publish_date:s.file_date,is_free:true,
          });
        }
      } else {
        console.log(`EDGAR "${q}": HTTP ${r.status}`);
        // Try alternate endpoint
        const r2=await fetch(`https://efts.sec.gov/LATEST/search?q=%22${encodeURIComponent(q)}%22&forms=10-K,S-1&dateRange=custom&startdt=2020-01-01&enddt=2026-02-06`,
          {headers:{'User-Agent':'ResearchBot/1.0 research@example.com'}});
        if(r2.ok){
          const d2=await r2.json();
          const filings=d2.hits?.hits||[];
          console.log(`EDGAR search "${q}": ${filings.length} hits`);
          for(const h of filings.slice(0,50)){
            const s=h._source||h;
            allDocs.push({
              title:`${s.form_type||'Filing'}: ${s.entity_name||s.display_names?.[0]||'Unknown'} (${s.file_date||''})`,
              author:s.entity_name||s.display_names?.[0]||'',
              description:`SEC ${s.form_type} filing. Filed ${s.file_date}. ${s.file_description||''}`.substring(0,1000),
              category:'research_paper',source:'sec_edgar',
              source_url:`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(s.entity_name||'')}`,
              language:'en',publish_date:s.file_date,is_free:true,
            });
          }
        } else console.log(`EDGAR search "${q}": HTTP ${r2.status}`);
      }
    }catch(e){console.log(`EDGAR "${q}" error:`,e.message);}
    await sleep(1000);
  }
  return allDocs.filter(d=>d.author);
}

async function main(){
  let totalInserted=0;
  
  // 1. Open Library
  console.log('=== Open Library ===');
  for(let i=0;i<keywords.length;i++){
    const kw=keywords[i];
    const books=await fetchOpenLibrary(kw);
    if(books.length>0){
      const {error}=await sb.from('library').upsert(books,{onConflict:'title,author',ignoreDuplicates:true});
      if(error)console.error(`OL insert "${kw}":`,error.message);
      else totalInserted+=books.length;
    }
    console.log(`[${i+1}/${keywords.length}] "${kw}" → ${books.length} books (total: ${totalInserted})`);
    await sleep(1500); // be nice to OL
  }

  // 2. SEC EDGAR
  console.log('\n=== SEC EDGAR ===');
  const edgarDocs=await fetchEDGAR();
  if(edgarDocs.length>0){
    const {error}=await sb.from('library').upsert(edgarDocs,{onConflict:'title,author',ignoreDuplicates:true});
    console.log(`EDGAR: ${edgarDocs.length} docs${error?' error: '+error.message:' inserted'}`);
    if(!error)totalInserted+=edgarDocs.length;
  }

  // 3. Try Google Books with longer delay (5s)
  console.log('\n=== Google Books (5s delay) ===');
  const testRes=await fetch('https://www.googleapis.com/books/v1/volumes?q=bitcoin&maxResults=1');
  if(testRes.ok){
    console.log('Google Books accessible! Proceeding...');
    for(let i=0;i<keywords.length;i++){
      const kw=keywords[i];
      let kwBooks=[];
      for(const idx of [0,40]){
        const url=`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(kw)}&maxResults=40&startIndex=${idx}`;
        const res=await fetch(url);
        if(res.ok){
          const data=await res.json();
          const books=(data.items||[]).map(item=>{
            const v=item.volumeInfo||{};
            return {
              title:v.title,author:(v.authors||[]).join(', '),
              description:(v.description||'').substring(0,1000),
              category:'book',source:'google_books',source_url:v.infoLink,
              cover_url:v.imageLinks?.thumbnail,
              isbn:v.industryIdentifiers?.find(i=>i.type==='ISBN_13')?.identifier,
              language:v.language,publish_date:v.publishedDate,
              is_free:false,buy_url:v.infoLink,
            };
          }).filter(b=>b.title);
          kwBooks.push(...books);
        } else {
          console.log(`GB 429 at "${kw}" idx=${idx}, stopping Google Books`);
          i=keywords.length; break;
        }
        await sleep(5000);
      }
      if(kwBooks.length>0){
        const {error}=await sb.from('library').upsert(kwBooks,{onConflict:'title,author',ignoreDuplicates:true});
        if(!error)totalInserted+=kwBooks.length;
        console.log(`GB [${i+1}/30] "${kw}" → ${kwBooks.length} (total: ${totalInserted})`);
      }
    }
  } else console.log('Google Books still rate limited, skipping');

  const {count}=await sb.from('library').select('*',{count:'exact',head:true});
  console.log(`\n✅ Done! Inserted ~${totalInserted}. Final library count: ${count}`);
}

main().catch(console.error);
