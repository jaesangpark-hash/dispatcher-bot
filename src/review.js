// 웹툰 번역 검수: 작품명+회차 → 납품탭에서 PIVO → projectUuid → 검수단계 task → 원문/번역 추출.
// 검수(판단)는 브레인이 QA_INSTRUCTIONS 기준으로 수행. 이 모듈은 텍스트 추출까지만(결정적).
import { readTab } from "./sheets-registry.js";
import { findProject, projectByPivo, projectJobs, translationText } from "./totus.js";

const TAB = { "ko-ja": "납품관리시트_Japan(한일 V5)", "zh-ja": "납품관리시트_Japan(중일 V5)" };
// 텍스트가 나오는 단계 우선순위: 식자번역검수 > 번역검수 > 번역 (식자·식자검수는 이미지/리포트라 텍스트 없음)
const STAGE_ORDER = [
  { code: "OTC0024", name: "식자번역검수" },
  { code: "OTC0013", name: "번역검수" },
  { code: "OTC0012", name: "번역" },
];
const STAGE_BY_NAME = { "식자번역검수": "OTC0024", "번역검수": "OTC0013", "번역": "OTC0012" };
const EDITOR_URL = (uuid) => `https://main.totus.pro/ko/editor?uuid=${uuid}`;

// 작품명 → PIVO (납품 V5 탭 프로젝트명 contains 매칭)
async function pivoForWork(work, lang) {
  const tab = TAB[lang] || TAB["ko-ja"];
  const r = await readTab({ sheet: "delivery", tab, where: { field: "프로젝트명", op: "contains", value: work }, limit: 300 });
  const byPivo = new Map();
  for (const o of r.rows) {
    const pivo = String(o["pivo_id"] || "").trim();
    if (pivo) byPivo.set(pivo, String(o["프로젝트명"] || "").trim());
  }
  if (!byPivo.size) return { error: `'${work}'를 ${tab}에서 못 찾음 (프로젝트명 표기 확인 필요)` };
  if (byPivo.size > 1) {
    const names = [...byPivo.values()].slice(0, 5);
    return { error: `'${work}'가 여러 작품에 매칭됨: ${names.join(" / ")}. 더 정확한 작품명 필요`, ambiguous: names };
  }
  const [pivo, projectName] = [...byPivo.entries()][0];
  return { pivo, projectName };
}

async function uuidForPivo(pivo) {
  const j = await projectByPivo(pivo);
  const p = j?.data?.[0];
  if (!p?.uuid) return { error: `PIVO ${pivo} → projectUuid 조회 실패 (TOTUS에 미등록?)` };
  return { uuid: p.uuid, name: p["프로젝트"] || p.name || "" };
}

// 회차 → 단계코드별 taskUuid
async function tasksForEpisode(projectUuid, episode) {
  const byCode = {};
  let jobInfo = null;
  const add = (job) => { if (!jobInfo) jobInfo = { index: job.순서 ?? null, name: job.JOB명 ?? null }; for (const op of job.오퍼레이션 || []) for (const t of op.태스크 || []) if (!byCode[t.오퍼레이션유형]) byCode[t.오퍼레이션유형] = t.uuid; };
  const j = await projectJobs(projectUuid, episode);
  for (const job of j?.data || []) add(job);
  // 폴백: episode 필터 0건(구작 source-group false) → 전체 jobs에서 JOB명 회차 매칭
  if (!Object.keys(byCode).length) {
    const n = parseInt(episode, 10);
    const re = new RegExp(`(?:第|-)0*${n}(?:\\D|$)`);
    const all = await projectJobs(projectUuid);
    const job = (all?.data || []).find((x) => re.test((x.JOB명 || "").trim()));
    if (job) add(job);
  }
  return { byCode, jobIndex: jobInfo?.index ?? null, jobName: jobInfo?.name ?? null };
}

// 파일내순서 0/감소 시 페이지++ (빈 박스로 0이 빠져도 견고). 텍박=파일내순서+1 (1-based, 빈박스 자리 보존)
function buildPairs(arr) {
  let page = 0, prev = null; const out = [];
  for (const x of arr) {
    if (prev === null || x.파일내순서 <= prev) page++;
    prev = x.파일내순서;
    out.push({
      pb: `${page}-${(x.파일내순서 ?? 0) + 1}`,
      src: String(x.원문 ?? "").replace(/[\r\n]+/g, "\\n"),
      tgt: String(x.번역문 ?? "").replace(/[\r\n]+/g, "\\n"),
    });
  }
  return out;
}

