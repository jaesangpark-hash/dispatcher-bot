// 1차 납품 고객검수(OTC0025) 선제 감지 — "재상 님이 시켜야 도는" 걸 "봇이 먼저 들고 오는" 걸로.
//
// 왜 이렇게 만들었나 (2026-09-23 실측):
//   고객사 채널은 비공개 + 툰식이 초대 불가라 채널 감지가 불가능하고, 고객검수 코멘트 본문 API도 없다
//   (/tasks/{uuid}/comments·/comments?taskUuid= 둘 다 404, comments/pivo-inspection은 OTC0077 전용).
//   그래서 "언제 확인하러 가야 하는지"만 알려주고 본문은 에디터에서 사람이 읽는 구조로 간다.
//
//   트리거는 KP 평가 스프레드시트의 「스케쥴 시트」 탭(gid 972376296).
//   G열 = 공정/화수(一次納品/1-3 · 翻訳チェック/1-3 · 設定集), H열 = 提出予定日, J열 = FB完了日, U열 = 作品ID(PIVO).
//   ★J열 FB完了日이 TOTUS 고객검수(OTC0025) 완료일과 정확히 일치하는 걸 5개 작품에서 확인했다
//     (213004·213000 9/14, 210031 9/9, 205449 9/18, 209856 9/7). 즉 시트 기입을 기다릴 필요 없이
//     TOTUS에서 먼저 감지할 수 있다. 시트는 "무엇을 언제 보기로 했는지"(일정·담당·기대치)를 준다.
//
// 주의: /tasks 필터는 `projectUuids`(복수)다. 단수 projectUuid로 보내면 **조용히 무시되고**
//       전체 OTC0025의 앞 20건이 그대로 돌아온다(다른 고객사 프로젝트가 섞여 나옴). size 기본값도 20.
import { readRange } from "./sheets.js";
import { projectByPivo, taskList } from "./totus.js";

// KP 평가 스프레드시트 — 「스케쥴 시트」 탭
const SHEET_ID = "1jd9lOvHwCXqsSYE9vQbSqcbxO9B9sryD5_dWHJhlm4U";
const TAB = "스케쥴 시트";
const COL = { done: 0, common: 1, worker: 2, fbWorker: 3, expect: 4, title: 5, process: 6, due: 7, fbDone: 9, hope: 11, note: 13, pivo: 20 };
const HEADER_ROWS = 3;

const EDITOR_URL = (taskUuid) => `https://main.totus.pro/ko/editor?uuid=${taskUuid}`;

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const shiftDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// 시트 날짜는 "2026-10-01 (木)" 또는 "未定" 형태
const dateOf = (cell) => (String(cell || "").match(/(20\d\d-\d{2}-\d{2})/) || [])[1] || null;
// JOB명은 작품마다 제각각이지만("003_庆余年 3 …", "003_03", "003_哥哥第3话psd") 앞자리 숫자는 공통이다
const episodeOf = (jobName) => {
  const m = String(jobName || "").match(/^(\d+)/);
  return m ? Number(m[1]) : null;
};

/** 스케쥴 시트에서 1차 납품 행을 읽어 온다(최근 lookbackDays일 ~ 앞으로 aheadDays일). */
export async function readFirstDeliveryRows({ lookbackDays = 21, aheadDays = 3, process = "一次納品" } = {}) {
  const rows = await readRange(SHEET_ID, `${TAB}!A:W`);
  const today = kstToday();
  const from = shiftDays(today, -lookbackDays), to = shiftDays(today, aheadDays);
  const out = [];
  for (let i = HEADER_ROWS; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!String(r[COL.title] || "").trim()) continue;
    if (!String(r[COL.process] || "").startsWith(process)) continue;
    const due = dateOf(r[COL.due]);
    if (!due || due < from || due > to) continue;
    out.push({
      row: i + 1,
      title: String(r[COL.title] || "").trim(),
      process: String(r[COL.process] || "").trim(),
      due,
      fbDone: dateOf(r[COL.fbDone]),
      hope: dateOf(r[COL.hope]),
      expect: String(r[COL.expect] || "").trim(),
      fbWorker: String(r[COL.fbWorker] || "").trim(),
      worker: String(r[COL.worker] || "").trim(),
      note: String(r[COL.note] || "").trim(),
      pivo: String(r[COL.pivo] || "").trim(),
    });
  }
  return out;
}

