// TOTUS 게이트웨이 읽기(read-only). PLATFORM_API_URL/TOKEN 사용(자체 .env 우선, 없으면 botV2 .env 폴백).
// 베이스: https://totus-api.voithru-ai.com (명세의 {EC2}:9101을 공개 게이트웨이로 대체)
import fs from "node:fs";

const BOTV2_ENV = "c:/Users/P-205/Desktop/slack-inquiry-botV2/.env";

// ★EC2 등 원격 배포 시 로컬 botV2 경로가 없음 — process.env를 우선 쓰고, 로컬 개발 환경에서만 파일로 폴백.
function creds() {
  let url = process.env.PLATFORM_API_URL?.trim().replace(/\/+$/, "");
  let tok = process.env.PLATFORM_API_TOKEN?.trim().replace(/^['"]|['"]$/g, "");
  if (!url || !tok) {
    try {
      const env = fs.readFileSync(BOTV2_ENV, "utf8");
      if (!url) url = env.match(/^PLATFORM_API_URL=(.*)$/m)?.[1]?.trim().replace(/\/+$/, "");
      if (!tok) tok = env.match(/^PLATFORM_API_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    } catch { /* 원격 환경엔 이 파일이 없음 — process.env만으로 판단 */ }
  }
  if (!url || !tok) throw new Error("PLATFORM_API_URL/TOKEN 없음 (.env 또는 botV2 .env)");
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
// Content-Disposition에서 실제 파일명 추출(filename* RFC5987 우선, 없으면 filename=""). 못 읽으면 null.
function parseContentDispositionFilename(header) {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* fallthrough */ } }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// 설정집 xlsx 원본 다운로드(바이너리+실제 파일명) — Slack 공유용. getJSON과 달리 파싱 없이 반환.
// TOTUS가 Content-Disposition으로 내려주는 실제 파일명({날짜}【設定集】{번역작품명}_{원본작품명}.xlsx)을 그대로 보존한다 — 임의로 재작명 금지.
export async function setupXlsxBuffer(projectUuid, targetLanguageCode) {
  const { url, tok } = creds();
  const qs = new URLSearchParams({ format: "xlsx", targetLanguageCode: targetLanguageCode || "LGC0003" }).toString();
  const full = `${url}/api/v1/setup/${encodeURIComponent(projectUuid)}?${qs}`;
  const r = await fetch(full, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`TOTUS ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const filename = parseContentDispositionFilename(r.headers.get("content-disposition"));
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, filename };
}
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
// ★delivery-source-groups는 이제 s3URL(원시 S3 경로)만 주고 다운로드URL은 안 줌(2026-07-28 API 변경 확인 — 회귀 아니라 의도된 변경, #26으로 개별 발급하는 방식으로 바뀜).
// #26 다운로드용 Signed URL 발급 — s3Path(s3://...) 하나당 1시간짜리 서명 URL 1개 발급. 내부적으로 totus REST s3/downloadUrl 호출.
export const filePresignUrl = (s3Path, fileName) => sendJSON("POST", `/files/download-url`, { s3Path, fileName: fileName || "" });
// 회차의 소스그룹(어드민 파일순서 관리 화면과 동일 — 리테이크 아님, files/reorder·source-groups/complete 대상 조회용)
export const episodeSourceGroups = (projectUuid, episode) => getJSON(`/projects/${projectUuid}/source-groups`, { episode });
// #25 태스크(식자/식자검수)의 원본 파일 — 미납품(에디터 작업중)분. 다운로드URL(서명) 포함.
export const editorFiles = (taskUuid) => getJSON(`/tasks/${taskUuid}/editor-files`);
// #26 태스크(식자/식자검수)의 원본 파일 — 이미 납품된 분. format: psd|jpg|ori|all
export const deliveryFiles = (taskUuid, format = "all") => getJSON(`/tasks/${taskUuid}/delivery-files`, { format });

// ── 쓰기(MUTATION) — JobProcess 납품예정일 일괄 변경 ────────────────
// ★실제 변경. 봇의 게이트(확인 버튼) 핸들러에서만 호출할 것 (LLM 도구로 직접 노출 금지).
async function sendJSON(method, path, body, extra = {}) {
  const { url, tok } = creds();
  const r = await fetch(`${url}/api/v1${path}`, {
    method,
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
  sendJSON("POST", `/job-processes/dates`, { jobProcesses: jps, dryRun }, { "X-Confirm-Mutation": "I-UNDERSTAND-PROD" });
// 프로젝트 설정 변경(한 번에 하나, 우선순위 action>managerAuthUuid>name>genre).
// body 예: { name: "새 프로젝트명" } / { action: "hold"|"unhold"|"process"|"pause"|"complete"|"cancel" } / { managerAuthUuid } / { genreCode }
export const setProjectSettings = (projectUuid, body) =>
  sendJSON("PATCH", `/projects/${projectUuid}/settings`, body, { "X-Confirm-Mutation": "I-UNDERSTAND-PROD" });
// 연결 Task 생성(리테이크) — 대상 taskUuid(COMPLETED 상태)+하위 오퍼레이션 태스크를 전부 새로 생성.
// 기존 READY/PROCESSING 하위 태스크는 닫히고 COMPLETED는 유지, 작업자·타입은 원본에서 승계.
// 응답 data.createdTaskUuids = 새로 생성된 태스크 uuid 배열.
export const retakeTask = (taskUuid) =>
  sendJSON("POST", `/tasks/${taskUuid}/retake`, { creationReason: "RETAKE" }, { "X-Confirm-Mutation": "I-UNDERSTAND-PROD" });
// Task 일정 일괄 변경. tasks=[{taskUuid,startDate,endDate}], 날짜는 YYYY-MM-DD(게이트웨이가 KST 00:00~23:59:59로 자동 보정) 또는 ISO datetime.
// 응답 data: {성공,실패,succeededTaskUuids,failedTaskUuids,정규화된일정}. 일부 실패해도 success:true(부분 성공 허용).
export const setTaskDates = (tasks) =>
  sendJSON("POST", `/tasks/dates`, { tasks }, { "X-Confirm-Mutation": "I-UNDERSTAND-PROD" });
// 파일 순서 변경(에디터 파일 관리 드래그 순서 반영). sources=[{sourceId, order}]
export const reorderFiles = (sources) =>
  sendJSON("POST", `/files/reorder`, { sources }, { "X-Confirm-Mutation": "I-UNDERSTAND-PROD" });
// 소스그룹(회차) 파일순서 확정 처리. sourceGroupIds=[id,...]
export const completeSourceGroups = (sourceGroupIds) =>
  sendJSON("POST", `/source-groups/complete`, { sourceGroupIds }, { "X-Confirm-Mutation": "I-UNDERSTAND-PROD" });

// ── 재수급 원본 → PIVO 업로드(2026-08-23) ────────────────────────
// PIVO 작품 회차의 원본(작업용) 파일 목록. read-only(PIVO GraphQL Directory query만, 부작용 없음).
// 응답: { data: { pid, episode, 작품명, 원제, 회차폴더, 파일목록:[{fileId,파일명,크기}] } } (실측, PV-212305/1화)
export const pivoEpisodeSourceFiles = (pid, episode) => getJSON(`/pivo/${encodeURIComponent(pid)}/episodes/${encodeURIComponent(episode)}/source-files`);

// [MUTATION] PIVO 회차에 원본 파일 업로드+회차지정(fileStructureUpsert→presigned S3 PUT→complete→directoryEpisodeUpdateV2, 이관 완료 회차도 재이관 가능).
// 같은 파일명 재업로드=동일 fileId 유지한 채 내용만 덮어씀(재수급 교체에 안전, 삭제 후 재업로드 아님) — fileName은 반드시 기존과 동일해야 교체로 처리됨.
// 요청 바디는 OpenAPI에 미문서화(같은 게이트웨이의 /projects/{uuid}/files와 동일 규약으로 추정: multipart/form-data, 필드명 "file").
// ★2026-08-23 실측 검증 완료: PV-210986 1화 4.psd(26.6MB)를 그대로 재업로드→"기존 파일 덮어쓰기 완료(재조회 검증됨)" 응답, 파일수 그대로 11개·크기 일치 확인.
// PIVO 허용 확장자(psd·psb·png·jpg·pdf 등) 외 파일이 회차 폴더에 섞이면 그 폴더 전체 동기화가 스킵됨(409 EPISODE_MATCH_SKIPPED_UNSUPPORTED_EXTENSION).
export async function pivoUploadSourceFile(pid, episode, buffer, fileName) {
  const { url, tok } = creds();
  const form = new FormData();
  form.append("file", new Blob([buffer]), fileName);
  const r = await fetch(`${url}/api/v1/pivo/${encodeURIComponent(pid)}/episodes/${encodeURIComponent(episode)}/source-files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "X-Confirm-Mutation": "I-UNDERSTAND-PROD" },
    body: form,
    signal: AbortSignal.timeout(120000),   // 대용량(원본 PSD 수백MB) 대비 넉넉히
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`TOTUS ${r.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}
