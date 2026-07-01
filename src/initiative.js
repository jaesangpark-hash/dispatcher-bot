// Initiative Engine (V3) — 슬라이스① "조언 모드"
// 배경에서 '지금 재상님께 먼저 말할 가치가 있는가'만 판단해, 넘으면 조언을 DM한다.
// ★핵심 안전장치: 판단을 '도구 없는(allowedTools:[]) 1회 LLM 호출'로 돌린다 →
//   구조적으로 아무것도 실행/변경/발송할 수 없고 오직 조언 텍스트만 낸다. 기본값=침묵.
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const MODEL_FILE = path.join(DIR, "user-model.json");   // 판단 헌장·정책 시드
const LOG_FILE = path.join(DIR, "initiative-log.jsonl"); // 발화/침묵 결정 + 근거(평가 루프용)
const STATE_FILE = path.join(DIR, "initiative-state.json");

export function loadUserModel() {
  try { return JSON.parse(fs.readFileSync(MODEL_FILE, "utf8")); } catch { return null; }
}
function log(o) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n"); } catch {}
}

// 하루 1회 게이트 — 지정 시각(hour) 이후 그날 첫 tick에서만 true.
export function dueDailyInitiative(hour) {
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  const now = new Date();
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (now.getHours() < hour) return false;
  if (st.lastDate === ymd) return false;
  st.lastDate = ymd;
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(st)); } catch {}
  return true;
}

function parseVerdict(raw) {
  const s = String(raw || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return { speak: false, reason: "parse-fail", raw: s.slice(0, 200) };
}

// 도구 없는 1회 판단 호출 — 실행 수단 없음(조언만).
async function askVerdict(model, systemPrompt, prompt) {
  const q = query({ prompt, options: { model, systemPrompt, strictMcpConfig: true, allowedTools: [] } });
  let buf = "";
  for await (const m of q) {
    if (m.type === "assistant") { for (const b of m.message?.content || []) if (b.type === "text" && b.text) buf += b.text; }
    else if (m.type === "result") return (m.result || buf || "").trim();
  }
  return buf.trim();
}

// signals: 운영 신호 스냅샷(객체). 반환: { speak, topic, message, reason }
export async function runInitiative({ model, nowStr, signals }) {
  const um = loadUserModel();
  if (!um) { log({ skipped: "no user-model" }); return { speak: false, skipped: true }; }
  const sys = [
    "너는 툰식이(중일 PM 보조 에이전트)의 '배경 판단기'다. 사용자(재상)가 부르지 않았는데, 화면 뒤에서 '지금 먼저 말할 가치가 있는가'만 판단한다.",
    "★너에겐 도구가 없다. 아무것도 실행·변경·발송할 수 없고, 오직 조언 텍스트만 낸다. 실행과 최종 결정은 재상이 한다.",
    "아래 사용자 모델(판단 헌장·정책)을 절대 규칙으로 따른다. 특히 default_behavior(침묵 기본)·operational_guardrails·silence_zones·do_not_speak_when 을 엄수한다:",
    JSON.stringify(um),
    "판단식: speech_value = relevance × timing × novelty − interruption_cost. 임계값(high)을 확실히 넘을 때만 speak=true. 조금이라도 애매하면 침묵(speak=false). 대부분의 경우 침묵이 정답이다.",
    "speak=true면 message는 재상님께 보낼 담백한 한국어 조언/알림(2~4문장, 근거 포함, 명령이 아니라 제안). 내부 구현·도구명·파일경로는 노출하지 않는다.",
    "출력은 오직 JSON 한 줄. 형식: {\"speak\": true|false, \"topic\": \"짧은 주제\", \"message\": \"재상님께 보낼 조언(speak=false면 빈 문자열)\", \"reason\": \"판단 근거\"}",
  ].join("\n\n");
  const prompt = `[현재 시각(KST): ${nowStr}]\n\n[운영 신호 스냅샷]\n${JSON.stringify(signals)}\n\n지금 재상님께 먼저 말할 가치가 있나? 엄격히 판단하고 JSON만 출력.`;
  let verdict;
  try { verdict = parseVerdict(await askVerdict(model, sys, prompt)); }
  catch (e) { log({ error: String(e?.message ?? e) }); return { speak: false, error: String(e?.message ?? e) }; }
  log({ signalsSummary: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])), verdict });
  return verdict;
}
