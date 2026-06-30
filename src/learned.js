// 런타임 학습 — 재상 님이 "기억해/외워둬"로 가르친 규칙·별칭·교정을 파일에 저장.
// 부팅 때 시스템 프롬프트에 주입되어 재기동에도 유지된다(인메모리 세션이 꺼져도 안 날아감).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = path.join(DIR, "learned.json");

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { items: [] }; } }
function save(d) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }

export function addLearned(text) {
  const d = load();
  const t = String(text || "").trim();
  if (!t) return { error: "내용 없음" };
  if (d.items.some((x) => x.text === t)) return { dup: true, total: d.items.length };
  const id = d.items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  d.items.push({ id, text: t, at: new Date().toISOString() });
  save(d);
  return { id, total: d.items.length };
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

// 시스템 프롬프트에 붙일 학습 블록(없으면 null). 부팅 시 startSession에서 사용.
export function learnedPromptBlock() {
  const items = load().items;
  if (!items.length) return null;
  return "★재상 님이 직접 가르친 규칙·교정(학습됨 — 기본 지침과 충돌 시 이걸 우선):\n" +
    items.map((x) => `• ${x.text}`).join("\n");
}
