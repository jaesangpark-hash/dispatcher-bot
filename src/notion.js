// 노션 읽기(read-only). 통합 토큰 = dispatcher .env의 NOTION_TOKEN (없으면 "미설정" 에러).
// 통합에 공유된 페이지/DB만 보임 (시트 SA 공유와 동일 모델).
const NOTION_VERSION = "2022-06-28";

function token() {
  const t = process.env.NOTION_TOKEN;
  if (!t) throw new Error("NOTION_TOKEN 미설정 — .env에 통합 토큰(ntn_…) 추가 + 페이지를 통합에 공유 필요");
  return t;
}
const H = () => ({ Authorization: `Bearer ${token()}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" });

function titleOf(o) {
  const props = o.properties || {};
  for (const k in props) { if (props[k]?.type === "title") return (props[k].title || []).map((t) => t.plain_text).join("") || "(제목 없음)"; }
  if (Array.isArray(o.title)) return o.title.map((t) => t.plain_text).join("");
  return "(제목 없음)";
}

// 키워드로 페이지/DB 검색 → [{id, type, title, url}]
export async function search(query) {
  const r = await fetch("https://api.notion.com/v1/search", { method: "POST", headers: H(), body: JSON.stringify({ query, page_size: 10 }) });
  const j = await r.json();
  if (j.object === "error") throw new Error(`Notion: ${j.message}`);
  return (j.results || []).map((o) => ({ id: o.id, type: o.object, title: titleOf(o), url: o.url }));
}

function lineOf(b) {
  const t = b.type;
  const txt = (b[t]?.rich_text || []).map((x) => x.plain_text).join("");
  const pre = t.startsWith("heading_") ? "#".repeat(Number(t.slice(-1))) + " "
    : (t.includes("list_item") || t === "to_do") ? "- "
    : t === "quote" ? "> " : "";
  return pre + txt;
}
async function blocksText(blockId, depth) {
  if (depth > 3) return "";
  const r = await fetch(`https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`, { headers: H() });
  const j = await r.json();
  if (j.object === "error") throw new Error(`Notion: ${j.message}`);
  let out = "";
  for (const b of (j.results || [])) {
    const line = lineOf(b);
    if (line.trim()) out += line + "\n";
    if (b.has_children) out += await blocksText(b.id, depth + 1);
  }
  return out;
}

// 페이지 본문을 텍스트로 (블록 펼침, 최대 ~12k자)
export async function readPage(pageId) {
  const text = await blocksText(pageId, 0);
  return { id: pageId, text: text.slice(0, 12000), truncated: text.length > 12000 };
}
