// 대화 증류 — 하루치 대화를 훑어 '재상 님이 결국 원했던 것'을 규칙 후보로 뽑는다.
//
// 배경(2026-09-22, bot.log 7/6~9/4 실측):
//   전체 451개 대화 중 113개가 3턴 이상이고, 길어진 대화는 거의 예외 없이
//   "처음 시킨 것 → 되묻기 → 마지막에 원하는 형태 확정" 구조였다.
//   예) "고객사 문의 초안 띄워줘" → "고객사는 일본 기업이니까 일본어로 보내줘야지 친구야"
//   이런 건 매번 다시 말해야 했는데 learned.json 에는 한 줄도 없었다(7건·마지막 7/2).
//
// ★안전장치: 후보 생성은 initiative.js 와 같이 '도구 없는(allowedTools:[]) 1회 LLM 호출'이다.
//   구조적으로 아무것도 실행·발송·변경할 수 없고 텍스트만 낸다. 규칙화는 재상 님 승인 뒤에만.
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const TURNS = path.join(DIR, "turns.jsonl");            // 대화 원장(턴 단위)
const CAND = path.join(DIR, "distill-candidates.json"); // 규칙 후보
const STATE = path.join(DIR, "distill-state.json");     // 하루 1회 게이트

const MAX_TURN_CHARS = 700;     // 한 턴이 길어도 여기까지만 저장(첨부 덤프·긴 목록 방어)
const KEEP_DAYS = 14;           // 원장 보존 기간

function kst(d = new Date()) { return new Date(d.getTime() + 9 * 3600 * 1000); }
export function kstDay(d = new Date()) {
  const k = kst(d);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}-${String(k.getUTCDate()).padStart(2, "0")}`;
}
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } }
function writeJson(f, o) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch {} }

// ── 원장 기록 ────────────────────────────────────────────────────
function append(rec) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(TURNS, JSON.stringify(rec) + "\n"); } catch {}
}
const clip = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, MAX_TURN_CHARS);

export function recordTurn({ channel, threadTs, user, text }) {
  if (!text) return;
  append({ at: new Date().toISOString(), day: kstDay(), role: "user", channel, thread: threadTs || null, user: user || null, text: clip(text) });
}
export function recordReply({ channel, threadTs, text, ms, isError }) {
  append({ at: new Date().toISOString(), day: kstDay(), role: "bot", channel, thread: threadTs || null, text: clip(text), ms: ms ?? null, isError: !!isError });
}

// 원장 정리 — KEEP_DAYS 넘은 줄은 버린다(개인 대화라 오래 쌓아두지 않는다).
export function pruneTurns(keepDays = KEEP_DAYS) {
  try {
    const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
    const kept = fs.readFileSync(TURNS, "utf8").split("\n").filter((l) => {
      if (!l.trim()) return false;
      try { return JSON.parse(l).at >= cutoff; } catch { return false; }
    });
    fs.writeFileSync(TURNS, kept.join("\n") + "\n");
    return kept.length;
  } catch { return 0; }
}

// ── 마찰 신호 — 학습 가치가 높은 스레드를 앞으로 올리는 가중치로만 쓴다(버리지 않는다) ──
const FRICTION = [
  /^\s*아니/, /그게\s*아니/, /(했|하)잖(아|나)/, /라니까/, /말했잖/,
  /내가\s*(말한|제시한|시킨|얘기한)/, /아까\s*(말한|시킨|얘기)/,
  /그거\s*말고/, /말고\s/, /다시\s*(해|봐|확인|계산)/,
  /왜\s*(안|못|자꾸|계속)/, /못\s*(읽|찾|하|봐|알)/, /몰라\?/,
  /이해\s*(못|안)/, /틀렸/, /아니야/, /됐어|그만|관두/,
];
export const frictionScore = (t) => FRICTION.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);

// ── 하루치 대화를 스레드 단위로 묶기 ────────────────────────────
export function threadsOfDay(day) {
  let lines = [];
  try { lines = fs.readFileSync(TURNS, "utf8").split("\n"); } catch { return []; }
  const rows = [];
  for (const l of lines) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r.day === day) rows.push(r); } catch {} }
  const by = new Map();
  for (const r of rows) {
    const key = `${r.channel}|${r.thread || "-"}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  const out = [];
  for (const [key, seq] of by) {
    const users = seq.filter((r) => r.role === "user");
    if (users.length < 2) continue;                       // 한 번에 끝난 대화는 배울 게 없다
    const fric = users.reduce((n, r) => n + frictionScore(r.text), 0);
    out.push({ key, channel: seq[0].channel, turns: seq, userTurns: users.length, friction: fric });
  }
  // 마찰이 크고 긴 대화부터
  out.sort((a, b) => (b.friction - a.friction) || (b.userTurns - a.userTurns));
  return out;
}

