// 문의봇 기록 시트(재수급봇·문의봇 탭)에서 "인입일 + N일 경과 & 완료 미체크"인 미해결 건을 스캔.
// 시트는 봇 SA 권한으로 읽기 전용 조회(무손상). 완료 체크박스가 채워지면 자동으로 목록에서 빠짐(별도 "그만" 불필요).
import { readRange, norm } from "./sheets.js";

const OPS_ID = process.env.INQUIRY_SHEET_ID || "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";

// 체크박스 완료 판정: TRUE/완료/✓ 류만 완료. FALSE·빈칸은 미완료.
const isDone = (v) => /^(true|1|완료|y|yes|✓|checked|done)$/i.test(String(v ?? "").trim());

// 인입일(셀 값) → KST 자정 기준 오늘과의 경과 일수. 해석 불가면 null.
function daysSince(s) {
  const str = String(s ?? "").trim();
  if (!str) return null;
  let d;
  const m = str.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) d = new Date(`${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}T00:00:00+09:00`);
  else d = new Date(str);
  if (isNaN(d)) return null;
  const kday = (t) => Math.floor((t.getTime() + 9 * 3600 * 1000) / 86400000);   // KST 달력일
  return kday(new Date()) - kday(d);
}

const clip = (s, n = 40) => { const t = String(s ?? "").trim().replace(/\s+/g, " "); return t.length > n ? t.slice(0, n) + "…" : t; };

// days: 인입일로부터 이 일수 이상 미완료면 미해결로 본다(기본 2). 반환 = 미해결 항목 배열.
export async function overdueInquiries(days = 2) {
  const out = [];

  // 재수급봇: A요청자 B담당APM C작품 D화수/페이지 E요청사유 F요청일(인입) G링크 ... L완료
  try {
    const rs = (await readRange(OPS_ID, "재수급봇!A2:L")) || [];   // 데이터가 ~1000행 빈 체크박스 블록 아래로 append됨 → 범위 열어둠
    for (const r of rs) {
      const work = String(r[2] ?? "").trim();
      if (!work) continue;
      if (isDone(r[11])) continue;
      const dy = daysSince(r[5]);
      if (dy == null || dy < days) continue;
      const detail = [clip(r[3], 24), clip(r[4], 30)].filter(Boolean).join(" / ");
      out.push({ source: "재수급", work, detail, requester: String(r[0] ?? "").trim(), apm: String(r[1] ?? "").trim(), link: String(r[6] ?? "").trim(), daysOver: dy });
    }
  } catch (e) { console.error("[inquiry] 재수급봇 읽기 실패:", e?.message ?? e); }

  // 문의봇: A시간(인입) B작품 C한국어작품 D문의유형 E요약 F필요조치 G링크 H요청자 I완료
  try {
    const iq = (await readRange(OPS_ID, "문의봇!A2:I")) || [];
    for (const r of iq) {
      const work = String(r[1] ?? "").trim() || String(r[2] ?? "").trim();
      if (!work) continue;
      if (isDone(r[8])) continue;
      const dy = daysSince(r[0]);
      if (dy == null || dy < days) continue;
      const detail = [clip(r[4], 30), clip(r[5], 24)].filter(Boolean).join(" / ");
      out.push({ source: "문의", work, type: String(r[3] ?? "").trim(), detail, requester: String(r[7] ?? "").trim(), link: String(r[6] ?? "").trim(), daysOver: dy });
    }
  } catch (e) { console.error("[inquiry] 문의봇 읽기 실패:", e?.message ?? e); }

  out.sort((a, b) => b.daysOver - a.daysOver);   // 오래 묵은 것부터
  return out;
}

// 고객사→문의봇 하향 릴레이용: 작품(+회차)로 미해결(완료 미체크) 문의/재수급 건을 찾아 원 스레드를 되짚는다.
// 재수급은 화수(D)·FIX타이틀(H,일본어)로 좁혀 정확매칭, 문의봇은 회차 전용 컬럼이 없어 요약(E) 텍스트로 확인.
export async function findUnresolved(workQuery, episodeQuery) {
  const wq = norm(workQuery);
  const epq = episodeQuery ? String(episodeQuery).trim() : null;
  const out = [];
  if (!wq) return out;

  try {
    const rs = (await readRange(OPS_ID, "재수급봇!A2:L")) || [];
    for (const r of rs) {
      const work = String(r[2] ?? "").trim();
      const fixTitle = String(r[7] ?? "").trim();
      if (!work && !fixTitle) continue;
      if (isDone(r[11])) continue;
      const nWork = norm(work), nFix = norm(fixTitle);
      if (!((nWork && (nWork.includes(wq) || wq.includes(nWork))) || (nFix && (nFix.includes(wq) || wq.includes(nFix))))) continue;
      const episode = String(r[3] ?? "").trim();
      if (epq && !episode.includes(epq)) continue;
      out.push({ source: "재수급", work: work || fixTitle, fixTitle, episode, reason: clip(r[4], 60), requester: String(r[0] ?? "").trim(), apm: String(r[1] ?? "").trim(), link: String(r[6] ?? "").trim() });
    }
  } catch (e) { console.error("[inquiry] 재수급봇 매칭 실패:", e?.message ?? e); }

  try {
    const iq = (await readRange(OPS_ID, "문의봇!A2:I")) || [];
    for (const r of iq) {
      const work = String(r[1] ?? "").trim();
      const koWork = String(r[2] ?? "").trim();
      if (!work && !koWork) continue;
      if (isDone(r[8])) continue;
      const nWork = norm(work), nKo = norm(koWork);
      if (!((nWork && (nWork.includes(wq) || wq.includes(nWork))) || (nKo && (nKo.includes(wq) || wq.includes(nKo))))) continue;
      const summary = String(r[4] ?? "");
      if (epq && !summary.includes(epq)) continue;
      out.push({ source: "문의", work: koWork || work, type: String(r[3] ?? "").trim(), summary: clip(r[4], 60), action: clip(r[5], 40), requester: String(r[7] ?? "").trim(), link: String(r[6] ?? "").trim() });
    }
  } catch (e) { console.error("[inquiry] 문의봇 매칭 실패:", e?.message ?? e); }

  return out;
}
