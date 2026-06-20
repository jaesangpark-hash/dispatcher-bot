// 진단용: 슬랙 없이 실제 query_sheet 도구로 그 질문을 재현. 각 단계 경과시간 로그.
import "dotenv/config";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { queryView, VIEWS, VIEW_CATALOG } from "./src/sheets-registry.js";

if (!process.env.ANTHROPIC_API_KEY) delete process.env.ANTHROPIC_API_KEY;
const t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
console.log(el(), "시작. OAUTH:", Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), "모델:", process.env.DISPATCHER_MODEL || "claude-sonnet-4-6");

let calls = 0;
const apmTools = createSdkMcpServer({
  name: "apm", version: "1.0.0",
  tools: [
    tool("query_sheet", `운영 시트 뷰 조회(read-only).\n${VIEW_CATALOG}`,
      {
        view: z.enum(Object.keys(VIEWS)), work: z.string().optional(), limit: z.number().optional(),
        filterField: z.string().optional(), filterOp: z.enum(["empty", "notEmpty", "eq", "neq", "contains"]).optional(), filterValue: z.string().optional(),
        distinct: z.array(z.string()).optional(), dateField: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(),
      },
      async (a) => {
        calls++;
        console.log(el(), `[도구호출 #${calls}]`, JSON.stringify(a));
        try {
          const where = a.filterField ? { field: a.filterField, op: a.filterOp ?? "empty", value: a.filterValue ?? "" } : null;
          const dateRange = a.dateField ? { field: a.dateField, from: a.dateFrom ?? null, to: a.dateTo ?? null } : null;
          const r = await queryView(a.view, { needle: a.work ?? null, limit: a.limit ?? 50, where, dateRange, distinct: a.distinct ?? null });
          console.log(el(), `  → matched ${r.matched}, returned ${r.returned}`);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        } catch (e) {
          console.log(el(), `  → 에러: ${e.message}`);
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      }, { annotations: { readOnlyHint: true } }),
  ],
});

const q = query({
  prompt: "배정 현황 탭에서 진행 중인 작품이 몇 개야? 처음 3개만 작품명이랑 APM 알려줘",
  options: {
    model: process.env.DISPATCHER_MODEL || "claude-sonnet-4-6",
    systemPrompt: "운영 어시스턴트. query_sheet로 실제 시트를 조회해 답하라. '회차'는 distinct 작품+회차, 기간 언급 시 dateField 사용.",
    mcpServers: { apm: { type: "sdk", name: "apm", instance: apmTools.instance } },
    allowedTools: ["mcp__apm__query_sheet"],
  },
});

let result = "";
for await (const m of q) {
  if (m.type === "assistant") { for (const b of m.message.content || []) if (b.type === "text" && b.text.trim()) console.log(el(), "assistant text:", b.text.slice(0, 100)); }
  else if (m.type === "result") result = m.result ?? "";
  else console.log(el(), "msg:", m.type);
}
console.log(el(), "===== 끝 =====\n도구 호출 횟수:", calls, "\n최종:", result.slice(0, 500));