// ── 후보 저장소 ──────────────────────────────────────────────────
export function listCandidates(status) {
  const d = readJson(CAND, { items: [] });
  return status ? d.items.filter((x) => x.status === status) : d.items;
}
export function addCandidates(items, day) {
  const d = readJson(CAND, { items: [] });
  let id = d.items.reduce((m, x) => Math.max(m, x.id), 0);
  const added = [];
  for (const it of items) {
    const rule = String(it.rule || "").trim();
    if (!rule) continue;
    if (d.items.some((x) => x.rule === rule)) continue;   // 같은 규칙 중복 방지
    const rec = { id: ++id, day, rule, why: String(it.why || "").trim(), kind: it.kind || "기타", status: "pending", at: new Date().toISOString() };
    d.items.push(rec); added.push(rec);
  }
  writeJson(CAND, d);
  return added;
}
export function setCandidateStatus(id, status) {
  const d = readJson(CAND, { items: [] });
  const hit = d.items.find((x) => x.id === Number(id));
  if (!hit) return { error: `후보 ${id} 없음` };
  hit.status = status; hit.decidedAt = new Date().toISOString();
  writeJson(CAND, d);
  return hit;
}

// ── 하루 1회 게이트 ──────────────────────────────────────────────
export function dueDailyDistill(hour) {
  const st = readJson(STATE, {});
  const day = kstDay();
  if (kst().getUTCHours() < hour) return false;
  if (st.lastDate === day) return false;
  st.lastDate = day; writeJson(STATE, st);
  return true;
}

// ── 증류 — 도구 없는 1회 판단 호출 ──────────────────────────────
const SYS = [
  "너는 툰식이(중일 PM 보조 에이전트)의 '대화 증류기'다. 어제 하루치 대화를 읽고,",
  "재상 님이 **결국 원했던 것**을 다음에는 처음부터 맞히기 위한 규칙 후보만 뽑는다.",
  "★너에겐 도구가 없다. 아무것도 실행·변경·발송할 수 없고 텍스트만 낸다. 규칙 채택은 재상 님이 한다.",
  "",
  "대화는 보통 이렇게 흐른다: 처음 시킨 것 → (툰식이가 빗나감) → 되묻기·정정 → 마지막에 원하는 형태 확정.",
  "**마지막 턴과 정정 턴에 답이 있다.** 거기서 다음 세 가지만 찾는다.",
  "  · 지칭     — 재상 님이 쓰는 말이 실제로 무엇을 가리키는가 (예: '고객사 스케쥴 시트'가 어느 시트인지)",
  "  · 기본값   — 매번 다시 말해야 했던 암묵 전제 (예: 고객사에 보내는 문구는 일본어)",
  "  · 후속행동 — A를 시키면 거의 항상 B가 따라붙는 패턴 (예: 납품일 조회 뒤엔 APM 확인)",
  "",
  "규칙은 다음에 그대로 지킬 수 있게 **한 문장 명령형**으로 쓴다. 근거가 대화에 없으면 만들지 마라.",
  "한 번뿐인 요청, 그날만 유효한 일회성 지시, 이미 잘 처리된 대화는 후보로 올리지 않는다.",
  "확신이 없으면 비운다 — 빈 배열이 정상이고, 많이 뽑는 게 목적이 아니다.",
  "",
  '출력은 JSON만: {"candidates":[{"kind":"지칭|기본값|후속행동","rule":"<한 문장>","why":"<근거가 된 발화 요약>"}]}',
].join("\n");

function renderThreads(threads, maxThreads, maxChars) {
  const out = [];
  let used = 0;
  for (const t of threads.slice(0, maxThreads)) {
    const body = t.turns.map((r) => `${r.role === "user" ? "재상" : "툰식이"}: ${r.text}`).join("\n");
    const blk = `--- 대화 (채널 ${t.channel} · 사용자 ${t.userTurns}턴 · 마찰 ${t.friction}) ---\n${body}`;
    if (used + blk.length > maxChars) break;
    out.push(blk); used += blk.length;
  }
  return out.join("\n\n");
}

export async function runDistill({ model, day, maxThreads = 12, maxChars = 24000, known = [] }) {
  const threads = threadsOfDay(day);
  if (!threads.length) return { skipped: "대화 없음", day, threads: 0 };
  const body = renderThreads(threads, maxThreads, maxChars);
  const knownBlk = known.length ? `\n\n[이미 학습된 규칙 — 같은 내용은 다시 올리지 마라]\n${known.map((k) => "- " + k).join("\n")}` : "";
  const prompt = `[${day} 대화]\n${body}${knownBlk}\n\n위 기준으로 규칙 후보를 JSON으로만 출력하라.`;
  const q = query({ prompt, options: { model, systemPrompt: SYS, strictMcpConfig: true, allowedTools: [] } });
  let buf = "";
  for await (const m of q) {
    if (m.type === "assistant") { for (const b of m.message?.content || []) if (b.type === "text" && b.text) buf += b.text; }
    else if (m.type === "result") { buf = (m.result || buf || "").trim(); break; }
  }
  let parsed = null;
  const s = buf.replace(/```json|```/g, "").trim();
  try { parsed = JSON.parse(s); } catch { const mm = s.match(/\{[\s\S]*\}/); if (mm) { try { parsed = JSON.parse(mm[0]); } catch {} } }
  const cands = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const added = addCandidates(cands, day);
  return { day, threads: threads.length, proposed: cands.length, added: added.length, items: added };
}
