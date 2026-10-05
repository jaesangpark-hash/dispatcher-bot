// 런타임 학습 — 재상 님이 "기억해/외워둬"로 가르친 규칙·별칭·교정을 파일에 저장.
// 부팅 때 시스템 프롬프트에 주입되어 재기동에도 유지된다(인메모리 세션이 꺼져도 안 날아감).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = path.join(DIR, "learned.json");

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { items: [] }; } }
function save(d) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }

// 비슷한 규칙 찾기 — 완전 일치만 보면 "같은 말 다르게 쓴" 규칙이 계속 쌓인다.
// 조사·공백·문장부호를 턴 뒤 2글자 묶음(bigram)으로 겹침 비율을 본다.
const normTokens = (s) => {
  const t = String(s || "").toLowerCase().replace(/[\s.,!?~…·"'`()[\]「」『』【】:;/\\-]/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
function similarity(a, b) {
  const A = normTokens(a), B = normTokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);     // 짧은 쪽 기준 — 긴 규칙에 짧은 규칙이 흡수된 경우도 잡는다
}

// 임계값 0.45 — 라이브 규칙 11건(55쌍)을 실측하니 서로 다른 규칙끼리는 최대 0.33이었고,
// 같은 말을 바꿔 쓴 쌍은 0.50 나왔다. 그 사이에 둔다. (의미만 같고 표현이 완전히 다른
// 중복·상충은 이 방식으로 못 잡는다 — 그건 주간 자가 정리가 맡는다.)
export function findSimilar(text, threshold = 0.45) {
  return load().items
    .map((x) => ({ id: x.id, text: x.text, score: Number(similarity(text, x.text).toFixed(2)) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/**
 * @param {string} text        저장할 규칙
 * @param {object} [opt]
 * @param {boolean} [opt.force]   비슷한 규칙이 있어도 그냥 추가
 * @param {number}  [opt.replace] 이 id의 규칙을 지우고 대체
 */
export function addLearned(text, opt = {}) {
  const d = load();
  const t = String(text || "").trim();
  if (!t) return { error: "내용 없음" };
  if (d.items.some((x) => x.text === t)) return { dup: true, total: d.items.length };

  // ★비슷한 규칙이 있으면 바로 저장하지 않는다 — 합칠지/대체할지 사람이 정해야 한다.
  if (!opt.force && opt.replace == null) {
    const similar = findSimilar(t);
    if (similar.length) return { needsDecision: true, similar, total: d.items.length };
  }

  let replaced = null;
  if (opt.replace != null) {
    const hit = d.items.find((x) => x.id === Number(opt.replace));
    if (hit) { replaced = hit.text; d.items = d.items.filter((x) => x.id !== Number(opt.replace)); }
  }
  const id = d.items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  d.items.push({ id, text: t, at: new Date().toISOString() });
  save(d);
  return { id, total: d.items.length, ...(replaced ? { replaced } : {}) };
}

export function removeLearned(match) {
  const d = load();
  const m = String(match).trim();
  const byId = /^\d+$/.test(m) ? Number(m) : null;
  const hit = (x) => (byId != null ? x.id === byId : x.text.includes(m));
  const removed = d.items.filter(hit);
  d.items = d.items.filter((x) => !hit(x));
  save(d);
  return { removed: removed.map((x) => x.text), remaining: d.items.length };
}

export function listLearned() { return load().items; }

// 규칙이 바뀌었는지 알아내는 값 — 세션 시작 뒤 바뀌면 그 턴에 다시 주입해 즉시 적용한다.
export function learnedSignature() {
  const items = load().items;
  return `${items.length}:${items.reduce((m, x) => Math.max(m, x.id), 0)}:${items.map((x) => x.text.length).reduce((a, b) => a + b, 0)}`;
}

// 시스템 프롬프트에 붙일 학습 블록(없으면 null). 부팅 시 startSession에서 사용.
export function learnedPromptBlock() {
  const items = load().items;
  if (!items.length) return null;
  return "★재상 님이 직접 가르친 규칙·교정(학습됨 — 기본 지침과 충돌 시 이걸 우선):\n" +
    items.map((x) => `• ${x.text}`).join("\n");
}