// 메인: 작품명+회차 → {work, episode, pivo, stage, taskUuid, url, count, pairs} 또는 {error}
export async function extractEpisode({ work, episode, lang = "ko-ja", stage = null, pivo = null }) {
  // PIVO 직접 지정(또는 work가 순수 숫자)이면 납품시트 이름매칭을 건너뛰고 TOTUS로 바로 해석 — 납품시트 미등록 작품도 검수 가능
  let usePivo = pivo && String(pivo).trim();
  if (!usePivo && /^\d{4,}$/.test(String(work || "").trim())) usePivo = String(work).trim();
  let projectName;
  if (usePivo) {
    projectName = null;                                   // uuidForPivo에서 이름 확보
  } else {
    const pv = await pivoForWork(work, lang);
    if (pv.error) return pv;
    usePivo = pv.pivo; projectName = pv.projectName;
  }
  const uu = await uuidForPivo(usePivo);
  if (uu.error) return uu;
  if (!projectName) projectName = String(uu.name || work || `PV-${usePivo}`).replace(/\[[^\]]*\]\s*/g, "").trim() || `PV-${usePivo}`;
  const { byCode } = await tasksForEpisode(uu.uuid, episode);
  if (!Object.keys(byCode).length) return { error: `${projectName} ${episode}화 task 없음 (회차 표기/진행상태 확인)` };
  const order = stage && STAGE_BY_NAME[stage] ? [{ code: STAGE_BY_NAME[stage], name: stage }] : STAGE_ORDER;
  for (const s of order) {
    if (!byCode[s.code]) continue;
    const arr = (await translationText(byCode[s.code]))?.data;
    if (Array.isArray(arr) && arr.length) {
      return {
        work: projectName, episode: String(episode), pivo: usePivo, stage: s.name,
        taskUuid: byCode[s.code], url: EDITOR_URL(byCode[s.code]), count: arr.length, pairs: buildPairs(arr),
      };
    }
  }
  const present = Object.keys(byCode).map((c) => STAGE_ORDER.find((s) => s.code === c)?.name || c).join(", ");
  return { error: `${projectName} ${episode}화: 텍스트(원문↔번역) 있는 검수단계 없음. 존재 단계: ${present || "없음"} (번역/식자번역검수 미진행 가능)` };
}

// 대괄호 태그([PRJ-…] [PV-…] [고객사] 등) 전부 제거한 정제명
function cleanName(s) { return String(s || "").replace(/\[[^\]]*\]\s*/g, "").trim(); }

