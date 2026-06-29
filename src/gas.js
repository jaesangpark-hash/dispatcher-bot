// 납품·리테이크 GAS 쿼리 웹앱 호출 (서버측 필터/집계 → 빠름·라이브). .env GAS_QUERY_URL/SECRET 필요.
// 팀 시트는 GAS가 읽기 전용으로 조회(무손상). 미설정이면 gasReady()=false → 기존 시트 직접조회 폴백.
const GAS_URL = process.env.GAS_QUERY_URL;
const GAS_SECRET = process.env.GAS_QUERY_SECRET;
export const gasReady = () => Boolean(GAS_URL && GAS_SECRET);

// GAS는 날짜 셀을 Date→UTC ISO로 직렬화 → KST yyyy-MM-dd로 정리. 이미 yyyy-MM-dd면 그대로.
function toKstDate(v) {
  if (typeof v !== "string" || !v) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (isNaN(d)) return v;
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
const DATE_FIELDS = ["delivery_date", "date", "duedate"];
function fmtDates(o) { if (o && typeof o === "object") for (const k of DATE_FIELDS) if (k in o) o[k] = toKstDate(o[k]); return o; }

const ROW_CAP = 150;   // list 결과가 이보다 많으면 컷(LLM 컨텍스트 폭발·지연 방지) — 더 필요하면 범위를 좁혀 재요청

export async function gasQuery(params) {
  if (!gasReady()) throw new Error("GAS_QUERY_URL/SECRET 미설정");
  const clean = { secret: GAS_SECRET };
  for (const [k, v] of Object.entries(params)) if (v != null && String(v).trim() !== "") clean[k] = v;
  const u = GAS_URL + "?" + new URLSearchParams(clean);
  const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { throw new Error("GAS 응답 파싱 실패: " + String(t).slice(0, 150)); }
  if (j.error) throw new Error("GAS: " + j.error);
  if (Array.isArray(j.rows)) {
    j.count = j.count ?? j.rows.length;
    if (j.rows.length > ROW_CAP) { j.truncated = true; j.note = `결과 ${j.count}건 중 ${ROW_CAP}건만 반환 — 너무 많으니 기간/작품을 더 좁혀 재요청하거나, 작품별 건수는 mode=agg를 쓰라`; j.rows = j.rows.slice(0, ROW_CAP); }
    j.rows = j.rows.map(fmtDates);
  }
  return j;
}
