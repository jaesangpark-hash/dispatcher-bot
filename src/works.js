// 작품 기본정보 + 제목 정규화/매칭 — 운영 통합 '출판사 드라이브 링크' A:I
// 컬럼: A=APM B=중국어 C=한국어 D=일본어가제 E=FIX일본어 G=출판사 H=드라이브 I=PIVO ID
// 한 작품이 C/D/E 세 갈래라, 입력이 셋 중 무엇이든 찾는다. 매칭: PIVO/정확 → 토큰(단어 다 포함) → 부분(연속).
import { readRange, norm } from "./sheets.js";
import { setCell } from "./sheets-write.js";

const MASTER = "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";
const RANGE = "출판사 드라이브 링크!A:I";
const TITLE_COLS = [2, 3, 4]; // C 한국어, D 일본어가제, E FIX일본어

const mapRow = (r) => ({
  apm: r[0] || null, zhTitle: r[1] || null, koTitle: r[2] || null, jaTitle: r[3] || null,
  fixTitle: r[4] || null, publisher: r[6] || null, driveLink: r[7] || null, pivoId: r[8] || null,
});

// 매칭 행 후보 전부 반환 (우선순위 단계별, 첫 단계에서 잡히면 그 단계 결과만)
function matchRows(rows, queryRaw) {
  const q = norm(queryRaw);
  if (!q) return [];
  // 0) PIVO ID 정확
  if (/^\d+$/.test(q)) { const h = rows.filter((r) => String(r[8] || "").trim() === q); if (h.length) return h; }
  // 1) 제목 정확 일치
  let h = rows.filter((r) => TITLE_COLS.some((c) => norm(r[c]) === q));
  if (h.length) return h;
  // 2) 토큰 매칭 — 공백 분리 토큰(2자+)이 한 컬럼에 모두 포함 (순서 무관, "기묘 서점" OK)
  const tokens = String(queryRaw).split(/\s+/).map(norm).filter((t) => t.length >= 2);
  if (tokens.length) {
    h = rows.filter((r) => TITLE_COLS.some((c) => { const n = norm(r[c]); return n && tokens.every((t) => n.includes(t)); }));
    if (h.length) return h;
  }
  // 3) 부분문자열 — 제목이 쿼리를 포함(부분입력 OK). 쿼리가 제목을 포함하는 경우는 '나머지'에 2자+ 변별어가
  //    없을 때만(노이즈만 남을 때) 허용 — '아비스 인 케이지'가 짧은 '아비스'로 붕괴하는 오매칭 방지.
  h = rows.filter((r) => TITLE_COLS.some((c) => {
    const n = norm(r[c]); if (!n) return false;
    if (n.includes(q)) return true;
    if (q.includes(n)) return !/[가-힣]{2,}|[぀-ヿ㐀-鿿]{2,}/.test(q.split(n).join(""));
    return false;
  }));
  return h;
}

// 느슨한 후보(제안용 — 확정 매칭 아님): 부분문자열 양방향 + 토큰 일부 포함. '못 찾음'일 때 '혹시 이거?'로.
function looseMatch(rows, queryRaw) {
  const q = norm(queryRaw); if (!q) return [];
  const toks = String(queryRaw).split(/\s+/).map(norm).filter((t) => t.length >= 2);
  return rows.filter((r) => TITLE_COLS.some((c) => {
    const n = norm(r[c]); if (!n) return false;
    return n.includes(q) || q.includes(n) || toks.some((t) => n.includes(t));
  }));
}

// 단일 최선(첫 매칭) — 내부 정규화용(delivery 등)
export async function resolveWorkRow(queryRaw) {
  const rows = (await readRange(MASTER, RANGE)).slice(1);
  return matchRows(rows, queryRaw)[0] || null;
}

// 작품 기본정보 — 모호하면(2+) 후보 반환해 LLM이 되묻게
export async function lookupWork(queryRaw) {
  const rows = (await readRange(MASTER, RANGE)).slice(1);
  const hits = matchRows(rows, queryRaw);
  if (hits.length === 1) return { found: true, ...mapRow(hits[0]) };
  const cand = (arr) => arr.slice(0, 6).map((r) => ({ koTitle: r[2], jaTitle: r[3], fixTitle: r[4], pivoId: r[8], apm: r[0] }));
  if (hits.length > 1) return { found: false, ambiguous: true, query: queryRaw, count: hits.length, candidates: cand(hits) };
  // 정확히 못 찾음 → 느슨한 후보를 제안(있으면). 변별어 있는 쿼리가 짧은 제목으로 잘못 붙는 대신 '혹시 이거?'.
  const near = looseMatch(rows, queryRaw);
  return { found: false, query: queryRaw, ...(near.length ? { candidates: cand(near) } : {}) };
}

// 한국어 타이틀 인덱스(재수급 감지용) — koTitle 정확일치 스캔. 10분 캐시.
let _koIdx = null, _koIdxAt = 0;
export async function koTitleIndex() {
  if (_koIdx && Date.now() - _koIdxAt < 600000) return _koIdx;
  const rows = (await readRange(MASTER, RANGE)).slice(1);
  const idx = [];
  for (const r of rows) {
    const ko = String(r[2] || "").trim();
    if (!ko) continue;
    idx.push({ koTitle: ko, koNorm: norm(ko), pivoId: r[8] || null, driveLink: r[7] || null, publisher: r[6] || null, zhTitle: r[1] || null });
  }
  _koIdx = idx; _koIdxAt = Date.now();
  return idx;
}

// F열(비고) — 작품별 특이사항(작업 시·납품 시 매번 챙겨야 하는 내용). 채워진 행만 반환.
export async function listWorkNotes() {
  const rows = (await readRange(MASTER, RANGE)).slice(1);
  return rows.filter((r) => String(r[5] ?? "").trim()).map((r) => ({
    apm: r[0] || null, zhTitle: r[1] || null, koTitle: r[2] || null, jaTitle: r[3] || null, fixTitle: r[4] || null,
    note: String(r[5]).trim(), pivoId: r[8] || null,
  }));
}

// 작품 F열(비고)에 특이사항을 기록. 후보 1건일 때만 즉시 반영, 여러 건이면 ambiguous 반환(재상 님에게 되묻기).
export async function setWorkNote(queryRaw, note) {
  const rows = (await readRange(MASTER, RANGE)).slice(1);
  const hits = matchRows(rows, queryRaw);
  if (!hits.length) return { ok: false, msg: `'${queryRaw}' 작품을 출판사 드라이브 링크 시트에서 못 찾음.` };
  if (hits.length > 1) return { ok: false, ambiguous: true, msg: `작품 후보가 여러 개(${hits.length}건).`, candidates: hits.slice(0, 6).map((r) => ({ koTitle: r[2], jaTitle: r[3], pivoId: r[8] })) };
  const rowNum = rows.indexOf(hits[0]) + 2;   // header(1행) 제외하고 슬라이스했으니 +2
  await setCell(MASTER, `${RANGE.split("!")[0]}!F${rowNum}`, note);
  return { ok: true, workName: hits[0][2] || hits[0][3] || String(queryRaw) };
}

// 다른 시트 검색용: 입력 → 작품의 모든 제목 후보 [한국어, 가제, FIX]
export async function resolveTitleAliases(queryRaw) {
  const hit = await resolveWorkRow(queryRaw);
  if (!hit) return null;
  return {
    koTitle: hit[2] || null, jaTitle: hit[3] || null, fixTitle: hit[4] || null,
    pivoId: hit[8] || null, apm: hit[0] || null,
    aliases: [hit[2], hit[3], hit[4]].filter(Boolean),
  };
}
