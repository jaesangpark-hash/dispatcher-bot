// 완결 작품 당일 알림 — 납품 V5에서 'E열(Job name) 회차 끝에 완' + 'G열 jp_end_date'를 완결일로 본다.
// 완결일이 오늘(±캐치업 며칠)인 작품을 한 번씩만 알림(notified 영속 dedup).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRange } from "./sheets.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = path.join(DIR, "completions-notified.json");
const DELIVERY_ID = "1QWCtU1GnCT2BQZvuF_N-8MnpgiyqIDTcM0x6hdCi8mQ";
const TABS = { "중일": "납품관리시트_Japan(중일 V5)" };   // 툰식이는 중일 전용 — 한일 스캔 안 함
// 컬럼: A고객사 B프로젝트명 C PM D APM E Job name(회차) F주문정보 G jp_end_date ... P pivo_id
const C = { work: 1, apm: 3, job: 4, endDate: 6, pivo: 15 };

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { keys: [], lastScan: null }; } };
const save = (d) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); };

// "351 완" / "88 番外編 완" / "70　완" → 완결 회차 마커(끝이 완). 숫자 포함 + 끝 글자 완.
const isWan = (job) => { const s = String(job ?? "").trim(); return /\d/.test(s) && /완\s*$/.test(s); };
const toISO = (s) => { const m = String(s ?? "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : null; };
const kstISO = (offsetDays = 0) => { const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400000); return d.toISOString().slice(0, 10); };

// 완결일이 [오늘-catchUp, 오늘] 범위이고 아직 안 알린 작품 반환(+notified 마킹).
// 하루 1회만 시트 스캔(같은 날 재호출은 스킵). 봇이 꺼졌다 켜지면 lastScan이 옛날이라 그때 스캔→캐치업.
// catchUp=봇 꺼짐 보정(기본 7일). notified로 이미 알린 건 제외.
export async function dueCompletions(catchUpDays = 7) {
  const today = kstISO(0), from = kstISO(-Math.abs(catchUpDays));
  const state = load();
  if (state.lastScan === today) return [];          // 오늘 이미 스캔함 → 시트 재읽기 안 함(하루 1회)
  const found = [];
  for (const [lang, tab] of Object.entries(TABS)) {
    let rows;
    try { rows = (await readRange(DELIVERY_ID, `${tab}!A2:P3000`)) || []; }
    catch (e) { console.error(`[completion] ${tab} 읽기 실패:`, e?.message ?? e); continue; }
    for (const r of rows) {
      if (!isWan(r[C.job])) continue;
      const date = toISO(r[C.endDate]);
      if (!date || date < from || date > today) continue;
      const work = String(r[C.work] ?? "").trim();
      if (!work) continue;
      found.push({ lang, work, episode: String(r[C.job]).trim(), date, apm: String(r[C.apm] ?? "").trim(), pivo: String(r[C.pivo] ?? "").trim() });
    }
  }
  const notified = new Set(state.keys || []);
  const fresh = found.filter((c) => !notified.has(`${c.lang}|${c.work}|${c.date}`));
  fresh.forEach((c) => notified.add(`${c.lang}|${c.work}|${c.date}`));
  state.keys = [...notified];
  state.lastScan = today;                            // 오늘 스캔 완료 표시(하루 1회 게이트)
  save(state);
  fresh.sort((a, b) => a.date.localeCompare(b.date));
  return fresh;
}

// 알림 메시지 섹션(없으면 null)
export function fmtCompletions(rows) {
  if (!rows.length) return null;
  const lines = rows.map((c) => `• [${c.lang}] *${c.work}* ${c.episode} — 완결일 ${c.date}${c.apm ? ` · APM ${c.apm}` : ""}`);
  return `🏁 *완결 작품* (납품 시트 기준 ${rows.length}건)\n${lines.join("\n")}\n→ TOTUS 완결 처리(프로젝트명 (완)+상태 완료)도 필요하면 "○○ 완결 작품 처리해줘".`;
}
