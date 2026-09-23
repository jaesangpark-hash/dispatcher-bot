// 초도 납품 완료 → 후속 회차 식자 작업자 이관을 APM에게 요청한다.
//
// 판정 기준(2026-09-16 재상 님 확정):
//   - "초도"는 1화의 납품예정일을 공유하는 연속 회차 블록. 0화(프롤로그)는 별도 납품일을 갖는
//     경우가 있어 기준에서 제외한다. 식자 태스크 완료가 아니라 **납품예정일**이 기준 — 식자가
//     끝나도 식자검수·최종검수·고객검수가 남아 납품까지 한 달 넘게 벌어지는 작품이 많다.
//   - 납품예정일은 M/D 23:59:59 KST 관례라 **-1초 후 UTC+9**로 날짜를 뽑는다(안 그러면 하루 밀림).
//   - 이관 대상은 지정된 작업자 명단에 한한다. Yutu가 후속에 들어가 있으면 이미 이관된 것으로 본다.
//   - 한국어 타이틀이 없는 작품은 그 시점에 건너뛴다(영구 제외 아님 — 타이틀이 채워지면 살아난다).
//
// 상태는 운영 통합 시트의 「초도 완료 트래킹」 탭에 둔다. 배정 현황 탭은 매일 clear+append로
// 통째로 다시 쓰이기 때문에 거기에 열을 더하면 수기 체크가 날아간다.
// 이 탭에서 봇이 쓰는 칸은 E·F·G(미체크 행 한정)와 H뿐이다. I(처리 완료)·J(비고)는 사람 전용.
import { readRange } from "./sheets.js";
import { setCells } from "./sheets-write.js";
import { projectByPivo, projectJobs, jobProcesses } from "./totus.js";

export const OPS_SHEET = "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";
export const TRACK_TAB = "초도 완료 트래킹";
export const HANDOVER_CHANNEL = "C09AUQN8GEB";   // #재팬_작업요청
const DRIVE_TAB = "출판사 드라이브 링크";
const ASSIGN_TAB = "배정 현황";
const JAESANG = "U04463JR4HH";
const APM_SLACK = { "서주원": "U07E0QPL8MV", "정태영": "U05CE8HFA6B" };

// 이관 대상 작업자(재상 님 지정). 새 인원이 생기면 여기에 추가한다.
export const HANDOVER_WORKERS = ["Tika Mando", "강연재", "주슬기", "서윤주", "이지인", "정은주", "손광수"];
// 작업자 DB에 없거나 다른 이름으로 올라간 계정 — 이메일을 명단 이름으로 강제 매핑.
const EMAIL_ALIAS = { "asky4u@gmail.com": "손광수" };
// 후속에 이 이름이 보이면 이관이 끝난 것으로 간주한다.
const HANDED_OVER = ["yutu"];

const lc = (s) => String(s ?? "").trim().toLowerCase();
const isTarget = (name) => HANDOVER_WORKERS.some((w) => lc(w) === lc(name));
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 납품예정일 → KST 날짜. "2026-09-15T15:00Z"는 KST 9/16 00:00이지만 실제 마감은 9/15다.
export function deliveryDateKST(v) {
  if (!v) return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(+d)) return "";
  return new Date(+d + 9 * 3600 * 1000 - 1000).toISOString().slice(0, 10);
}

async function workerNames() {
  const map = {};
  try {
    const rows = await readRange(process.env.WORKER_SHEET_ID, process.env.WORKER_SHEET_RANGE || "작업자 DB!A:F");
    const head = (rows[0] || []).map((x) => String(x || "").trim());
    const ei = head.findIndex((h) => /email|이메일/i.test(h));
    const ni = head.findIndex((h) => /name|이름|성명/i.test(h));
    if (ei >= 0 && ni >= 0) for (const r of rows.slice(1)) if (r[ei]) map[lc(r[ei])] = String(r[ni] || "").trim();
  } catch { /* 작업자 DB를 못 읽으면 이메일을 그대로 쓴다 */ }
  return (email) => EMAIL_ALIAS[lc(email)] || map[lc(email)] || String(email || "");
}

// 그 작품의 초도 블록(1화 납품예정일 공유 구간)과 현재 식자 작업자.
export async function inspectWork(pivo, nameOf) {
  const proj = await projectByPivo(pivo);
  const uuid = (proj?.data || proj || [])[0]?.uuid;
  if (!uuid) return { skip: "projectUuid 없음" };

  const jp = (await jobProcesses(uuid))?.data || [];
  const jobs = [].concat(...jp.map((o) => o["JOB목록"] || []))
    .map((j) => ({ ep: j["작업단위번호"], due: deliveryDateKST(j["납품예정일"]) }))
    .filter((j) => j.ep != null).sort((a, b) => a.ep - b.ep);
  const main = jobs.filter((j) => j.ep >= 1);
  const first = main.find((j) => j.ep === 1 && j.due) || main.find((j) => j.due);
  if (!first) return { uuid, skip: "납품예정일 없음" };
  const block = [];
  for (const j of main) { if (j.due === first.due) block.push(j); else if (block.length) break; }

  const jl = (await projectJobs(uuid))?.data || [];
  const workers = new Set();
  for (const job of jl) {
    if (!/^\d+[_\s]/.test(String(job["JOB명"] || ""))) continue;
    for (const op of job["오퍼레이션"] || []) {
      for (const t of op["태스크"] || []) {
        if (t["오퍼레이션유형"] !== "OTC0014" || t["상태"] === "DROP") continue;
        const n = nameOf(t["작업자"]?.["이메일"]);
        if (n) workers.add(n);
      }
    }
  }
  const list = [...workers];
  return {
    uuid,
    initialDue: first.due,
    initialEps: block.length,
    workers: list,
    targets: list.filter(isTarget),
    handedOver: list.some((w) => HANDED_OVER.some((h) => lc(w).includes(h))),
  };
}

