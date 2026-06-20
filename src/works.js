// 작품 기본정보 + 제목 정규화/매칭 — 운영 통합 '출판사 드라이브 링크' A:I
// 컬럼: A=APM B=중국어 C=한국어 D=일본어가제 E=FIX일본어 G=출판사 H=드라이브 I=PIVO ID
// 한 작품이 C/D/E 세 갈래라, 입력이 셋 중 무엇이든 찾는다. 매칭: PIVO/정확 → 토큰(단어 다 포함) → 부분(연속).
import { readRange, norm } from "./sheets.js";

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
  // 3) 연속 부분문자열(양방향)
  h = rows.filter((r) => TITLE_COLS.some((c) => { const n = norm(r[c]); return n && (n.includes(q) || q.includes(n)); }));
  return h;
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
  if (!hits.length) return { found: false, query: queryRaw };
  if (hits.length === 1) return { found: true, ...mapRow(hits[0]) };
  return {
    found: false, ambiguous: true, query: queryRaw, count: hits.length,
    candidates: hits.slice(0, 6).map((r) => ({ koTitle: r[2], jaTitle: r[3], fixTitle: r[4], pivoId: r[8], apm: r[0] })),
  };
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
