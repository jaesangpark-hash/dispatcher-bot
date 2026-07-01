// 재촉 리마인더 저장소 — 재상 님이 "기억해둬"한 일을 모아두고, 매일 안 끝난 것만 재촉(DM).
// 시간 매번 설정 불필요(데일리 자동). 완료라고 하면 지움.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = path.join(DIR, "reminders.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return { items: [], lastNagSlot: null }; }
}
function save(d) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
}

export function addReminder(text, link = null) {
  const d = load();
  const id = d.items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  d.items.push({ id, text: String(text).trim(), createdAt: new Date().toISOString(), link: link || null });
  save(d);
  return { id, total: d.items.length };
}

// 시각 지정 1회 리마인더. dueAt = ISO8601. 유효·미래가 아니면 에러 반환.
export function addScheduled(text, dueAtISO, link = null) {
  const t = new Date(dueAtISO);
  if (isNaN(t.getTime())) return { error: `시각 해석 실패: '${dueAtISO}' (ISO8601 필요)` };
  const d = load();
  const id = d.items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  d.items.push({ id, text: String(text).trim(), createdAt: new Date().toISOString(), dueAt: t.toISOString(), link: link || null });
  save(d);
  return { id, dueAt: t.toISOString(), total: d.items.length };
}

export function listReminders() {
  return load().items;
}

// 번호(정확 일치) 또는 텍스트(부분 일치)로 완료 처리(삭제)
export function completeReminder(match) {
  const d = load();
  const m = String(match).trim();
  const byId = /^\d+$/.test(m) ? Number(m) : null;
  const hit = (x) => (byId != null ? x.id === byId : x.text.includes(m));
  const removed = d.items.filter(hit);
  d.items = d.items.filter((x) => !hit(x));
  save(d);
  return { removed, done: removed.length, remaining: d.items.length };
}

// 재촉 시각 슬롯이 새로 도래했는지 판단 + 마킹(하루 시각별 1회). 보낼 내용 유무와 무관 —
// 개인 재촉 + 문의/재수급 미해결을 한 슬롯에서 같이 보내기 위해 슬롯 게이트만 담당.
// nagHours: 시각 배열(예 [9,14,18]). 새 슬롯이면 키 반환(+마킹), 아니면 null. lastNagSlot="YYYY-MM-DD:HH".
export function dueNagSlot(nagHours) {
  const d = load();
  const now = new Date();
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const hours = (Array.isArray(nagHours) ? nagHours : [nagHours]).map(Number).filter((h) => !isNaN(h)).sort((a, b) => a - b);
  const slot = hours.filter((h) => now.getHours() >= h).pop();   // 지금 이하 중 가장 늦은 슬롯
  if (slot == null) return null;                 // 첫 슬롯 시각 전
  const key = `${ymd}:${slot}`;
  if (d.lastNagSlot === key) return null;        // 이 슬롯 이미 처리함
  d.lastNagSlot = key; save(d);
  return key;
}

// 재촉 대상(시각 미지정 = dueAt 없는 것만)
export function listNagItems() {
  return load().items.filter((x) => !x.dueAt);
}

// 시각 도래한 1회 리마인더(dueAt <= now)를 꺼내 반환 + 저장소에서 제거(1회성).
export function dueScheduled() {
  const d = load();
  const now = Date.now();
  const isDue = (x) => x.dueAt && new Date(x.dueAt).getTime() <= now;
  const fired = d.items.filter(isDue);
  if (!fired.length) return [];
  d.items = d.items.filter((x) => !isDue(x));
  save(d);
  return fired;
}
