const T=process.env.SLACK_BOT_TOKEN, ME="U04463JR4HH", CH="D0BA5Q1UKHD";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function api(m,p={},t=0){const u=new URL(`https://slack.com/api/${m}`);for(const[k,v]of Object.entries(p))u.searchParams.set(k,v);
 const r=await fetch(u,{headers:{Authorization:`Bearer ${T}`}});
 if(r.status===429){await sleep(6000);return api(m,p,t+1);} const j=await r.json();
 if(!j.ok&&j.error==="ratelimited"&&t<5){await sleep(6000);return api(m,p,t+1);} return j;}
const since=Math.floor((Date.now()-90*86400000)/1000);
let cur,par=[]; do{const r=await api("conversations.history",{channel:CH,limit:"200",oldest:String(since),...(cur?{cursor:cur}:{})});
 if(!r.ok)break; par=par.concat(r.messages||[]); cur=r.has_more?r.response_metadata?.next_cursor:null;}while(cur&&par.length<2000);
const th=par.filter(m=>(m.reply_count||0)>0);
console.log(`DM 부모 ${par.length} · 스레드 ${th.length} · 총답글 ${th.reduce((s,m)=>s+m.reply_count,0)}`);
const out=[];
for(const p of th){
  const r=await api("conversations.replies",{channel:CH,ts:p.thread_ts||p.ts,limit:"200"}); await sleep(900);
  if(!r.ok) continue;
  const seq=(r.messages||[]).map(m=>({ts:m.ts, who:m.user===ME?"재상":"봇", text:String(m.text||"").replace(/\s+/g," ")}));
  out.push({root:String(p.text||"").slice(0,60), seq});
}
import fs from "node:fs"; fs.writeFileSync("dm-threads.json",JSON.stringify(out,null,1));
const turns=out.flatMap(x=>x.seq);
console.log("총 턴:", turns.length, "| 재상", turns.filter(t=>t.who==="재상").length, "| 봇", turns.filter(t=>t.who==="봇").length);
