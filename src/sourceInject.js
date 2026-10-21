// 원문(중국어) OCR 주입 — PIVO ID + 회차 → 식번검(OTC0024) 최신 완료본 → AIA 주입 API 호출.
// 대상 선정은 여기서 결정적으로 끝내고, 실제 주입 실행은 app.js 게이트(버튼) 뒤에서만 한다.
// API 스펙: Outline 「원문(중국어) OCR 주입 API 스펙」(AIA 김영하, 2026-10-20)
import { projectByPivo, projectJobs } from "./totus.js";

const BASE = (process.env.SOURCE_INJECTION_URL || "https://agent.voithru-ai.com/api/webhook/source-injection").replace(/\/+$/, "");
const KEY = () => (process.env.SOURCE_INJECTION_API_KEY || "").trim();

// 주입할 공정. 검수 WF마다 읽는 단계가 달라서 대상도 달라야 한다(사본 간 원문 상속이 없다).
//   1-3화 AI 검수      → 번역검수(OTC0013) 를 읽는다
//   초도검수(1-20화)    → 식번검(OTC0024) 우선, 없으면 번역검수(OTC0013)
//   사람이 에디터로 볼 때 → 식번검(기본)
const STAGES = {
  "식번검": "OTC0024", "식자번역검수": "OTC0024",
  "번역검수": "OTC0013",
  "번역": "OTC0012",
};
const CODE_NAME = { OTC0024: "식자번역검수", OTC0013: "번역검수", OTC0012: "번역" };
const AUTO_CHAIN = ["OTC0024", "OTC0013", "OTC0012"];   // 초도검수가 쓰는 순서와 같다
const TARGET_CODE = "OTC0024";                 // stage 생략 시 기본(사람이 보는 사본)
const TARGET_NAME = "식자번역검수";
// 「완료」로 볼 상태. COMPLETED를 우선하고, 없으면 CONFIRMED(검수 확정)도 대상으로 본다.
const DONE_RANK = { COMPLETED: 2, CONFIRMED: 1 };
const EDITOR_URL = (uuid) => `https://main.totus.pro/ko/editor?uuid=${uuid}`;

const clean = (s) => String(s || "").replace(/\[[^\]]*\]\s*/g, "").trim();
// 마감일이 최신본 판별 기준이다 — 리테이크가 돌면 같은 공정 태스크가 2개가 되는데 상태로는 구분되지 않는다.
const dueOf = (t) => {
  const raw = t["마감일"] || t["마감일원본"] || "";
  const n = Date.parse(String(raw).replace(/\./g, "-"));
  return Number.isNaN(n) ? -1 : n;
};

async function apiCall(method, path, body) {
  if (!KEY()) return { error: "SOURCE_INJECTION_API_KEY 미설정 — .env에 키를 넣어야 한다(AIA 발급)" };
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { error: `주입 API 호출 실패: ${e.message}` };
  }
  let j = null;
  try { j = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok || j?.ok === false) {
    // 409는 blocked/already running — 호출측이 사유를 그대로 보여줄 수 있게 원본을 같이 넘긴다
    return { error: j?.error || `HTTP ${res.status}`, status: res.status, body: j };
  }
  return { data: j?.data ?? j };
}

