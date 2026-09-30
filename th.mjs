const T=process.env.SLACK_BOT_TOKEN, ME="U04463JR4HH";
const api=async(m,p={})=>{const u=new URL(`https://slack.com/api/${m}`);for(const[k,v]of Object.entries(p))u.searchParams.set(k,v);
 const r=await fetch(u,{headers:{Authorization:`Bearer ${T}`}}); return r.json();};
const CH=[["C09B8QHP7D4","재팬_요청"],["C09AUQN8GEB","재팬_작업요청"],["C06SUD5AFE1","toon-원본재수급"],
 ["C09B8QBEC9L","재팬_리테이크"],["C0ARUR4MHHN","재팬_납품전-체크"],["C09B8QLR5FG","재팬_공지"],
 ["C0B1F6FJCAE","재팬_apm-alerts"],["C09J01N8NAG","piccoma_delivery_notice"]];
const since=Math.floor((Date.now()-90*86400000)/1000);
let tot=0;
for(const [id,name] of CH){
  let cur,par=[]; do{ const r=await api("conversations.history",{channel:id,limit:"200",oldest:String(since),...(cur?{cursor:cur}:{})});
   if(!r.ok){console.error(name,r.error);break;} par=par.concat(r.messages||[]); cur=r.has_more?r.response_metadata?.next_cursor:null; }while(cur&&par.length<3000);
  const th=par.filter(m=>(m.reply_count||0)>0);
  console.log(`${name.padEnd(24)} 부모 ${String(par.length).padStart(5)} · 스레드 ${String(th.length).padStart(4)} · 총답글 ${th.reduce((s,m)=>s+(m.reply_count||0),0)}`);
  tot+=th.length;
}
console.log("\n열어야 할 스레드 총:", tot);
