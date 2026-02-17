import { Suspense } from 'react'
import { HomePage } from './components/home'
import { getInitialTraders } from '@/lib/getInitialTraders'
import SSRRankingTable from './components/home/SSRRankingTable'

// ISR: Revalidate every 60 seconds
export const revalidate = 60
export const experimental_ppr = true

/**
 * 首页 - Two-phase rendering for perfect LCP + zero CLS:
 * 
 * Phase 1: SSRRankingTable renders real trader data as static HTML.
 *          Browser paints this instantly without any JavaScript.
 *          This is the LCP element — achieves sub-second LCP.
 * 
 * Phase 2: HomePage (client component) hydrates with full interactivity.
 *          Once .home-ranking-section exists in DOM, SSR table is hidden.
 *          Same data = zero CLS during the swap.
 */
export default async function Page() {
  const { traders: initialTraders, lastUpdated } = await getInitialTraders('90D', 25)

  return (
    <>
      {/* Static HTML ranking table — LCP element, no JS required */}
      <div className="ssr-only" id="ssr-ranking">
        <SSRRankingTable traders={initialTraders} />
      </div>

      {/* Interactive client app — streams in via RSC */}
      <Suspense fallback={null}>
        <HomePage
          initialTraders={initialTraders}
          initialLastUpdated={lastUpdated}
        />
      </Suspense>

      {/* Seamless swap: hide SSR table once client ranking section renders */}
      <script dangerouslySetInnerHTML={{ __html: `(function(){var s=document.getElementById('ssr-ranking');if(!s)return;var o=new MutationObserver(function(){if(document.querySelector('.home-ranking-section')){s.style.display='none';o.disconnect()}});o.observe(document.body,{childList:true,subtree:true});setTimeout(function(){s.style.display='none';o.disconnect()},12000)})()` }} />
    </>
  )
}
