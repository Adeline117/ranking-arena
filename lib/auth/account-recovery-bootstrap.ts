import {
  ACCOUNT_RECOVERY_MEMORY_KEY,
  ACCOUNT_RECOVERY_SESSION_TOKEN_KEY,
  ACCOUNT_RECOVERY_TOKEN_KEY,
} from './account-recovery-token'

/**
 * Parser-first bootstrap for the legacy full-document recovery fallback.
 *
 * This must remain the first author-owned root script. Next may prepend async
 * module registrations, but telemetry/Replay initialize during hydration,
 * after this removes the credential and moves it to a non-enumerable, one-time
 * Window handoff consumed by LoginPageClient.
 */
export function getAccountRecoveryBootstrapScript(): string {
  const memoryKey = JSON.stringify(ACCOUNT_RECOVERY_MEMORY_KEY)
  const localKey = JSON.stringify(ACCOUNT_RECOVERY_TOKEN_KEY)
  const sessionKey = JSON.stringify(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)

  return `(function(){var M=${memoryKey},L=${localKey},S=${sessionKey},p,v,a,r='',ok=false,h;try{h=location.hash.slice(1);p=new URLSearchParams(h);a=p.getAll('recovery_token');if(!a.length)return;v=a.length===1?a[0]:null;try{localStorage.removeItem(L)}catch(e){}try{sessionStorage.removeItem(S)}catch(e){}p.delete('recovery_token');r=p.toString();history.replaceState(history.state,'',location.pathname+location.search+(r?'#'+r:''));if(typeof v==='string'&&v.length>=40&&v.length<=128&&v.length%4!==1&&/^[A-Za-z0-9_-]+$/.test(v)&&typeof atob==='function'&&typeof btoa==='function'){var q=v.replace(/-/g,'+').replace(/_/g,'/');q+=Array((4-q.length%4)%4+1).join('=');ok=btoa(atob(q)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')===v}}catch(e){ok=false}var x=ok?{status:'valid',token:v}:{status:'invalid'};try{Object.defineProperty(window,M,{configurable:true,enumerable:false,writable:true,value:x})}catch(e){try{window[M]=x}catch(e){}}})()`
}
