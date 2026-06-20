// 진단용: 영속(스트리밍) 세션 검증 — 메시지 2개 보내 지연/정답/순서 확인.
import "dotenv/config";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { lookupDelivery } from "./src/delivery.js";
import { lookupWork } from "./src/works.js";
import { queryView, VIEWS, VIEW_CATALOG } from "./src/sheets-registry.js";
if (!process.env.ANTHROPIC_API_KEY) delete process.env.ANTHROPIC_API_KEY;

const inbox = [], pending = []; let wake = null;
async function* ms() { while (true) { if (!inbox.length) await new Promise((r) => { wake = r; }); while (inbox.length) yield { type: "user", message: { role: "user", content: inbox.shift() } }; } }
const wrap = (fn) => async (a) => { try { return { content: [{ type: "text", text: JSON.stringify(await fn(a)) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } };

const apmTools = createSdkMcpServer({
  name: "apm", version: "1.0.0",
  tools: [
    tool("get_delivery_date", "납품일 조회", { work: z.string(), episode: z.string().optional(), lang: z.enum(["zh-ja", "ko-ja"]).optional() },
      wrap(({ work, episode, lang }) => lookupDelivery({ work, episode: episode ?? "latest", lang: lang ?? "zh-ja" })), { annotations: { readOnlyHint: true } }),
    tool("get_work_info", "작품정보(PIVO·타이틀·APM)", { query: z.string() }, wrap(({ query: q }) => lookupWork(q)), { annotations: { readOnlyHint: true } }),
    tool("query_sheet", `시트 뷰 조회\n${VIEW_CATALOG}`, { view: z.enum(Object.keys(VIEWS)), work: z.string().optional(), limit: z.number().optional(), filterField: z.string().optional(), filterOp: z.enum(["empty", "notEmpty", "eq", "neq", "contains"]).optional(), filterValue: z.string().optional(), distinct: z.array(z.string()).optional(), dateField: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional() },
      wrap((a) => queryView(a.view, { needle: a.work ?? null, limit: a.limit ?? 50, where: a.filterField ? { field: a.filterField, op: a.filterOp ?? "empty", value: a.filterValue ?? "" } : null, dateRange: a.dateField ? { field: a.dateField, from: a.dateFrom ?? null, to: a.dateTo ?? null } : null, distinct: a.distinct ?? null })), { annotations: { readOnlyHint: true } }),
  ],
});

const session = query({ prompt: ms(), options: { model: process.env.DISPATCHER_MODEL || "claude-sonnet-4-6", systemPrompt: "운영 어시스턴트. 도구로 실제 값을 조회해 간결히 답하라.", mcpServers: { apm: { type: "sdk", name: "apm", instance: apmTools.instance } }, allowedTools: ["mcp__apm__get_delivery_date", "mcp__apm__get_work_info", "mcp__apm__query_sheet"] } });
(async () => { let buf = ""; for await (const m of session) { if (m.type === "assistant") { for (const b of m.message?.content || []) if (b.type === "text") buf += b.text; } else if (m.type === "result") { const p = pending.shift(); const t = (m.result || buf).trim(); buf = ""; if (p) p.resolve(t); } } })();

function ask(text) { return new Promise((resolve) => { pending.push({ resolve }); inbox.push(text); if (wake) { const w = wake; wake = null; w(); } }); }

let s = Date.now();
const r1 = await ask("야수의 왕 55화 납품일 알려줘");
console.log(`[msg1] ${((Date.now() - s) / 1000).toFixed(1)}s → ${r1.slice(0, 90).replace(/\n/g, " ")}`);
s = Date.now();
const r2 = await ask("기묘한 서점 PIVO ID는?");
console.log(`[msg2] ${((Date.now() - s) / 1000).toFixed(1)}s → ${r2.slice(0, 90).replace(/\n/g, " ")}`);
console.log("→ msg2가 msg1보다 빠르면 콜드스타트 제거 성공(세션 재사용 OK)");
process.exit(0);
