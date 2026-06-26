// 리테이크 피드백 메시지 작성 — 작품/회차/수정내용으로 번역가에게 보낼 일본어 메시지 조립(read-only).
// 정보원: lookupWork(FIX일본어 타이틀·APM), 작업자 정보 탭(번역가), 작업자 DB(번역가 Slack ID·채널), TOTUS(식자검수 에디터).
// 실제 발송은 app.js 게이트(확인 버튼) 핸들러에서만.
import { readRange } from "./sheets.js";
import { lookupWork } from "./works.js";
import { findProject, projectJobs } from "./totus.js";

const KP_SHEET = "1jd9lOvHwCXqsSYE9vQbSqcbxO9B9sryD5_dWHJhlm4U";
const INFO_TAB = "작업자 정보";          // A=한국어타이틀 D=APM H=번역(번역가) R=pivo_id
const WORKER_SHEET = "1lvHDrNCiBplWlfIdAgI2iYNPAFWGrHYlqxjjebnFpE8";  // A=이름 C=slack_id D=channel_id
const APM_SLACK = { "서주원": "U07E0QPL8MV", "정태영": "U05CE8HFA6B" };   // CC용 APM 이름→Slack ID
const OWNER_ID = "U04463JR4HH";        // 박재상(PM, 발송자) — cc 대상에서 제외

const trim = (s) => String(s ?? "").trim();
const norm = (s) => trim(s).replace(/[\s~～〜〰]/g, "").toLowerCase();

// 작품·회차·수정내용으로 리테이크 메시지 조립
export async function buildRetake({ work, episode, fix, channel = null }) {
  const w = await lookupWork(work);
  if (!w.found) return w.ambiguous ? { found: false, ambiguous: true, candidates: w.candidates } : { found: false, query: work };

  // 번역가 + APM (작업자 정보 탭)
  const info = await readRange(KP_SHEET, `${INFO_TAB}!A2:R300`);
  const irow = info.find((r) => norm(r[0]) === norm(w.koTitle) || (w.pivoId && trim(r[17]) === trim(w.pivoId)));
  const translator = irow ? trim(irow[7]) : null;
  const apmName = trim(irow?.[3] || w.apm || "").split(/[,\s/]+/).filter(Boolean).find((n) => APM_SLACK[n]) || null;
  const apmId = apmName ? APM_SLACK[apmName] : null;

  // 번역가 Slack ID·채널 (작업자 DB)
  const wdb = (await readRange(WORKER_SHEET, "작업자 DB!A:F")).slice(1);
  const wr = translator ? wdb.find((r) => norm(r[0]) === norm(translator)) : null;
  const trId = wr ? trim(wr[2]) : null;
  const trChannel = wr ? trim(wr[3]) : null;

  // 식자검수 에디터 URL (없으면 납품검수 폴백)
  let editor = null, editorKind = null;
  const fp = await findProject(work);
  const proj = (fp?.data || [])[0];
  if (proj?.uuid) {
    const jr = await projectJobs(proj.uuid, episode);
    const tasks = (jr?.data?.[0]?.오퍼레이션 || []).flatMap((o) => o.태스크 || []);
    const lastOf = (nm) => { const c = tasks.filter((t) => trim(t.오퍼레이션유형명) === nm); return c[c.length - 1]; };
    const sik = lastOf("식자검수"), dl = lastOf("납품검수");
    if (sik) { editor = `https://main.totus.pro/ko/editor?uuid=${sik.uuid}`; editorKind = "식자검수"; }
    else if (dl) { editor = `https://main.totus.pro/ko/editor?uuid=${dl.uuid}`; editorKind = "납품검수"; }
  }

  const jpTitle = w.fixTitle || w.jaTitle || w.koTitle;
  const body = (trM, apmM) => {
    const L = [];
    L.push(trM);
    L.push(`お世話になっております。cc ${apmM}`);
    L.push("クライアントからの修正依頼をご共有します。");
    L.push(` ・作品名：${jpTitle}`);
    L.push(` ・話数：第${episode}話`);
    L.push(` ・修正内容：${trim(fix)}`);
    L.push("");
    if (editor) L.push(`参考エディター：${editor}`);
    L.push("");
    L.push("今回の修正はこちらで対応しますが、今後はご注意いただけますと幸いです。");
    L.push("引き続きよろしくお願いします。");
    return L.join("\n");
  };
  const trMR = trId ? `<@${trId}>` : `@${translator || "번역가"}`;
  const apmMR = apmId ? `<@${apmId}>` : `@${apmName || "APM"}`;

  const target = channel || trChannel || trId;   // 번역가 채널 우선, 없으면 번역가 DM
  return {
    found: true,
    text: body(trMR, apmMR),
    previewText: body(`@${translator || "번역가"}`, `@${apmName || "APM"}`),
    target, targetKind: channel ? "지정채널" : trChannel ? "번역가 채널" : trId ? "번역가 DM" : null,
    koTitle: w.koTitle, jpTitle, episode, translator, apmName, editorKind,
    missing: { translator: !translator, trId: !trId, target: !target, apm: !apmId, editor: !editor },
  };
}
