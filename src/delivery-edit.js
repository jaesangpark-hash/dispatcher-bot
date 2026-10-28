// 납품 시트 수정 대상 셀 해석 (read-only). 실제 쓰기는 sheets-write.setCell.
// 컬럼: B=작품명 C=PM D=APM E=회차 G=납품일(jp_end_date)
//
// ★H열은 헤더가 「납품예정일」이지만 값은 전부 TRUE/FALSE 체크박스다(실측: 날짜 0건,
//   중일 11,147행·한일 17,901행 전부 불리언). 날짜 칸은 G열 하나뿐이고, 진짜
//   납품예정일은 TOTUS(job-processes)에 있다 — 그쪽은 propose_totus_delivery_edit.
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

// 여러 회차를 한 번의 시트 읽기로 일괄 해석(일괄 변경용). episodes=정수배열.
// 수정 가능한 열. 새 열을 열 땐 여기 한 줄 추가한다.
const COLUMNS = Object.freeze({
  G: { letter: "G", index: 6, label: "납품일" },
  D: { letter: "D", index: 3, label: "담당 APM" },
});

// 여러 회차를 한 번의 시트 읽기로 일괄 해석(일괄 변경용). episodes=정수배열.
// column 으로 어느 열을 고칠지 고른다(기본 G=납품일).
export async function resolveDeliveryCells({ work, episodes, lang = "zh-ja", column = "G" }) {
  const col = COLUMNS[column] || COLUMNS.G;
  const tab = TABS[lang] || TABS["zh-ja"];
  const rows = await readRange(SHEET_ID, `${tab}!A:G`);
  let needles = [work], via = null;
  const al = await resolveTitleAliases(work).catch(() => null);
  if (al && al.aliases.length) { needles = [work, ...al.aliases]; via = al.koTitle || al.aliases[0]; }
  const found = [], missing = [];
  for (const ep of episodes) {
    const row = findRow(rows, needles, ep);
    if (!row) { missing.push(ep); continue; }
    const rowNum = row.idx + 1;
    found.push({
      cellA1: `${tab}!${col.letter}${rowNum}`,
      current: row.r[col.index] ?? "",
      currentDate: row.r[6] ?? "",          // 기존 호출부 호환(납품일 보고용)
      apm: row.r[3] ?? "",
      episode: parseInt(row.r[4]), workName: row.r[1],
    });
  }
  return { sheetId: SHEET_ID, tab, lang, column: col, found, missing, resolvedVia: found.length ? via : null, workName: found[0]?.workName };
}

// 한 작품의 **모든 회차** 행을 돌려준다. APM 교체는 보통 작품 단위라 회차를 일일이 못 적는다.
export async function listWorkRows({ work, lang = "zh-ja", column = "D" }) {
  const col = COLUMNS[column] || COLUMNS.D;
  const tab = TABS[lang] || TABS["zh-ja"];
  const rows = await readRange(SHEET_ID, `${tab}!A:G`);
  let needles = [work];
  const al = await resolveTitleAliases(work).catch(() => null);
  if (al && al.aliases.length) needles = [work, ...al.aliases];
  const ns = needles.map(norm).filter(Boolean);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const b = norm(rows[i][1]);
    if (!b || !ns.some((n) => b.includes(n) || n.includes(b))) continue;
    const ep = parseInt(rows[i][4]);
    if (isNaN(ep)) continue;
    out.push({
      cellA1: `${tab}!${col.letter}${i + 1}`,
      current: rows[i][col.index] ?? "",
      episode: ep, workName: rows[i][1],
    });
  }
  return { sheetId: SHEET_ID, tab, lang, column: col, rows: out, workName: out[0]?.workName };
}

// 그 탭에 실제로 쓰이는 APM 이름들 — 오타로 없는 사람을 적어 넣는 걸 막는다.
export async function listApmNames({ lang = "zh-ja" }) {
  const tab = TABS[lang] || TABS["zh-ja"];
  const rows = await readRange(SHEET_ID, `${tab}!A:G`);
  const seen = new Map();
  for (let i = 1; i < rows.length; i++) {
    const v = String(rows[i][3] ?? "").trim();
    if (v) seen.set(v, (seen.get(v) || 0) + 1);
  }
  return [...seen].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}
