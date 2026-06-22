// TOTUS 게이트웨이 읽기(read-only). botV2 .env의 PLATFORM_API_URL/TOKEN 사용.
// 베이스: https://totus-api.voithru-ai.com (명세의 {EC2}:9101을 공개 게이트웨이로 대체)
import fs from "node:fs";

const BOTV2_ENV = "c:/Users/P-205/Desktop/slack-inquiry-botV2/.env";

function creds() {
  const env = fs.readFileSync(BOTV2_ENV, "utf8");
  const url = env.match(/^PLATFORM_API_URL=(.*)$/m)?.[1]?.trim().replace(/\/+$/, "");
  const tok = env.match(/^PLATFORM_API_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  if (!url || !tok) throw new Error("PLATFORM_API_URL/TOKEN 없음 (botV2 .env)");
  return { url, tok };
}

async function getJSON(path, query) {
  const { url, tok } = creds();
  const params = query
    ? "?" + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== "")).toString()
    : "";
  const full = `${url}/api/v1${path}${params}`;
  const r = await fetch(full, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`TOTUS ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// #56 PIVO ID → 프로젝트·견적(uuid·납품목표일·견적/작업 특이사항·작업량)
export const quotationByPivo = (pivoId) => getJSON(`/quotations/by-pivo/${encodeURIComponent(pivoId)}`);
// #1 작품명 검색 → projectUuid 등 어드민 목록
export const findProject = (name) => getJSON(`/projects`, { name });
// PIVO ID → 프로젝트(uuid). 신작은 ?pivoId= 로 바로 잡힘(검수 추출 체인용)
export const projectByPivo = (pivoId) => getJSON(`/projects`, { pivoId });
// #43 프로젝트 일정 현황 요약(공정별 지연/임박)
export const scheduleSummary = (projectUuid) => getJSON(`/projects/${projectUuid}/schedule-summary`);
// #6 JOB→Operation→Task 구조
export const projectJobs = (projectUuid, episode) => getJSON(`/projects/${projectUuid}/jobs`, { episode });
// #39 Task 목록(필터)
export const taskList = (params) => getJSON(`/tasks`, params);
// #35 Task 상세
export const taskDetail = (taskUuid) => getJSON(`/tasks/${taskUuid}`);
// #36 원문↔번역문 텍스트 쌍
export const translationText = (taskUuid) => getJSON(`/tasks/${taskUuid}/translation-text`);

// #4 JOB(JobProcess) 목록 — jobProcessUuid + 작업단위번호(회차) + 납품예정일 보유. 회차→jobProcessUuid 해석용.
export const jobProcesses = (projectUuid) => getJSON(`/projects/${projectUuid}/job-processes`);
// #5 납품 진행 + 현재 납품예정일
export const deliveryWorkProcesses = (projectUuid) => getJSON(`/projects/${projectUuid}/delivery-work-processes`);
// #24 에피소드별 원본(소스) 파일 + 다운로드URL(서명, cf.totus.pro). episodes="1" 또는 "1,2,3"
export const deliverySourceGroups = (projectUuid, episodes) => getJSON(`/projects/${projectUuid}/delivery-source-groups`, { episodes });

// ── 쓰기(MUTATION) — JobProcess 납품예정일 일괄 변경 ────────────────
// ★실제 변경. 봇의 게이트(확인 버튼) 핸들러에서만 호출할 것 (LLM 도구로 직접 노출 금지).
async function postJSON(path, body, extra = {}) {
  const { url, tok } = creds();
  const r = await fetch(`${url}/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...extra },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`TOTUS ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
// jps = [{ jobProcessUuid, deliveryDate(YYYY-MM-DD 또는 ISO), modificationReason? }]
// dryRun=true면 부작용 없이 정규화 결과만. Prod warn 모드지만 X-Confirm-Mutation 권장.
export const setDeliveryDate = (jps, dryRun = false) =>
  postJSON(`/job-processes/dates`, { jobProcesses: jps, dryRun }, { "X-Confirm-Mutation": "I-UNDERSTAND-PROD" });
