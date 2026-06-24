// 번역 검수 피드백 공유 — 퀄리티(KP평가) 시트 작업기록을 조회해 고객 공유용 메시지 작성(read-only).
// 실제 발송/시트표시는 app.js 게이트(확인 버튼) 핸들러에서만.
// 작업기록 작업구분별로: 翻訳ck(総評)=총평, 翻訳ck(翻訳者)=번역가(J=이름), 翻訳ck(チェッカー)=LG(K=이름).
import { readRange } from "./sheets.js";
import { lookupWork } from "./works.js";

const KP_SHEET = "1jd9lOvHwCXqsSYE9vQbSqcbxO9B9sryD5_dWHJhlm4U";
const WORK_LOG = "作業記録(中日)_2026";
const HEADER_ROW = 4;                       // 데이터는 A5부터. readRange("A4:N")의 [0]=헤더(row4), [i]=row(4+i)
const C = { date: 0, workId: 1, workName: 2, division: 4, epNote: 5, grade: 6, memo: 7, translator: 9, lg: 10, qaName: 11, shared: 13, workerId: 14 };
const DIV = { sochong: "翻訳ck(総評)", trans: "翻訳ck(翻訳者)", checker: "翻訳ck(チェッカー)" };

// APM 이름 → Slack ID. 새 APM은 여기 추가.
const APM_SLACK = { "서주원": "U07E0QPL8MV", "정태영": "U05CE8HFA6B" };
const OWNER_ID = "U04463JR4HH";             // 박재상 (CC 고정)
// 정성품질검수자(=배치의 2번째 翻訳ck(チェッカー)) 作業者ID(O열) → 한글 이름. 새 검수자는 여기 추가.
// 시트 L열은 로마자라, 발송 메시지에서만 이 한글 표기를 쓴다(매핑 없으면 L열 값으로 폴백).
const QA_KO = { "215635": "바바 아야코", "26223": "우메자키 에이코", "9322": "가츠라 이치로", "38203": "와타나베", "22716": "덴 유카", "20536": "모리시타 토모미", "31680": "타무라 에미" };

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

  const raw = await readRange(KP_SHEET, `${WORK_LOG}!A${HEADER_ROW}:O2000`);
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
  // 4) 정성품질검수자 = 배치의 2번째 翻訳ck(チェッカー)(시트 순서). 이름은 한글(QA_KO)>L열 순.
  const checkersBatch = sameBatch(byDiv(DIV.checker));
  const qaRow = checkersBatch[1] || null;
  const qaId = qaRow ? trim(qaRow.r[C.workerId]) : "";
  const qaName = qaRow ? (QA_KO[qaId] || trim(qaRow.r[C.qaName]) || (qaId ? `ID:${qaId}` : "")) : "";

  // ── 메시지 조립: 섹션별 [헤더] + 코드블록(코멘트 + 빈줄 + 등급) ──
  // 회색 박스 = 코드블록(```). 헤더는 박스 밖 일반 텍스트. 멘션·제목은 박스 밖(렌더링).
  const rowsToMark = [sochong.sheetRow];
  const blk = (header, comment, grade) => `${header}\n\`\`\`\n${trim(comment)}\n\n${trim(grade)}\n\`\`\``;
  const sections = [blk("[총평]", sochong.r[C.memo], sochong.r[C.grade])];
  if (transRow) { sections.push(blk(`[번역가] ${trim(transRow.r[C.translator])}`, transRow.r[C.memo], transRow.r[C.grade])); rowsToMark.push(transRow.sheetRow); }
  if (lgRow) { sections.push(blk(`[LG] ${trim(lgRow.r[C.lg])}`, lgRow.r[C.memo], lgRow.r[C.grade])); rowsToMark.push(lgRow.sheetRow); }
  if (qaRow && qaName && qaRow !== lgRow) { sections.push(blk(`[${qaName}님]`, qaRow.r[C.memo], qaRow.r[C.grade])); rowsToMark.push(qaRow.sheetRow); }
  // 제목의 <작품>은 &lt;&gt;로 이스케이프(슬랙이 <...>를 링크로 오해하지 않게)
  const titleBlock = [
    `&lt;${w.koTitle}&gt; ${epStr || batchNote || ""}화 고객 번역 검수 완료되었습니다.`,
    "추가 제출은 불필요합니다.",
    "",
    sections.join("\n"),
  ].join("\n");
  const text = `${apmId ? `<@${apmId}>` : `@${w.apm || "?"}`} CC <@${OWNER_ID}>\n${titleBlock}`;          // 실제 발송용(멘션)
  const previewText = `@${w.apm || "?"} CC @박재상\n${titleBlock}`;                                         // 미리보기용(멘션 핑 방지)

  return {
    found: true,
    text, previewText,
    apmId, apmName: w.apm, koTitle: w.koTitle, pivoId: pivo,
    episode: epStr, batchNote, batchDate: trim(sochong.r[C.date]),
    rowsToMark,                                  // N열(피드백 공유) TRUE 표시 대상 시트 행
    markRange: (row) => `${WORK_LOG}!N${row}`,
    qaName, qaId,
    missing: { translator: !transRow, lg: !lgRow, qa: !(qaRow && qaName), apm: !apmId },
  };
}

export const FEEDBACK_SHARE_RANGE = (row) => `${WORK_LOG}!N${row}`;
export { KP_SHEET as FEEDBACK_SHEET_ID };
