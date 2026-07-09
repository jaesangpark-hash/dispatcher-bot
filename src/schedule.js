// 중일 고객사 스케줄 시트 파서 (read-only).
// 시트 12y4jtsP… 탭 "スケジュールシート" — 블록 구조:
//   col J(idx9)=행 라벨(リリース日/話数/配信数/原本共有日/納品予定日/納品話数/提案),
//   C(2)=日本語タイトル, I(8)=原本(수급 현황), H(7)=納品, K+(idx10~)=주차별 데이터(헤더는 1행).
// 한 작품 = 'リリース日' 행으로 시작하는 블록. 같은 블록의 話数/納品予定日/納品話数 행이 주차별로 정렬됨.
// 미수급 판정 로직은 n8n '[Toon Japan]중일 원본 미수급 리마인드' 워크플로우 포팅.
import { readRange } from "./sheets.js";
import { resolveTitleAliases } from "./works.js";

const SCHEDULE_ID = "12y4jtsPJbJg7HdO5AfzoJK85suLenmk_bpWw4mRH2RQ";
const TAB = "スケジュールシート";
const TITLE_TAB = "タイトルリスト";   // PIVO 인덱스: B作品ID(PIVO) E初回リリース日 F正式 G仮 H原題
const COL = { title: 2, deliv: 7, received: 8, label: 9 };   // C, H, I, J
const WEEK_START = 10;                                        // K열~ 주차별 데이터

// 제목 매칭용 강한 정규화(괄호·물결·구두점 제거). 타이틀리스트↔스케줄 블록 다리에 사용(매칭률 49/49 검증).
const normT = (s) => String(s || "").replace(/[\s~～〜〰（）()【】「」『』、,。.・\-—–:：!！?？]/g, "").toLowerCase();

// 통짜 읽기·파싱이 무거워 짧은 TTL 캐시(런칭일은 자주 안 바뀜). 반복 조회를 즉답으로.
const TTL_MS = 3 * 60 * 1000;
const _cache = { blocks: { at: 0, v: null }, titles: { at: 0, v: null } };
const fresh = (e) => e.v && Date.now() - e.at < TTL_MS;

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

// 시트를 블록(작품) 배열로 파싱 (TTL 캐시)
async function getBlocks() {
  if (fresh(_cache.blocks)) return _cache.blocks.v;
  const rows = (await readRange(SCHEDULE_ID, `${TAB}!A1:BZ`)) || [];   // ★범위 열어둠 — 500행 고정 시 아래 블록(전체의 다수) 누락됐었음
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
  _cache.blocks = { at: Date.now(), v: blocks };
  return blocks;
}

// 타이틀리스트(PIVO 인덱스) 로드 (TTL 캐시). pivo → {pivo, launch(初回), seika(F正式), ka(G仮), wonje(H原題), titles[]}
async function titleListIndex() {
  if (fresh(_cache.titles)) return _cache.titles.v;
  const rows = (await readRange(SCHEDULE_ID, `${TITLE_TAB}!A2:H400`)) || [];
  const byPivo = new Map();
  const list = [];
  for (const r of rows) {
    const pivo = String(r[1] ?? "").trim();
    if (!pivo) continue;
    const e = { pivo, launch: String(r[4] ?? "").trim(), seika: String(r[5] ?? "").trim(), ka: String(r[6] ?? "").trim(), wonje: String(r[7] ?? "").trim() };
    e.titles = [e.seika, e.ka, e.wonje].filter(Boolean);
    byPivo.set(pivo, e);
    list.push(e);
  }
  const v = { byPivo, list };
  _cache.titles = { at: Date.now(), v };
  return v;
}

// 입력(PIVO ID 또는 한/일/중 제목) → PIVO ID. 1)숫자=PIVO 2)출판사 마스터 별칭→pivoId 3)타이틀리스트 F/G/H 직접매칭
async function resolvePivo(workOrPivo) {
  const q = String(workOrPivo ?? "").trim();
  if (!q) return null;
  if (/^\d+$/.test(q)) return q;
  const al = await resolveTitleAliases(q).catch(() => null);
  if (al?.pivoId) return String(al.pivoId).trim();
  const { list } = await titleListIndex();
  const nq = normT(q);
  const hit = list.find((e) => e.titles.some((t) => { const nt = normT(t); return nt && (nt.includes(nq) || nq.includes(nt)); }));
  return hit?.pivo || null;
}

// PIVO의 정식/가/원제 제목으로 스케줄 블록을 정확매칭
function matchBlockByTitles(blocks, titles) {
  const nts = titles.map(normT).filter(Boolean);
  if (!nts.length) return null;
  return blocks.find((b) => { const nb = normT(b.title); return nb && nts.some((t) => nb.includes(t) || t.includes(nb)); }) || null;
}

