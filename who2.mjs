const T=process.env.SLACK_BOT_TOKEN;
const api=async(m,p={})=>{const u=new URL(`https://slack.com/api/${m}`);for(const[k,v]of Object.entries(p))u.searchParams.set(k,v);
 return (await fetch(u,{headers:{Authorization:`Bearer ${T}`}})).json();};
import fs from "node:fs";
const all=JSON.parse(fs.readFileSync("thread-mentions.json","utf8"));
const cnt={}; for(const m of all) cnt[m.k]=(cnt[m.k]||0)+1;
console.log("댓글로 재상 멘션한 발신자:");
for(const [k,v] of Object.entries(cnt).sort((a,b)=>b[1]-a[1])){
  const [t,id]=k.split(":"); let nm=id;
  try{ const r=t==="bot"?await api("bots.info",{bot:id}):await api("users.info",{user:id}); nm=t==="bot"?(r.bot?.name||id):(r.user?.real_name||id); }catch{}
  const chs=[...new Set(all.filter(m=>m.k===k).map(m=>m.ch))].join(",");
  console.log(`${String(v).padStart(4)}  ${t.padEnd(4)} ${nm.slice(0,24).padEnd(26)} [${chs}]`);
}
