// 번역 검수 피드백 공유 — 퀄리티(KP평가) 시트 작업기록을 조회해 고객 공유용 메시지 작성(read-only).
// 실제 발송/시트표시는 app.js 게이트(확인 버튼) 핸들러에서만.
// 작업기록 작업구분별로: 翻訳ck(総評)=총평, 翻訳ck(翻訳者)=번역가(J=이름), 翻訳ck(チェッカー)=LG(K=이름).
import { readRange } from "./sheets.js";
import { lookupWork } from "./works.js";

const KP_SHEET = "1jd9lOvHwCXqsSYE9vQbSqcbxO9B9sryD5_dWHJhlm4U";
const WORK_LOG = "作業記録(中日)_2026";
const HEADER_ROW = 4;                       // 데이터는 A5부터. readRange("A4:N")의 [0]=헤더(row4), [i]=row(4+i)
const C = { date: 0, workId: 1, workName: 2, division: 4, epNote: 5, grade: 6, memo: 7, translator: 9, lg: 10, shared: 13 };
const DIV = { sochong: "翻訳ck(総評)", trans: "翻訳ck(翻訳者)", checker: "翻訳ck(チェッカー)" };

// APM 이름 → Slack ID. 새 APM은 여기 추가.
const APM_SLACK = { "서주원": "U07E0QPL8MV", "정태영": "U05CE8HFA6B" };
const OWNER_ID = "U04463JR4HH";             // 박재상 (CC 고정)

const trim = (s) => String(s ?? "").trim();
// "2026/6/22" / "2026-06-22" → 비교 가능한 정수(yyyymmdd). 못 읽으면 0.
function dateNum(s) {
  const m = trim(s).match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  return m ? +`${m[1]}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` : 0;
}

// 작품·회차로 최신 검수 배치의 총평/번역가/LG를 모아 공유 메시지 작성
export async function buildFeedback({ work, episode }) {
  const w = await lookupWork(work);
  if (!w.found) return w.ambiguous ? { found: false, ambiguous: true, candidates: w.candidates } : { found: false, query: work };
  const apmId = w.apm ? APM_SLACK[trim(w.apm)] : null;

  const raw = await readRange(KP_SHEET, `${WORK_LOG}!A${HEADER_ROW}:N2000`);
  const rows = raw.slice(1).map((r, i) => ({ r, sheetRow: HEADER_ROW + 1 + i }));   // sheetRow = 5,6,7...
  const pivo = trim(w.pivoId);
  let mine = rows.filter((x) => trim(x.r[C.workId]) === pivo && pivo);
  // PIVO ID로 못 잡으면 작품명(일/한)으로 폴백
  if (!mine.length) {
    const names = [w.jaTitle, w.koTitle, w.fixTitle].filter(Boolean).map((s) => s.replace(/\s+/g, ""));
    mine = rows.filter((x) => { const n = trim(x.r[C.workName]).replace(/\s+/g, ""); return n && names.some((t) => n.includes(t) || t.includes(n)); });
  }
  if (!mine.length) return { found: false, query: work, msg: `'${w.koTitle || work}'(PIVO ${pivo})를 작업기록(${WORK_LOG})에서 못 찾음.` };

  const byDiv = (d) => mine.filter((x) => trim(x.r[C.division]) === d);
  const latest = (arr) => arr.slice().sort((a, b) => dateNum(b.r[C.date]) - dateNum(a.r[C.date]))[0] || null;

  // 1) 총평 = 가장 최근 翻訳ck(総評). episode가 epNote에 들어가면 그 배치 우선.
  const sochongAll = byDiv(DIV.sochong);
  if (!sochongAll.length) return { found: false, query: work, msg: `'${w.koTitle}'에 翻訳ck(総評) 기록이 없음(아직 총평 미작성).` };
  const epStr = trim(episode);
  let sochong = epStr ? sochongAll.find((x) => trim(x.r[C.epNote]) && trim(x.r[C.epNote]).includes(epStr)) : null;
  sochong = sochong || latest(sochongAll);
  const batchNote = trim(sochong.r[C.epNote]);

  // 같은 배치(epNote)로 번역가/LG. epNote 없으면 같은 날짜로.
  const sameBatch = (arr) => {
    const byNote = batchNote ? arr.filter((x) => trim(x.r[C.epNote]) === batchNote) : arr.filter((x) => dateNum(x.r[C.date]) === dateNum(sochong.r[C.date]));
    return byNote.length ? byNote : arr;
  };
  // 2) 번역가 = 翻訳ck(翻訳者) 중 이름(J) 있는 행
  const transRow = latest(sameBatch(byDiv(DIV.trans)).filter((x) => trim(x.r[C.translator])));
  // 3) LG = 翻訳ck(チェッカー) 중 이름(K) 있는 행
  const lgRow = latest(sameBatch(byDiv(DIV.checker)).filter((x) => trim(x.r[C.lg])));

  // ── 메시지 조립 (인용기호 없이 작성 그대로) ──
  const apmMention = apmId ? `<@${apmId}>` : `@${w.apm || "?"}`;
  const lines = [];
  lines.push(`${apmMention} CC <@${OWNER_ID}>`);
  lines.push(`<${w.koTitle}> ${epStr || batchNote || ""}화 고객 번역 검수 완료되었습니다.`);
  lines.push("추가 제출은 불필요합니다.");
  lines.push("");
  lines.push(`[총평]${trim(sochong.r[C.memo])}`);
  const rowsToMark = [sochong.sheetRow];
  if (transRow) {
    lines.push("");
    lines.push(`${trim(transRow.r[C.grade])}[번역가] ${trim(transRow.r[C.translator])} ${trim(transRow.r[C.memo])}`);
    rowsToMark.push(transRow.sheetRow);
  }
  if (lgRow) {
    lines.push("");
    lines.push(`${trim(lgRow.r[C.grade])}[LG] ${trim(lgRow.r[C.lg])} ${trim(lgRow.r[C.memo])}`);
    rowsToMark.push(lgRow.sheetRow);
  }
  lines.push("");
  lines.push(trim(sochong.r[C.grade]));         // 맨 끝 = 총평 등급

  return {
    found: true,
    text: lines.join("\n"),
    apmId, apmName: w.apm, koTitle: w.koTitle, pivoId: pivo,
    episode: epStr, batchNote, batchDate: trim(sochong.r[C.date]),
    rowsToMark,                                  // N열(피드백 공유) TRUE 표시 대상 시트 행
    markRange: (row) => `${WORK_LOG}!N${row}`,
    missing: { translator: !transRow, lg: !lgRow, apm: !apmId },
  };
}

export const FEEDBACK_SHARE_RANGE = (row) => `${WORK_LOG}!N${row}`;
export { KP_SHEET as FEEDBACK_SHEET_ID };
