// 납품 시트 G열(납품일) 수정 대상 셀 해석 (read-only). 실제 쓰기는 sheets-write.setCell.
// 컬럼: B=작품명 C=PM D=APM E=회차 G=납품일
import { readRange, norm } from "./sheets.js";
import { resolveTitleAliases } from "./works.js";

const SHEET_ID = "1QWCtU1GnCT2BQZvuF_N-8MnpgiyqIDTcM0x6hdCi8mQ";
const TABS = { "zh-ja": "납품관리시트_Japan(중일 V5)", "ko-ja": "납품관리시트_Japan(한일 V5)" };

function findRow(rows, needles, episode) {
  const ns = needles.map(norm).filter(Boolean);
  const ep = parseInt(episode);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const b = norm(r[1]);
    if (b && parseInt(r[4]) === ep && ns.some((n) => b.includes(n) || n.includes(b))) return { idx: i, r };
  }
  return null;
}

// 입력(작품·회차·lang)으로 G열 셀을 찾아 현재값과 A1 반환. (일/한/중 제목 혼재는 마스터 정규화로 보강)
export async function resolveDeliveryCell({ work, episode, lang = "zh-ja" }) {
  const tab = TABS[lang] || TABS["zh-ja"];
  const rows = await readRange(SHEET_ID, `${tab}!A:G`);
  let row = findRow(rows, [work], episode);
  let via = null;
  if (!row) {
    const al = await resolveTitleAliases(work).catch(() => null);
    if (al && al.aliases.length) { row = findRow(rows, al.aliases, episode); if (row) via = al.koTitle || al.aliases[0]; }
  }
  if (!row) return { found: false, work, episode, lang };
  const rowNum = row.idx + 1; // A1은 1-based, rows[0]=헤더이므로 idx그대로+1
  return {
    found: true, sheetId: SHEET_ID, tab, lang,
    rowNum, cellA1: `${tab}!G${rowNum}`,
    workName: row.r[1], pm: row.r[2], apm: row.r[3], episode: parseInt(row.r[4]),
    currentDate: row.r[6] ?? "", resolvedVia: via,
  };
}