// 블록 해석 — ①블록 제목 직접 매칭(블록 제목엔 正式+仮이 다 들어 있어 가장 강함, PIVO 실패해도 잡힘)
//            → ②PIVO 경로(타이틀리스트) 폴백. 둘 다 실패면 block:null.
async function resolveBlock({ work, pivo } = {}) {
  const blocks = await getBlocks();
  const q = String((pivo != null && String(pivo).trim() ? pivo : work) ?? "").trim();
  if (q && !/^\d+$/.test(q)) {                       // ① 제목 직접 매칭(숫자 PIVO 아닐 때)
    const nq = normT(q);
    if (nq) {
      const direct = blocks.find((b) => { const nb = normT(b.title); return nb && (nb.includes(nq) || nq.includes(nb)); });
      if (direct) return { block: direct, blocks, pivo: null, tl: null, via: "title" };
    }
  }
  const resolvedPivo = await resolvePivo(q);           // ② PIVO 경로
  if (resolvedPivo) {
    const { byPivo } = await titleListIndex();
    const tl = byPivo.get(resolvedPivo);
    if (tl) { const b = matchBlockByTitles(blocks, tl.titles); if (b) return { block: b, blocks, pivo: resolvedPivo, tl, via: "pivo" }; }
    return { block: null, blocks, pivo: resolvedPivo, tl: tl || null, via: "pivo" };
  }
  return { block: null, blocks, pivo: null, tl: null, via: null };
}

// ★특정 회차의 런칭일(주차별 リリース日) 조회. 회차 매칭 기준 = 話数(런칭 회차).
// 반환: 그 회차의 launch(주차 リリース日) + deliveryDate(그 주차 納品予定日) + 주차정보. episode 미지정이면 블록 주차 전체.
export async function episodeLaunch({ work, pivo, episode } = {}) {
  const { block: b, pivo: rp, tl } = await resolveBlock({ work, pivo });
  if (!b) { const key = pivo != null && String(pivo).trim() ? pivo : work; return { found: false, pivo: rp || null, msg: `'${key}'를 스케줄 시트 블록에서 못 찾음(제목 표기나 PIVO ID 확인 필요).` }; }
  const base = { found: true, pivo: rp || null, title: b.title, seika: tl?.seika, ka: tl?.ka, initialLaunch: tl?.launch };
  const ep = episode != null && String(episode).trim() !== "" ? parseInt(episode, 10) : null;
  if (ep == null || isNaN(ep)) {
    return { ...base, weeks: b.weeks.map((w) => ({ week: w.week, launch: w.launch, episodes: w.episodes, deliveryDate: w.deliveryDate, deliveryEps: w.deliveryEps })) };
  }
  const wk = b.weeks.find((w) => parseEpisodes(w.episodes).includes(ep));
  if (!wk) {
    return { ...base, episode: ep, foundEpisode: false, msg: `${ep}화가 어느 주차 話数(런칭 회차)에도 없음. 주차별 회차: ` + b.weeks.filter((w) => w.episodes).map((w) => `${w.episodes}(런칭 ${w.launch})`).join(", "), weeks: b.weeks.map((w) => ({ week: w.week, launch: w.launch, episodes: w.episodes, deliveryDate: w.deliveryDate })) };
  }
  return { ...base, episode: ep, foundEpisode: true, launch: wk.launch, deliveryDate: wk.deliveryDate, week: wk.week, episodesInWeek: wk.episodes, deliveryEpsInWeek: wk.deliveryEps };
}

// ★특정 회차의 '납품 기재 여부' 확인 — 기준 = 納品話数(납품 회차) + 納品予定日.
// 납품 리스트가 고객사 스케줄 시트에 반영됐는지 검증할 때 쓴다(런칭 회차 話数가 아니라 납품 회차 기준).
export async function episodeDelivery({ work, pivo, episode } = {}) {
  const { block: b, pivo: rp } = await resolveBlock({ work, pivo });
  if (!b) { const key = pivo != null && String(pivo).trim() ? pivo : work; return { found: false, pivo: rp || null, msg: `'${key}'를 스케줄 시트 블록에서 못 찾음(제목 표기나 PIVO ID 확인 필요).` }; }
  const allDeliv = b.weeks.flatMap((w) => parseEpisodes(w.deliveryEps));
  const maxDeliv = allDeliv.length ? Math.max(...allDeliv) : null;
  const ep = episode != null && String(episode).trim() !== "" ? parseInt(episode, 10) : null;
  if (ep == null || isNaN(ep)) {
    return { found: true, pivo: rp || null, title: b.title, maxDeliveryEp: maxDeliv, weeks: b.weeks.filter((w) => w.deliveryEps).map((w) => ({ week: w.week, deliveryEps: w.deliveryEps, deliveryDate: w.deliveryDate })) };
  }
  const dw = b.weeks.find((w) => parseEpisodes(w.deliveryEps).includes(ep));
  if (dw) return { found: true, pivo: rp || null, title: b.title, episode: ep, listedForDelivery: true, deliveryDate: dw.deliveryDate, deliveryEps: dw.deliveryEps, week: dw.week };
  const lw = b.weeks.find((w) => parseEpisodes(w.episodes).includes(ep));
  return { found: true, pivo: rp || null, title: b.title, episode: ep, listedForDelivery: false, maxDeliveryEp: maxDeliv, inLaunchOnly: !!lw, msg: `${ep}화가 納品話数(납품 회차)에 미기재 — 현재 납품 회차 최대 ${maxDeliv ?? "없음"}${lw ? " (話数(런칭)엔 있음)" : ""}.` };
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