// PIVO + 회차 → 식번검 최신 완료본. 고르지 못하면 왜 못 골랐는지까지 돌려준다.
// stage: '식번검'(기본) | '번역검수' | '번역' | 'auto'(식번검→번역검수→번역 중 완료본 있는 첫 단계)
export async function resolveTarget({ pivo, episode, stage }) {
  const want = String(stage || "").trim();
  const chain = want === "auto" ? AUTO_CHAIN
    : want ? [STAGES[want] || (/^OTC\d{4}$/.test(want) ? want : null)].filter(Boolean)
    : [TARGET_CODE];
  if (!chain.length) return { error: `모르는 단계: '${stage}' (식번검·번역검수·번역·auto 중 하나)` };
  const pv = String(pivo || "").trim();
  if (!/^\d{3,}$/.test(pv)) return { error: `PIVO ID 형식이 아님: '${pivo}'` };
  const ep = String(episode ?? "").trim();
  if (!/^\d+$/.test(ep)) return { error: `회차는 숫자 하나여야 한다: '${episode}'` };

  const p = await projectByPivo(pv);
  const proj = p?.data?.[0];
  if (!proj) return { error: `PIVO ${pv} 프로젝트를 TOTUS에서 못 찾음` };
  const projectName = clean(proj["프로젝트"] || proj.name) || `PV-${pv}`;

  // episode 필터 → 0건이면 JOB명 회차 매칭으로 폴백(구작은 source-group이 없어 필터가 안 먹는다)
  let jobs = (await projectJobs(proj.uuid, ep))?.data || [];
  if (!jobs.length) {
    const re = new RegExp(`(?:第|-|_)0*${parseInt(ep, 10)}(?:\\D|$)`);
    jobs = ((await projectJobs(proj.uuid))?.data || []).filter((x) => re.test(String(x.JOB명 || "").trim()));
  }
  if (!jobs.length) return { error: `${projectName} ${ep}화 JOB 없음 (회차 표기 확인)`, projectName, pivo: pv };

  // 체인 순서대로 보되, 완료본이 있는 첫 단계에서 멈춘다(auto가 아니면 체인 길이가 1이라 그대로).
  let code = null, all = [], done = [], seen = [];
  for (const c of chain) {
    const got = [];
    for (const job of jobs)
      for (const op of job.오퍼레이션 || [])
        for (const t of op.태스크 || [])
          if (t.오퍼레이션유형 === c) got.push({ ...t, jobName: job.JOB명 ?? null });
    if (got.length) seen.push(`${CODE_NAME[c] || c} ${got.length}건`);
    const d = got.filter((t) => DONE_RANK[t.상태]);
    if (d.length) { code = c; all = got; done = d; break; }
  }
  if (!done.length) {
    const label = chain.map((c) => CODE_NAME[c] || c).join(" → ");
    return {
      error: `${projectName} ${ep}화 ${label}에 완료된 태스크가 없음${seen.length ? ` (있는 것: ${seen.join(", ")})` : ""}`,
      projectName, pivo: pv,
    };
  }
  // 완료 상태 우선순위(COMPLETED > CONFIRMED) → 같은 등급이면 마감일 최신
  done.sort((a, b) => (DONE_RANK[b.상태] - DONE_RANK[a.상태]) || (dueOf(b) - dueOf(a)));
  const pick = done[0];

  return {
    pivo: pv, episode: ep, projectName,
    stageCode: code, stage: CODE_NAME[code] || code,
    taskUuid: pick.uuid,
    url: EDITOR_URL(pick.uuid),
    state: pick.상태, stateName: pick.상태명 || pick.상태,
    due: pick.마감일 || pick.마감일원본 || null,
    // 작업자는 {uuid, 이메일, bid} 꼴로 온다 — 이름 필드가 없어 이메일을 쓴다(없으면 bid)
    worker: pick.작업자?.이메일 || pick.작업자?.bid || null,
    jobName: pick.jobName,
    totalCopies: all.length, doneCopies: done.length,
  };
}

// 여러 회차를 한 번에 — 실패한 회차는 errors에 남기고 나머지는 그대로 진행한다(조용히 빠지지 않게).
export async function resolveMany({ pivo, episodes, stage }) {
  const ok = [], errors = [];
  for (const ep of episodes) {
    const r = await resolveTarget({ pivo, episode: ep, stage });
    (r.error ? errors : ok).push(r.error ? { episode: String(ep), error: r.error } : r);
  }
  return { ok, errors };
}

// /probe — 무료. 넣을 수 있는지와 몇 칸 채울지를 센다.
export async function probe(taskUuids) {
  const r = await apiCall("POST", "/probe", { tasks: taskUuids });
  if (r.error) return r;
  return { tasks: r.data?.tasks || [] };
}

// /jobs — 실행 접수. 하나라도 막히면 아무것도 실행되지 않는다(409 blocked).
export async function createJob(taskUuids, force = false) {
  const r = await apiCall("POST", "/jobs", { tasks: taskUuids, force: !!force });
  if (r.error) return r;
  return { jobId: r.data?.jobId, job: r.data?.job };
}

export async function jobStatus(jobId) {
  const r = await apiCall("GET", `/jobs/${encodeURIComponent(jobId)}`);
  if (r.error) return r;
  return r.data;
}

// 사람이 읽을 한 줄 — 미리보기와 결과 보고에 함께 쓴다.
export function summarizeProbe(t) {
  const c = t.counts || {};
  const head = `${t.task?.episode ?? "?"}화 · ${t.task?.state || "?"}${t.task?.assignee ? ` · ${t.task.assignee}` : ""}`;
  if (!t.ok) return `${head} — 조회 실패: ${t.error || "알 수 없음"}`;
  if (!c.rtc14Total) return `${head} — 원문 칸 자체가 없음(Totus 전처리 재실행 필요)`;
  const tail = `채울 칸 ${c.targets}개(빈 ${c.targetsEmpty}·깨짐 ${c.targetsGarbage}) / 보존 ${c.chinese} / 전체 ${c.rtc14Total}`
    + (c.dangling ? ` · ★dangling ${c.dangling}(AIA 재배정 필요)` : "");
  return `${head} — ${tail}${t.injectable ? "" : ` · 불가: ${t.blockedReason || "사유 미상"}`}`;
}

export const SOURCE_INJECT_READY = () => !!KEY();
export { TARGET_CODE, TARGET_NAME, EDITOR_URL };
