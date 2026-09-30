const T=process.env.SLACK_BOT_TOKEN;
const api=async(m,p={})=>{const u=new URL(`https://slack.com/api/${m}`);for(const[k,v]of Object.entries(p))u.searchParams.set(k,v);
 return (await fetch(u,{headers:{Authorization:`Bearer ${T}`}})).json();};
const CH="C058T0ZNSES", TS="1790303248.177129";
const info=await api("conversations.info",{channel:CH});
console.log("채널:", info.ok?`${info.channel.name} (${info.channel.is_private?"비공개":"공개"}, 멤버 ${info.channel.num_members??"?"})`:`조회 실패 ${info.error}`);
const r=await api("conversations.replies",{channel:CH,ts:TS,limit:"200"});
if(!r.ok){ console.log("스레드 조회 실패:", r.error); process.exit(0); }
const ids=[...new Set((r.messages||[]).map(m=>m.user).filter(Boolean))];
const names={};
for(const id of ids){ const u=await api("users.info",{user:id}); names[id]=u.ok?(u.user.real_name||u.user.name):id; }
const bots={};
for(const b of [...new Set((r.messages||[]).map(m=>m.bot_id).filter(Boolean))]){ const x=await api("bots.info",{bot:b}); bots[b]=x.ok?x.bot.name:b; }
console.log(`메시지 ${r.messages.length}건\n`);
for(const m of r.messages){
  const who=m.user?names[m.user]:(bots[m.bot_id]||"bot");
  const t=new Date((Number(m.ts)+9*3600)*1000).toISOString().replace("T"," ").slice(5,16);
  console.log(`── ${t} ${who}`);
  console.log(String(m.text||"").replace(/\n/g,"\n   ").slice(0,1400));
  if(m.files?.length) console.log(`   [첨부 ${m.files.length}: ${m.files.map(f=>f.name).join(", ").slice(0,120)}]`);
  console.log();
}