/** 작품 하나의 고객검수(OTC0025) 상태. 완료 회차와 에디터 링크까지. */
export async function customerQaStatus(pivoId) {
  const proj = (await projectByPivo(pivoId))?.data?.[0];
  if (!proj?.uuid) return { found: false, reason: `PIVO ${pivoId} 프로젝트 없음` };
  // ★projectUuids(복수)라야 필터가 먹는다. size도 기본 20이라 넉넉히 준다.
  const res = await taskList({ operationTypeCode: "OTC0025", projectUuids: proj.uuid, size: "200" });
  const tasks = res?.data || [];
  const done = tasks.filter((t) => t.상태 === "COMPLETED");
  const eps = [...new Set(done.map((t) => episodeOf(t.JOB?.이름)).filter((x) => x != null))].sort((a, b) => a - b);
  const finishedAt = done.map((t) => t.완료일).filter(Boolean).sort().slice(-1)[0] || null;
  return {
    found: true,
    projectUuid: proj.uuid,
    projectName: String(proj.프로젝트 || "").replace(/\[[^\]]*\]\s*/g, "").trim(),
    total: tasks.length,
    completed: done.length,
    episodes: eps,
    finishedAt,
    links: done
      .sort((a, b) => (episodeOf(a.JOB?.이름) ?? 0) - (episodeOf(b.JOB?.이름) ?? 0))
      .map((t) => ({ episode: episodeOf(t.JOB?.이름), taskUuid: t.uuid, url: EDITOR_URL(t.uuid) })),
  };
}

/**
 * 1차 납품 행을 훑어 "지금 사람이 봐야 하는 것"만 추린다.
 *   ready  — 고객검수가 끝났는데 시트 FB完了日이 비어 있다 → 에디터에서 코멘트 확인할 차례
 *   late   — 제출예정일이 지났는데 고객검수가 아직 안 끝났다 → 고객사 쪽 대기
 * 시트 FB完了日이 이미 채워진 행은 사람이 처리한 것이므로 건드리지 않는다.
 */
export async function scanFirstDeliveryQA(opts = {}) {
  const rows = await readFirstDeliveryRows(opts);
  const today = kstToday();
  const ready = [], late = [], skipped = [], failed = [];
  for (const r of rows) {
    if (r.fbDone) { skipped.push({ ...r, why: "시트에 FB完了日 기입됨" }); continue; }
    if (!r.pivo) { failed.push({ ...r, why: "U열 作品ID 없음" }); continue; }
    let st;
    try { st = await customerQaStatus(r.pivo); }
    catch (e) { failed.push({ ...r, why: String(e?.message ?? e).slice(0, 120) }); continue; }
    if (!st.found) { failed.push({ ...r, why: st.reason }); continue; }
    if (st.completed > 0) ready.push({ ...r, qa: st });
    else if (r.due <= today) late.push({ ...r, qa: st });
  }
  return { today, scanned: rows.length, ready, late, skipped, failed };
}

/** Slack 메시지 본문. 보낼 게 없으면 null. */
export function formatFirstDeliveryQA(scan) {
  if (!scan.ready.length && !scan.late.length) return null;
  const lines = [`📮 *1차 납품 — 고객검수 확인할 것* (${scan.today} 기준, 1차 납품 ${scan.scanned}행 점검)`];
  if (scan.ready.length) {
    lines.push(`\n*고객검수 완료 — 에디터에서 코멘트 확인 (${scan.ready.length}건)*`);
    for (const r of scan.ready) {
      const eps = r.qa.episodes.length ? `${r.qa.episodes.join("·")}화` : `${r.qa.completed}건`;
      const links = r.qa.links.slice(0, 3).map((l) => `<${l.url}|${l.episode ?? "?"}화>`).join(" ");
      lines.push(`• *${r.title}* (PV-${r.pivo}) — ${eps} 완료 ${r.qa.finishedAt || ""}`);
      lines.push(`   제출예정 ${r.due}${r.expect ? ` · 기대치 ${r.expect}` : ""}${r.fbWorker ? ` · FB담당 ${r.fbWorker}` : ""}   ${links}`);
    }
  }
  if (scan.late.length) {
    lines.push(`\n*제출예정일 지났는데 고객검수 미완료 (${scan.late.length}건)*`);
    for (const r of scan.late) lines.push(`• ${r.title} (PV-${r.pivo}) — 제출예정 ${r.due}`);
  }
  if (scan.failed.length) lines.push(`\n_조회 실패 ${scan.failed.length}건: ${scan.failed.map((f) => f.title).slice(0, 4).join(", ")}_`);
  lines.push(`\n확인 끝나면 시트 J열(FB完了日)에 날짜를 넣어주세요 — 그게 있어야 다시 안 올립니다.`);
  return lines.join("\n");
}
