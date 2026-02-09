import { createClient } from '@supabase/supabase-js';
const sb = createClient('https://iknktzifjdyujdccyhsv.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE');

const MORE_URLS = {
  'SEC v. Terraform Labs': 'https://www.sec.gov/litigation/complaints/2023/comp-pr2023-32.pdf',
  'SEC v. Genesis & Gemini': 'https://www.sec.gov/litigation/complaints/2023/comp-pr2023-7.pdf',
  'Hong Kong VASP': 'https://www.sfc.hk/en/Rules-and-standards/Codes-and-guidelines/Codes',
  'Japan FSA': 'https://www.fsa.go.jp/en/refer/councils/singi_kinyu/',
  'Singapore MAS': 'https://www.mas.gov.sg/regulation/acts/payment-services-act',
  'BlackRock iShares Bitcoin': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=iShares+Bitcoin&CIK=&type=S-1&dateb=&owner=include&count=10',
  'Fidelity Wise Origin': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Fidelity+Wise+Origin&type=S-1&dateb=&owner=include&count=10',
  'Grayscale Bitcoin Trust 10-K': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Grayscale+Bitcoin&type=10-K&dateb=&owner=include&count=10',
  'Coinbase Global': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001679788&type=10-K&dateb=&owner=include&count=10',
  'MicroStrategy 10-K': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001050446&type=10-K&dateb=&owner=include&count=10',
  'Marathon Digital': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Marathon+Digital&type=10-K&dateb=&owner=include&count=10',
  'Riot Platforms': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Riot+Platforms&type=10-K&dateb=&owner=include&count=10',
  'Circle Internet': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Circle+Internet&type=S-1&dateb=&owner=include&count=10',
  'Bitwise 10 Crypto': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Bitwise&type=S-1&dateb=&owner=include&count=10',
  'VanEck Bitcoin': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=VanEck+Bitcoin&type=S-1&dateb=&owner=include&count=10',
  'ARK 21Shares': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=ARK+21Shares&type=S-1&dateb=&owner=include&count=10',
  'Galaxy Digital': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Galaxy+Digital&type=20-F&dateb=&owner=include&count=10',
  'Canaan Inc': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Canaan&type=20-F&dateb=&owner=include&count=10',
  'Bakkt Holdings': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Bakkt&type=10-K&dateb=&owner=include&count=10',
  'Hut 8 Mining': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Hut+8&type=&dateb=&owner=include&count=10',
  'CleanSpark': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=CleanSpark&type=10-K&dateb=&owner=include&count=10',
  'Silvergate Capital': 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Silvergate&type=10-K&dateb=&owner=include&count=10',
  'Signature Bank FDIC': 'https://www.fdic.gov/resources/resolutions/bank-failures/failed-bank-list/signature-bank.html',
  'SEC v. Kraken': 'https://www.sec.gov/litigation/complaints/2023/comp-pr2023-25.pdf',
  'CFTC v. Binance': 'https://www.cftc.gov/PressRoom/PressReleases/8680-23',
  'DOJ v. Changpeng Zhao': 'https://www.justice.gov/opa/pr/binance-and-ceo-plead-guilty-federal-charges-4b-resolution',
  'SEC v. Consensys': 'https://www.sec.gov/litigation/complaints/',
  'SEC v. Uniswap': 'https://www.sec.gov/',
  'Basel Committee': 'https://www.bis.org/bcbs/publ/d545.pdf',
  'UK FCA: Crypto Marketing': 'https://www.fca.org.uk/firms/cryptoassets',
  'Dubai VARA': 'https://www.vara.ae/en/regulations/',
  'Brazil Crypto Regulation': 'https://www.bcb.gov.br/en/financialstability/crypto_regulation',
  'India Crypto Tax': 'https://incometaxindia.gov.in/',
  'South Korea Virtual Asset': 'https://www.fsc.go.kr/eng/',
  'SEC Spot Ethereum ETF': 'https://www.sec.gov/rules/sro/nysearca.htm',
  'CFTC v. Ooki DAO': 'https://www.cftc.gov/PressRoom/PressReleases/8590-22',
};

const { data: items } = await sb.from('library_items').select('id, title').eq('category', 'whitepaper').is('pdf_url', null);
let u = 0;
for (const item of items) {
  const match = Object.entries(MORE_URLS).find(([p]) => item.title.startsWith(p));
  if (match) {
    await sb.from('library_items').update({ pdf_url: match[1] }).eq('id', item.id);
    u++;
    console.log(`✓ ${item.title}`);
  }
}
console.log(`Updated ${u}/${items.length}`);
