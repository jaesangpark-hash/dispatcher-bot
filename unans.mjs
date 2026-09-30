const T=process.env.SLACK_BOT_TOKEN, ME="U04463JR4HH";
const APM=new Set(["U07E0QPL8MV","U05CE8HFA6B"]);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function api(m,p={},t=0){const u=new URL(`https://slack.com/api/${m}`);for(const[k,v]of Object.entries(p))u.searchParams.set(k,v);
 const r=await fetch(u,{headers:{Authorization:`Bearer ${T}`}});
 if(r.status===429){await sleep(6000);return api(m,p,t+1);} const j=await r.json();
 if(!j.ok&&j.error==="ratelimited"&&t<5){await sleep(6000);return api(m,p,t+1);} return j;}
const since=Math.floor((Date.now()-90*86400000)/1000);
const CH=[["C09B8QHP7D4","재팬_요청"],["C09AUQN8GEB","재팬_작업요청"],["C06SUD5AFE1","toon-원본재수급"],["C09B8QBEC9L","재팬_리테이크"]];
let tot=0, ans=0, un=[], lags=[];
for(const [id,name] of CH){
  let cur,par=[]; do{const r=await api("conversations.history",{channel:id,limit:"200",oldest:String(since),...(cur?{cursor:cur}:{})});
   if(!r.ok)break; par=par.concat(r.messages||[]); cur=r.has_more?r.response_metadata?.next_cursor:null;}while(cur&&par.length<3000);
  for(const p of par.filter(m=>(m.reply_count||0)>0)){
    const r=await api("conversations.replies",{channel:id,ts:p.thread_ts||p.ts,limit:"200"}); await sleep(1100);
    if(!r.ok)continue;
    const msgs=r.messages||[];
    // APM이 재상 멘션한 마지막 댓글
    let last=null;
    for(const m of msgs.slice(1)) if(APM.has(m.user)&&String(m.text||"").includes(`<@${ME}>`)) last=m;
    if(!last) continue;
    tot++;
    const after=msgs.filter(m=>m.user===ME && Number(m.ts)>Number(last.ts));
    if(after.length){ ans++; lags.push((Number(after[0].ts)-Number(last.ts))/3600); }
    else un.push({ch:name, ts:last.ts, days:((Date.now()/1000)-Number(last.ts))/86400,
      text:String(last.text||"").replace(/\s+/g," ").slice(0,150), parent:String(p.text||"").replace(/\s+/g," ").slice(0,80)});
  }
  console.log(`${name} 완료 — 누적 대상 ${tot}`);
}
lags.sort((a,b)=>a-b);
console.log(`\nAPM이 재상 멘션한 스레드 ${tot}개`);
console.log(`  재상 답변함 ${ans} (${(ans/tot*100).toFixed(0)}%) · 무응답 ${un.length} (${(un.length/tot*100).toFixed(0)}%)`);
if(lags.length) console.log(`  응답까지: 중앙값 ${lags[Math.floor(lags.length/2)].toFixed(1)}h · 4시간 내 ${lags.filter(x=>x<4).length}건 · 24시간 초과 ${lags.filter(x=>x>24).length}건`);
un.sort((a,b)=>b.days-a.days);
console.log(`\n무응답 상위 12건:`);
for(const u of un.slice(0,12)) console.log(`  ${u.days.toFixed(0).padStart(3)}일 [${u.ch}] ${u.text.slice(0,110)}`);
import fs from "node:fs"; fs.writeFileSync("unanswered.json",JSON.stringify(un,null,1));