function csvField(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// PIVO ID 또는 TOTUS 프로젝트명 "완전일치"로만 프로젝트 해석 — 납품시트 안 거침, fuzzy(contains) 매칭 없음.
// projectName은 원문(대괄호 태그 포함) 또는 정제명 둘 다 완전일치로 인정.
export async function resolveProjectExact({ pivo, projectName }) {
  if (pivo && String(pivo).trim()) {
    const uu = await uuidForPivo(String(pivo).trim());
    if (uu.error) return uu;
    return { uuid: uu.uuid, pivo: String(pivo).trim(), name: cleanName(uu.name) || `PV-${pivo}` };
  }
  const q = String(projectName || "").trim();
  if (!q) return { error: "pivo 또는 projectName 중 하나는 필요함" };
  const r = await findProject(q).catch((e) => ({ _err: e?.message }));
  const list = Array.isArray(r?.data) ? r.data : [];
  if (!list.length) return { error: `TOTUS에서 '${q}' 검색 결과 없음(오타/미등록 확인)` };
  const norm = (s) => String(s ?? "").trim();
  const rawName = (p) => norm(p["프로젝트"] ?? p.name);
  const exact = list.filter((p) => rawName(p) === q || cleanName(rawName(p)) === q);
  if (exact.length === 1) {
    const p = exact[0];
    const pv = String(p._detail?.pivoId ?? p["PIVO"] ?? "").trim();
    return { uuid: p.uuid, pivo: pv, name: cleanName(rawName(p)) };
  }
  const candidates = (exact.length > 1 ? exact : list).slice(0, 8).map((p) => rawName(p));
  if (exact.length > 1) return { error: `'${q}'와 완전일치가 ${exact.length}건 — PIVO ID로 지정 필요`, candidates };
  return { error: `'${q}'와 완전일치하는 TOTUS 프로젝트명 없음(부분일치 ${list.length}건 존재). 완전한 프로젝트명 또는 PIVO ID로 지정 필요`, candidates };
}

// 회차 범위(from~to) 원문/번역 텍스트를 CSV(회차,단계,텍박,원문,번역문)로 추출. 단계는 회차별 자동(식자번역검수>번역검수>번역) 또는 stage로 고정.
// QA 판단 없이 순수 추출만 — 결정적.
export async function extractEpisodeRange({ pivo = null, projectName = null, from, to, stage = null, budgetMs = null }) {
  const proj = await resolveProjectExact({ pivo, projectName });
  if (proj.error) return proj;
  const fromN = parseInt(from, 10), toN = parseInt(to, 10);
  if (!Number.isFinite(fromN) || !Number.isFinite(toN) || fromN > toN) return { error: `잘못된 회차 범위: ${from}~${to}` };
  if (toN - fromN + 1 > 100) return { error: `범위가 너무 큼(${toN - fromN + 1}화). 100화 이하로 나눠 요청.` };
  const order = stage && STAGE_BY_NAME[stage] ? [{ code: STAGE_BY_NAME[stage], name: stage }] : STAGE_ORDER;
  // 스키마(사용자 지정): project_uuid, project_name(정제명), job_index, job_name, file_name, text_box_order, text(일본어 번역문)
  const rows = [["project_uuid", "project_name", "job_index", "job_name", "file_name", "text_box_order", "text"]];
  const episodes = [];
  const missing = [];
  const startedAt = Date.now();
  let ep = fromN;
  for (; ep <= toN; ep++) {
    // 시간 예산 초과 시 여기서 중단 — 이 회차(ep)는 미처리로 남기고 nextFrom으로 이어받게 한다(최소 1화는 처리)
    if (budgetMs && ep > fromN && Date.now() - startedAt > budgetMs) break;
    const { byCode, jobIndex, jobName } = await tasksForEpisode(proj.uuid, String(ep));
    if (!Object.keys(byCode).length) { missing.push({ episode: ep, reason: "task 없음" }); continue; }
    let picked = null;
    for (const s of order) {
      if (!byCode[s.code]) continue;
      const arr = (await translationText(byCode[s.code]))?.data;
      if (Array.isArray(arr) && arr.length) { picked = { stage: s.name, arr }; break; }
    }
    if (!picked) { missing.push({ episode: ep, reason: "텍스트 있는 단계 없음" }); continue; }
    for (const x of picked.arr) {
      rows.push([proj.uuid, proj.name, jobIndex ?? "", jobName ?? "", x.파일명 ?? "", x.파일내순서 ?? "", String(x.번역문 ?? "").replace(/[\r\n]+/g, "\\n")]);
    }
    episodes.push({ episode: ep, stage: picked.stage, count: picked.arr.length });
  }
  const stopped = ep <= toN;   // 예산으로 중단됨(ep가 아직 남음)
  const csv = rows.map((r) => r.map(csvField).join(",")).join("\n");
  return { work: proj.name, pivo: proj.pivo, from: fromN, to: toN, episodes, missing, totalRows: rows.length - 1, csv, done: !stopped, nextFrom: stopped ? ep : null };
}

// 브레인이 따를 검수 기준 + 출력 템플릿 (추출 결과 앞에 붙여 반환)
export const QA_INSTRUCTIONS = [
  "[웹툰 번역 검수 기준 — 아래 pairs(원문↔번역)를 이 기준으로 2패스 검수하라]",
  "역할: 日本語マンガ/Webtoonローカライズ 품질관리 QA. 일본어 번역문 교정 관점, 정밀도 우선(과검출 금지).",
  "■ 잡는 것(ERROR만): ①오탈자(특히 濁音 오타 んだ/んた·んで/んて·だから/たから·ください/くたさい), ②문법붕괴(조사 오용·누락·중복, 문장 미성립), ③표기흔들림(작품 내 같은 말 표기 불일치), ④漢字오용(동음이의 혼동), ⑤명백한 의미왜곡/오역, ⑥UI/시스템 문자열 오류(raw 날짜 등).",
  "■ 절대 안 잡는 것: 스타일·윤문·'더 자연스러운 대안'·톤강화·취향·표현불자연(STYLE) / 말줄임(…)·끊긴 대사·구어축약·감탄·거친말투·감정 반복·분절·효과음·개행 / 회상 동일대사. 句読点은 웹툰 세리프에 원래 없음 → 없다고 지적하거나 수정안에 句読点 추가 금지. 애매하면 버린다.",
  "■ 한↔일 누락/오역: 일본어가 깨지지 않고 독해가 멈추지 않으면 기본 제외. 단 인물·관계·사건 이해가 바뀌는 명백한 의미왜곡은 포함하되 현지화 의도일 수 있으면 사유에 '검토'로 표시(지명·국가·설정 변경 등).",
  "■ 2패스: PASS1=의미·오역, PASS2=의미판단 멈추고 한 글자씩 문자단위로 濁音·오탈자 점검.",
  "■ 출력(작업자 수정요청용, 그대로 복붙 가능하게):",
  "  첫 줄: {work} / {episode}  ({stage})",
  "  둘째 줄: task: {url}",
  "  그리고 문제 행마다 ↓ (빈 줄로 구분)",
  "    {pb}",
  "    {수정전 번역문 — 말풍선 줄바꿈대로, \\n은 실제 줄바꿈으로}",
  "    ->",
  "    {수정후 번역문}",
  "    사유: 왜 문제인지 한 줄(문법/표기/의미/오탈자 중 무엇인지 명시)",
  "■ 문제 없으면 본문에 '問題なし'만. 修正不要·要確認·可能性·より自然 같은 말은 출력 금지. 장황한 해설·여러 대안 나열 금지.",
  "pairs 필드: pb=페이지-텍박(1-based), src=원문(한국어), tgt=번역문(일본어). 검수 대상은 tgt(일본어).",
].join("\n");
