// 학습 규칙 자가 정리 — 쌓인 규칙을 주기적으로 되짚어 중복·상충·사문화된 것을 골라낸다.
// 채택만 계속하면 규칙이 늘기만 하고 서로 부딪히는데, 그걸 사람이 매번 훑을 수는 없다(2026-10-05).
import { query } from "@anthropic-ai/claude-agent-sdk";

const SYS = `당신은 업무 에이전트 '툰식이'의 학습 규칙을 정리하는 감사자다.
아래는 운영자(박재상)가 지금까지 가르쳐 저장한 규칙 목록이다. 이 목록만 보고 판단하라.

골라낼 것:
1) duplicate — 사실상 같은 말을 다르게 쓴 규칙 쌍·묶음
2) conflict  — 서로 어긋나 둘 다 지킬 수 없는 규칙 쌍
3) obsolete  — 너무 좁은 1회성 예외, 또는 다른 규칙에 이미 흡수된 것
4) unclear   — 무엇을 하라는 건지 실행 기준이 안 잡히는 문구

규칙:
- 확신이 없으면 올리지 마라. 애매한 것보다 적게 올리는 쪽이 낫다.
- 멀쩡한 규칙을 '정리'하자고 올리지 마라. 지우면 동작이 달라지는 규칙은 건드리지 않는다.
- duplicate·conflict는 반드시 ids에 2개 이상 담고, merged에 하나로 합친 문구를 제안하라.
- obsolete·unclear는 ids에 1개만 담는다. obsolete는 merged를 비우고, unclear는 다듬은 문구를 merged에 넣는다.

JSON 배열로만 출력(코드블록·설명 금지):
[{"kind":"duplicate|conflict|obsolete|unclear","ids":[1,2],"why":"<한 줄>","merged":"<합치거나 다듬은 문구. obsolete면 빈 문자열>"}]
문제가 없으면 [] 만 출력하라.`;

export async function runLearnedAudit({ model, items }) {
  if (!items?.length) return { skipped: "학습 규칙 없음", findings: [] };
  if (items.length < 5) return { skipped: `규칙 ${items.length}개 — 정리할 만큼 안 쌓임`, findings: [] };

  const body = items.map((x) => `${x.id}. ${x.text}`).join("\n");
  const prompt = `[학습 규칙 ${items.length}건]\n${body}\n\n위 기준으로 JSON만 출력하라.`;

  let out = "";
  const q = query({ prompt, options: { model, systemPrompt: SYS, strictMcpConfig: true, allowedTools: [] } });
  for await (const m of q) {
    if (m.type === "assistant") for (const c of (m.message?.content || [])) if (c.type === "text") out += c.text;
    if (m.type === "result") out = String(m.result || out);
  }

  let findings = [];
  try {
    findings = JSON.parse(String(out).replace(/```json|```/g, "").trim());
    if (!Array.isArray(findings)) findings = [];
  } catch { return { error: "응답 파싱 실패", raw: String(out).slice(0, 300), findings: [] }; }

  // 존재하지 않는 id를 가리키는 건 버린다(모델이 지어낸 경우)
  const known = new Set(items.map((x) => x.id));
  findings = findings.filter((f) => Array.isArray(f.ids) && f.ids.length && f.ids.every((i) => known.has(Number(i))));
  return { findings, total: items.length };
}

export function formatAudit(res, items) {
  if (!res.findings?.length) return null;
  const byId = new Map(items.map((x) => [x.id, x.text]));
  const LABEL = { duplicate: "중복", conflict: "상충", obsolete: "사문화", unclear: "모호" };
  const lines = [`🧹 *학습 규칙 점검 — ${res.total}건 중 ${res.findings.length}건 정리 제안*`];
  res.findings.forEach((f, i) => {
    lines.push(`\n*${i + 1}. [${LABEL[f.kind] || f.kind}]* ${f.why}`);
    for (const id of f.ids) lines.push(`   • #${id} ${String(byId.get(Number(id)) || "").slice(0, 110)}`);
    if (f.merged) lines.push(`   → 제안: ${f.merged}`);
  });
  lines.push(`\n정리하려면 「1번 정리해」, 그냥 두려면 「1번 놔둬」라고 말해주세요.`);
  return lines.join("\n");
}
