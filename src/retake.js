// 리테이크 피드백 메시지 작성 — 작품/회차/수정내용으로 번역가에게 보낼 일본어 메시지 조립(read-only).
// 정보원: lookupWork(（仮）일본어 타이틀·APM), 작업자 정보 탭(번역가), 작업자 DB(번역가 Slack ID·채널), TOTUS(회차별 식자검수 에디터).
// MASTER(출판사 드라이브 링크) 미매핑(예: 한일)이면 입력 작품명 그대로 폴백. 실제 발송은 app.js 게이트에서만.
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

// "121" / "121-123" / "121,122" → 정렬·중복제거 회차 배열(최대 50)
function parseEps(spec) {
  const out = new Set();
  for (const part of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*[-~〜]\s*(\d+)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; for (let i = a; i <= b && out.size < 50; i++) out.add(i); }
    else { const n = part.match(/\d+/); if (n) out.add(+n[0]); }
  }
  return [...out].sort((a, b) => a - b);
}
// [121] → 第121話, [121,122,123] → 第121〜123話, [121,123] → 第121話・第123話
function epLabel(eps) {
  if (eps.length === 1) return `第${eps[0]}話`;
  const consecutive = eps.every((e, i) => i === 0 || e === eps[i - 1] + 1);
  return consecutive ? `第${eps[0]}〜${eps[eps.length - 1]}話` : eps.map((e) => `第${e}話`).join("・");
}
// TOTUS 프로젝트명에서 일본어 제목 추출(한일용). 예 "[PRJ-..] [PV-..] [카카오픽코마] 기연독식 奇縁独占（仮）" → "奇縁独占（仮）"
// 대괄호 태그 제거 후, 순수 한글 토큰은 버리고 일본어(가나/한자) 포함 토큰만 남긴다. 없으면 정리된 전체.
function jpTitleFromProject(name) {
  if (!name) return null;
  const stripped = String(name).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  const jp = stripped.split(" ").filter((tok) => /[ぁ-んァ-ヶ一-龯]/.test(tok) && !/^[가-힣]+$/.test(tok));
  return (jp.length ? jp.join(" ") : stripped) || null;
}

