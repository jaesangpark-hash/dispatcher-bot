const T=process.env.SLACK_BOT_TOKEN, ME="U04463JR4HH";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function api(m,p={},tries=0){
  const u=new URL(`https://slack.com/api/${m}`); for(const[k,v]of Object.entries(p))u.searchParams.set(k,v);
  const r=await fetch(u,{headers:{Authorization:`Bearer ${T}`}});
  if(r.status===429){ const w=Number(r.headers.get("retry-after")||5); await sleep((w+1)*1000); return api(m,p,tries+1); }
  const j=await r.json();
  if(!j.ok && j.error==="ratelimited" && tries<5){ await sleep(6000); return api(m,p,tries+1); }
  return j;
}
const CH=[["C09B8QHP7D4","재팬_요청"],["C09AUQN8GEB","재팬_작업요청"],["C06SUD5AFE1","toon-원본재수급"],
 ["C09B8QBEC9L","재팬_리테이크"],["C0ARUR4MHHN","재팬_납품전-체크"],["C09B8QLR5FG","재팬_공지"]];
const since=Math.floor((Date.now()-90*86400000)/1000);
const out=[];
for(const [id,name] of CH){
  let cur,par=[]; do{ const r=await api("conversations.history",{channel:id,limit:"200",oldest:String(since),...(cur?{cursor:cur}:{})});
   if(!r.ok) break; par=par.concat(r.messages||[]); cur=r.has_more?r.response_metadata?.next_cursor:null; }while(cur&&par.length<3000);
  const th=par.filter(m=>(m.reply_count||0)>0);
  let n=0;
  for(const p of th){
    const r=await api("conversations.replies",{channel:id,ts:p.thread_ts||p.ts,limit:"200"});
    await sleep(1200);
    if(!r.ok) continue;
    for(const m of (r.messages||[]).slice(1)){
      if(m.user===ME) continue;
      if(!String(m.text||"").includes(`<@${ME}>`)) continue;
      out.push({ch:name, k:m.bot_id?`bot:${m.bot_id}`:`user:${m.user}`, ts:m.ts,
        parent:String(p.text||"").replace(/\s+/g," ").slice(0,120),
        text:String(m.text||"").replace(/\s+/g," ").slice(0,400)});
      n++;
    }
  }
  console.log(`${name}: 스레드 ${th.length} → 재상 멘션 댓글 ${n}건`);
}
import fs from "node:fs"; fs.writeFileSync("thread-mentions.json", JSON.stringify(out,null,1));
console.log("완료 — 총", out.length, "건 → thread-mentions.json");
