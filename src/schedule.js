// 중일 고객사 스케줄 시트 파서 (read-only).
// 시트 12y4jtsP… 탭 "スケジュールシート" — 블록 구조:
//   col J(idx9)=행 라벨(リリース日/話数/配信数/原本共有日/納品予定日/納品話数/提案),
//   C(2)=日本語タイトル, I(8)=原本(수급 현황), H(7)=納品, K+(idx10~)=주차별 데이터(헤더는 1행).
// 한 작품 = 'リリース日' 행으로 시작하는 블록. 같은 블록의 話数/納品予定日/納品話数 행이 주차별로 정렬됨.
// 미수급 판정 로직은 n8n '[Toon Japan]중일 원본 미수급 리마인드' 워크플로우 포팅.
import { readRange } from "./sheets.js";

const SCHEDULE_ID = "12y4jtsPJbJg7HdO5AfzoJK85suLenmk_bpWw4mRH2RQ";
const TAB = "スケジュールシート";
const COL = { title: 2, deliv: 7, received: 8, label: 9 };   // C, H, I, J
const WEEK_START = 10;                                        // K열~ 주차별 데이터

// "5/4(月)" / "4/30(목)" / "2023/04/30" → {month, day}. 없으면 null
function parseMD(raw) {
  if (!raw) return null;
  const s = String(raw);
  let m = s.match(/(\d{1,2})\/(\d{1,2})(?!\d)/);          // M/D
  if (m) return { month: +m[1], day: +m[2] };
  m = s.match(/\d{4}\/(\d{1,2})\/(\d{1,2})/);             // YYYY/M/D
  if (m) return { month: +m[1], day: +m[2] };
  return null;
}
// "84"→[84], "288-290"→[288,289,290]
function parseEpisodes(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  const r = s.match(/^(\d+)\s*[-~]\s*(\d+)$/);
  if (r) { const a = +r[1], b = +r[2], out = []; for (let i = a; i <= b; i++) out.push(i); return out; }
  const one = s.match(/\d+/);
  return one ? [+one[0]] : [];
}
// 原本(I열) → 수급된 최대 회차. "83"→83, "388-489"→489
function receivedMax(raw) {
  const nums = String(raw || "").match(/\d+/g);
  return nums ? Math.max(...nums.map(Number)) : 0;
}

// 시트를 블록(작품) 배열로 파싱
async function getBlocks() {
  const rows = (await readRange(SCHEDULE_ID, `${TAB}!A1:BZ500`)) || [];
  const header = rows[0] || [];
  const weekCols = [];
  for (let k = WEEK_START; k < header.length; k++) weekCols.push({ idx: k, label: String(header[k] || "").trim() });

  const blocks = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i]?.[COL.label] || "").trim() !== "リリース日") continue;
    const rel = rows[i];
    const title = String(rel[COL.title] || "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    // 같은 블록의 라벨 행들 수집 (다음 'リリース日' 전까지)
    const labeled = {};
    for (let j = i + 1; j < rows.length; j++) {
      const lbl = String(rows[j]?.[COL.label] || "").trim();
      if (lbl === "リリース日") break;
      if (lbl && !labeled[lbl]) labeled[lbl] = rows[j];
    }
    // 완결작 제외용 텍스트
    const doneText = [rel[0], rel[COL.received], rel[COL.title]].map((x) => String(x || "")).join(" ");
    const epRowDone = labeled["話数"] ? Object.values(labeled["話数"]).some((v) => String(v || "").includes("完")) : false;
    const weeks = weekCols.map((w) => ({
      week: w.label,
      launch: String(rel[w.idx] || "").trim(),
      episodes: String(labeled["話数"]?.[w.idx] || "").trim(),
      deliveryDate: String(labeled["納品予定日"]?.[w.idx] || "").trim(),
      deliveryEps: String(labeled["納品話数"]?.[w.idx] || "").trim(),
    })).filter((w) => w.launch || w.episodes || w.deliveryDate || w.deliveryEps);
    blocks.push({
      title,
      received: String(rel[COL.received] || "").trim(),
      receivedMax: receivedMax(rel[COL.received]),
      delivery: String(rel[COL.deliv] || "").trim(),
      done: doneText.includes("完") || epRowDone,
      weeks,
    });
  }
  return blocks;
}

// 원본 미수급 (런칭 N개월 이내인데 原本 미수급) — n8n 포팅. 기준일 today(KST), threshold=+monthsAhead
export async function missingOriginals({ monthsAhead = 1 } = {}) {
  const blocks = await getBlocks();
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const tY = kst.getUTCFullYear(), tM = kst.getUTCMonth(), tD = kst.getUTCDate();
  const today = Date.UTC(tY, tM, tD);
  const threshold = Date.UTC(tY, tM + monthsAhead, tD);
  const toTs = (md) => { let y = tY; if (md.month < tM + 1) y += 1; return Date.UTC(y, md.month - 1, md.day); };

  const out = [];
  for (const b of blocks) {
    if (b.done) continue;
    if (!b.received) continue;                 // 原本 미기재 = 추적 안 함(오탐 방지)
    for (const w of b.weeks) {
      const md = parseMD(w.launch); if (!md) continue;
      const ts = toTs(md); if (ts > threshold) continue;   // 아직 멀었음
      const eps = parseEpisodes(w.episodes); if (!eps.length) continue;
      const maxEp = Math.max(...eps);
      if (maxEp <= b.receivedMax) continue;     // 이미 수급
      out.push({ title: b.title, episode: w.episodes, maxEp, launch: `${md.month}/${md.day}`, launchTs: ts });
    }
  }
  const seen = new Set();
  const uniq = out.filter((m) => { const k = m.title + "|" + m.episode; if (seen.has(k)) return false; seen.add(k); return true; });
  uniq.sort((a, b) => a.launchTs - b.launchTs || a.maxEp - b.maxEp);
  return uniq.map(({ launchTs, ...r }) => r);
}

// 특정 날짜(M/D)에 납품 예정인 회차 집계 (納品予定日 행 매칭 → 納品話数)
export async function deliveryOnDate(dateStr) {
  const want = parseMD(dateStr);
  if (!want) return { error: `날짜 형식 인식 불가: ${dateStr} (예: 6/19)` };
  const blocks = await getBlocks();
  const items = [];
  let totalEps = 0;
  for (const b of blocks) {
    for (const w of b.weeks) {
      const dd = parseMD(w.deliveryDate);
      if (!dd || dd.month !== want.month || dd.day !== want.day) continue;
      const eps = parseEpisodes(w.deliveryEps);
      items.push({ title: b.title, episodes: w.deliveryEps, count: eps.length });
      totalEps += eps.length;
    }
  }
  return { date: `${want.month}/${want.day}`, works: items.length, totalEpisodes: totalEps, items };
}

// 작품별 스케줄 (주차별 런칭/회차/납품)
export async function workSchedule(work) {
  const blocks = await getBlocks();
  const q = String(work || "").replace(/\s+/g, "");
  const hit = blocks.filter((b) => b.title.replace(/\s+/g, "").includes(q) || q.includes(b.title.replace(/\s+/g, "")));
  if (!hit.length) return { found: false, msg: `'${work}'를 스케줄 시트에서 못 찾음` };
  return { found: true, results: hit.map((b) => ({ title: b.title, received: b.received, delivery: b.delivery, done: b.done, weeks: b.weeks })) };
}