// 작품·회차(들)·수정내용으로 리테이크 메시지 조립
export async function buildRetake({ work, episode, fix, channel = null }) {
  const w = await lookupWork(work);
  if (w.ambiguous) return { found: false, ambiguous: true, candidates: w.candidates };

  // MASTER 매핑 여부 — 미매핑(한일 등)이면 TOTUS로 보강
  const mapped = !!w.found;
  const koTitle = mapped ? w.koTitle : trim(work);
  const pivoId = mapped ? w.pivoId : null;
  const apmRaw = mapped ? w.apm : "";

  // 중일: 작업자 정보 탭에서 번역가·APM. 한일은 여기 없음(아래 TOTUS로 보강).
  const info = await readRange(KP_SHEET, `${INFO_TAB}!A2:R300`);
  const irow = info.find((r) => norm(r[0]) === norm(koTitle) || (pivoId && trim(r[17]) === trim(pivoId)));
  let translator = irow ? trim(irow[7]) : null;
  const apmName = trim(irow?.[3] || apmRaw || "").split(/[,\s/]+/).filter(Boolean).find((n) => APM_SLACK[n]) || null;
  const apmId = apmName ? APM_SLACK[apmName] : null;

  // TOTUS: 본문 작품명으로 프로젝트 조회 → 회차별 식자검수 에디터 + 일본어제목 + 번역 작업자 email
  const eps = parseEps(episode);
  const editors = [];   // { ep, url, kind }
  let transEmail = null, projName = null;
  const fp = await findProject(work);
  const proj = (fp?.data || [])[0];
  if (proj?.uuid) {
    projName = trim(proj.프로젝트);
    for (const ep of eps) {
      const jr = await projectJobs(proj.uuid, ep);
      const tasks = (jr?.data?.[0]?.오퍼레이션 || []).flatMap((o) => o.태스크 || []);
      if (!transEmail) { const tr = tasks.filter((t) => trim(t.오퍼레이션유형명) === "번역").pop(); transEmail = tr?.작업자?.이메일 ? trim(tr.작업자.이메일) : null; }
      const lastOf = (nm) => { const c = tasks.filter((t) => trim(t.오퍼레이션유형명) === nm); return c[c.length - 1]; };
      const sik = lastOf("식자검수"), sj = lastOf("식자"), dl = lastOf("납품검수");
      if (sik) editors.push({ ep, url: `https://main.totus.pro/ko/editor?uuid=${sik.uuid}`, kind: "식자검수" });
      else if (sj) editors.push({ ep, url: `https://main.totus.pro/ko/editor?uuid=${sj.uuid}`, kind: "식자" });
      else if (dl) editors.push({ ep, url: `https://main.totus.pro/ko/editor?uuid=${dl.uuid}`, kind: "납품검수" });
    }
  }
  const editorLines = editors.filter((e) => e.url);

  // 작품명: 중일=master 일본어가제(（仮）), 한일=TOTUS 프로젝트명의 일본어 제목(없으면 입력값)
  const jpTitle = mapped ? (w.jaTitle || w.fixTitle || w.koTitle) : (jpTitleFromProject(projName) || trim(work));

  // 번역가 Slack: 중일=작업자정보 이름→DB 이름매칭 / 한일=TOTUS 번역 email→DB email매칭(이름도 DB에서 보강)
  const wdb = (await readRange(WORKER_SHEET, "작업자 DB!A:F")).slice(1);
  let wr = translator ? wdb.find((r) => norm(r[0]) === norm(translator)) : null;
  if (!wr && transEmail) { wr = wdb.find((r) => norm(r[1]) === norm(transEmail)); if (wr && !translator) translator = trim(wr[0]); }
  const trId = wr ? trim(wr[2]) : null;
  const trChannel = wr ? trim(wr[3]) : null;

  // 헤더(멘션) 자동 고정, 본문만 편집 모달 대상. cc(APM)는 해석될 때만(한일은 보통 생략).
  const trMR = trId ? `<@${trId}>` : `@${translator || "번역가"}`;
  const ccReal = (apmId || apmName) ? ` cc ${apmId ? `<@${apmId}>` : `@${apmName}`}` : "";
  const ccPrev = (apmId || apmName) ? ` cc @${apmName || "APM"}` : "";
  const headerReal = `${trMR}${ccReal}\nお世話になっております。`;
  const headerPreview = `@${translator || "번역가"}${ccPrev}\nお世話になっております。`;
  const bodyLines = [
    "クライアントからの修正依頼をご共有します。",
    ` ・作品名：${jpTitle}`,
    ` ・話数：${epLabel(eps)}`,
    ` ・修正内容：${trim(fix)}`,
    "",
  ];
  if (editorLines.length === 1) {
    bodyLines.push(`参考エディター：${editorLines[0].url}`, "");
  } else if (editorLines.length > 1) {
    bodyLines.push("参考エディター：");
    for (const e of editorLines) bodyLines.push(` 第${e.ep}話：${e.url}`);
    bodyLines.push("");
  }
  bodyLines.push("今回の修正はこちらで対応しますが、今後はご注意いただけますと幸いです。", "引き続きよろしくお願いします。");
  const body = bodyLines.join("\n");

  const target = channel || trChannel || trId;   // 번역가 채널 우선, 없으면 번역가 DM
  // 화수별로 식자검수/식자/납품검수가 섞일 수 있어 종류별로 나눠 표시(예 "식자검수 1/2화, 식자 1/2화") — 몇 화가 어떤 종류로 잡혔는지 한눈에 보이게.
  const kindCounts = {};
  for (const e of editorLines) kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1;
  const editorKind = editorLines.length
    ? Object.entries(kindCounts).map(([k, c]) => `${k} ${c}/${eps.length}화`).join(", ")
    : "없음";
  return {
    found: true,
    headerReal, headerPreview, body,
    target, targetKind: channel ? "지정채널" : trChannel ? "번역가 채널" : trId ? "번역가 DM" : null,
    koTitle, jpTitle, episodes: eps, epText: epLabel(eps), translator, trId, apmName, apmId, editorKind, mapped,
    missing: { mapped: !mapped, translator: !translator, trId: !trId, target: !target, apm: !apmId, editor: !editorLines.length },
  };
}