// 트래킹 탭에서 오늘 요청을 보낼 작품을 고른다. TOTUS는 후보에만 물어본다(전수 조회 금지).
//
// includeToday: 납품예정일이 **오늘인** 행까지 포함할지(2026-09-23 추가).
//   납품예정일은 그날 23:59:59 KST 마감이라, 오전에 도는 슬롯에서 당일 건을 넣으면 아직 납품 전이다.
//   그래서 오전 슬롯은 지난 건만(false), 저녁 슬롯은 당일 건까지(true) 본다.
//   이걸 안 나누면 "오늘 초도 납품했는데 공지가 안 왔다"가 된다(재상 님 리포트, 2026-09-23).
export async function collectTargets({ includeToday = false } = {}) {
  const nameOf = await workerNames();
  const today = kstToday();
  const rows = await readRange(OPS_SHEET, `'${TRACK_TAB}'!A1:J`);
  const drive = await readRange(OPS_SHEET, `'${DRIVE_TAB}'!A2:I`);
  const koTitle = {};
  for (const r of drive) { const p = String(r[8] || "").trim(); if (p) koTitle[p] = String(r[2] || "").trim(); }

  const items = [];
  const skipped = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const pivo = String(r[0] || "").trim();
    if (!pivo) continue;
    if (String(r[8] || "").trim().toUpperCase() === "TRUE") continue;   // 처리 완료 — 사람이 체크
    if (String(r[7] || "").trim()) continue;                            // 이미 요청 보낸 행
    const due = String(r[4] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;                     // 납품예정일 미기입
    if (includeToday ? due > today : due >= today) continue;            // 초도 납품 전
    const ko = koTitle[pivo];
    if (!ko) { skipped.push({ pivo, row: i + 1, why: "한국어 타이틀 없음" }); continue; }

    let info;
    try { info = await inspectWork(pivo, nameOf); }
    catch (e) { skipped.push({ pivo, row: i + 1, why: `TOTUS 조회 실패(${e?.message ?? e})` }); continue; }
    if (info.skip) { skipped.push({ pivo, row: i + 1, why: info.skip }); continue; }
    if (info.handedOver) { skipped.push({ pivo, row: i + 1, why: "Yutu 배정 확인 — 이관 완료로 간주" }); continue; }
    if (!info.targets.length) { skipped.push({ pivo, row: i + 1, why: "명단 작업자 아님" }); continue; }

    items.push({
      pivo, row: i + 1, ko,
      apm: String(r[2] || "").trim(),
      eps: info.initialEps,
      due: info.initialDue,
      workers: info.targets,
      uuid: info.uuid,
    });
  }
  items.sort((a, b) => String(a.due).localeCompare(String(b.due)));
  return { items, skipped };
}


export function buildMessage(items) {
  const apms = [...new Set(items.map((i) => i.apm).filter(Boolean))];
  const head = apms.map((a) => (APM_SLACK[a] ? `<@${APM_SLACK[a]}>` : a)).join(" ");
  return [
    head,
    "아래 작품들 초도 납품이 완료되었습니다.",
    "후속 회차부터 식자 작업자 이관 진행 부탁 드립니다.",
    "",
    ...items.map((i) => `• ${i.ko} - ${i.apm}`),
    "",
    `cc <@${JAESANG}>`,
  ].join("\n");
}

export function buildLinkReply(items) {
  return ["프로젝트 링크입니다.", "",
    ...items.map((i) => `• ${i.ko} — <https://admin.totus.pro/ko/workProgressManagementDetail/?id=${i.uuid}|프로젝트 링크>`),
  ].join("\n");
}

// 요청 발송일(H)만 기록한다. 처리 완료·비고는 사람 몫이라 건드리지 않는다.
export async function markSent(items, date) {
  if (!items.length) return 0;
  await setCells(OPS_SHEET, items.map((i) => ({ a1: `'${TRACK_TAB}'!H${i.row}`, value: date || kstToday() })));
  return items.length;
}

// 배정 현황에 새로 생긴 작품을 트래킹 탭 맨 아래에 덧붙인다(기존 행은 건드리지 않는다).
export async function syncNewWorks() {
  const nameOf = await workerNames();
  const track = await readRange(OPS_SHEET, `'${TRACK_TAB}'!A1:J`);
  const known = new Set(track.slice(1).map((r) => String(r[0] || "").trim()).filter(Boolean));
  const assign = await readRange(OPS_SHEET, `'${ASSIGN_TAB}'!A2:R`);
  const drive = await readRange(OPS_SHEET, `'${DRIVE_TAB}'!A2:I`);
  const koTitle = {};
  for (const r of drive) { const p = String(r[8] || "").trim(); if (p) koTitle[p] = String(r[2] || "").trim(); }

  const added = [];
  for (const r of assign) {
    const pivo = String(r[17] || "").trim();
    if (!pivo || known.has(pivo)) continue;
    known.add(pivo);
    let info = {};
    try { info = await inspectWork(pivo, nameOf); } catch { /* 조회 실패는 다음 날 다시 */ }
    added.push([pivo, koTitle[pivo] || "", String(r[3] || "").trim(), info.initialEps ?? "",
      info.initialDue || "", (info.workers || []).join(", "), (info.targets || []).join(", "), "", false, ""]);
  }
  if (added.length) {
    const start = track.length + 1;
    await setCells(OPS_SHEET, added.flatMap((row, n) =>
      row.map((v, c) => ({ a1: `'${TRACK_TAB}'!${String.fromCharCode(65 + c)}${start + n}`, value: v }))));
  }
  return added.length;
}
