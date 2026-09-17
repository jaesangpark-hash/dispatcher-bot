// 작업자용 원본 파일 순서 정리 — 내부용(check_and_fix_file_order / runFileOrderCheck)과 완전히 분리된 별도 경로.
//
// 왜 따로 만드는가: 내부용은 번역개시 버튼 체인이 함께 쓰므로 여기에 작업자 분기를 끼우면 그 체인까지 영향을 받는다.
// 공유하는 것은 판정 로직(file-order.js의 순수 함수)과 TOTUS 클라이언트뿐이다.
//
// 설계(2026-09-17 재상 님 확정):
//   - 지정된 작업자 개인 채널에서만 동작. 채널이 곧 신원이다.
//   - 「順」「原本」 등이 섞여 원본 순서를 고쳐달라는 뉘앙스면 발동(고정 명령어 아님).
//   - 작품은 작업자가 말하지 않는다 → 배정 현황에서 그 작업자의 진행작을 찾고 TOTUS 태스크로 확인해 정한다.
//     (막으려는 장치가 아니라 작품을 특정하기 위한 조회다. 덤으로 남의 회차를 건드리는 사고도 막힌다.)
//   - 반영 전 반드시 확인 버튼. 작업자가 직접 누른다.
//   - 순서 반영 후 회차 확정(source-groups/complete)까지 한다.
//   - 실행 결과는 재상 님께 DM.
import { readRange } from "./sheets.js";
import { projectByPivo, projectJobs, episodeSourceGroups, reorderFiles, completeSourceGroups } from "./totus.js";
import { analyzeOrder, detectMissingPages } from "./file-order.js";

const OPS = "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";
const ASSIGN = "배정 현황";

// 대상 작업자(재상 님 지정). 채널 → 작업자. 늘리려면 여기에 추가한다.
export const WORKER_CHANNELS = {
  C056R2DBFT3: { name: "Yamamoto Yuka", email: "3yue3hao.yuka@gmail.com", uid: "U0565QMEJMC" },
  C06UA75SGRG: { name: "Emi Tamura", email: "etamura0807@gmail.com", uid: "U06U79R2A9K" },
  C058T0ZNSES: { name: "Tomomi Morishita", email: "pengmei.catspaw@gmail.com", uid: "U058K33BXST" },
  C09G7V2J352: { name: "Akiyama Miyu", email: "falling3goat8.5@gmail.com", uid: "U09GH1639J5" },
  C055T9SUV6W: { name: "Sasaki Kashimi", email: "kashiimitrans@gmail.com", uid: "U055T5YMK5H" },
  C05M8FXNYHJ: { name: "Den Yuka", email: "cj2017171@gmail.com", uid: "U05M633NB4J" },
};

const lc = (s) => String(s ?? "").trim().toLowerCase();

// ── 의도 판정 ─────────────────────────────────────────────
// 「順」「原本」계열 + 고쳐달라는 뜻이 함께 있으면 발동. 한국어·영어도 받는다.
const WORD_ORDER = /順番|順序|順|並び|ならび|順서|순서|order/i;
const WORD_SOURCE = /原本|原稿|ファイル|ページ|원본|파일|file|page/i;
const WORD_FIX = /直|なお|並べ|替え|整|修正|おかしい|違う|ちがう|ずれ|逆|お願い|ください|確認|고쳐|바꿔|정리|이상|틀|확인|fix|wrong/i;
export function detectIntent(text) {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  const hasOrder = WORD_ORDER.test(t);
  const hasSource = WORD_SOURCE.test(t);
  const hasFix = WORD_FIX.test(t);
  // 「順」 단독은 너무 넓다 — 원본/파일 계열과 같이 나오거나, 고쳐달라는 말이 함께 있어야 한다.
  return hasOrder && (hasSource || hasFix);
}

// 회차 추출: 「12話」「12화」「12」「1-3話」「1,2,3」
export function parseEpisodes(text) {
  const t = String(text ?? "");
  const out = new Set();
  // 범위: 12-14 / 12~14 / 12〜14 / 12～14 (전각 물결 포함)
  for (const m of t.matchAll(/(\d{1,4})\s*[-~〜～]\s*(\d{1,4})\s*(?:話|화|ep)?/gi)) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a <= b && b - a <= 30) for (let i = a; i <= b; i++) out.add(i);
  }
  // 쉼표 나열: 1,2,3話 / 1、2、3화 (마지막에만 単位가 붙는 경우가 많다)
  for (const m of t.matchAll(/((?:\d{1,4}\s*[,、]\s*)+\d{1,4})\s*(?:話|화|ep)?/gi)) {
    for (const n of m[1].split(/[,、]/)) { const v = Number(n.trim()); if (Number.isFinite(v)) out.add(v); }
  }
  for (const m of t.matchAll(/(\d{1,4})\s*(?:話|화|ep)/gi)) out.add(Number(m[1]));
  if (!out.size) for (const m of t.matchAll(/\b(\d{1,4})\b/g)) out.add(Number(m[1]));
  return [...out].filter((n) => n >= 0 && n <= 2000).sort((a, b) => a - b);
}

// ── 작품 특정 ─────────────────────────────────────────────
// 배정 현황에서 그 작업자가 들어간 행(번역·번역검수·식자·식번검·식자검수 어디든)을 모은다.
const ASSIGN_COLS = [7, 9, 11, 13, 15];   // H 번역 / J 번역검수 / L 식자 / N 식번검 / P 식자검수
export async function worksOfWorker(worker) {
  const rows = await readRange(OPS, `'${ASSIGN}'!A2:R`);
  const hits = [];
  for (const r of rows) {
    const pivo = String(r[17] ?? "").trim();
    if (!pivo) continue;
    const names = ASSIGN_COLS.map((c) => lc(r[c])).filter(Boolean);
    if (!names.some((n) => n === lc(worker.name))) continue;
    hits.push({ pivo, title: String(r[0] ?? "").trim(), state: String(r[1] ?? "").trim() });
  }
  return hits;
}

// 그 회차에 이 작업자의 태스크가 실제로 있는지 TOTUS로 확인(시트는 하루 1회 동기화라 최신이 아닐 수 있다).
export async function workerHasEpisode(projectUuid, episode, email) {
  const jl = (await projectJobs(projectUuid))?.data || [];
  for (const job of jl) {
    const m = String(job["JOB명"] || "").match(/^(\d+)[_\s]/);
    if (!m || Number(m[1]) !== Number(episode)) continue;
    for (const op of job["오퍼레이션"] || []) {
      for (const t of op["태스크"] || []) {
        if (t["상태"] === "DROP") continue;
        if (lc(t["작업자"]?.["이메일"]) === lc(email)) return true;
      }
    }
  }
  return false;
}

// ── 점검 ──────────────────────────────────────────────────
export async function inspectEpisodes(projectUuid, episodes) {
  const recs = [];
  for (const ep of episodes) {
    try {
      const json = await episodeSourceGroups(projectUuid, ep);
      const group = (json?.data || [])[0] || null;
      const fileList = group?.["파일목록"] || [];
      if (!group || !fileList.length) { recs.push({ episode: ep, status: "not_found" }); continue; }
      const files = fileList.map((f) => f["파일이름"]);
      const fileMap = {};
      for (const f of fileList) fileMap[f["파일이름"]] = f.id;
      const a = analyzeOrder(files);
      const missing = detectMissingPages(files);
      const status = a.complexGroups.length ? "complex_skip"
        : (a.simpleAmbiguousGroups.length ? "ambiguous"
          : (a.isDifferent ? "fix" : "clean"));
      recs.push({ episode: ep, status, groupId: group.id, files, sorted: a.sorted, fileMap, missing });
    } catch (e) {
      recs.push({ episode: ep, status: "error", error: String(e?.message ?? e).slice(0, 80) });
    }
  }
  return recs;
}

// ── 반영 ──────────────────────────────────────────────────
// 순서 반영 + 회차 확정. status==="fix" 인 회차만 손댄다.
export async function applyOrder(records) {
  const done = [], failed = [];
  for (const r of records.filter((x) => x.status === "fix")) {
    try {
      const sources = r.sorted.map((name, i) => ({ id: r.fileMap[name], order: i + 1 })).filter((s) => s.id != null);
      if (!sources.length) throw new Error("파일 id를 못 찾음");
      await reorderFiles(sources);
      await completeSourceGroups([r.groupId]);
      done.push(r.episode);
    } catch (e) {
      failed.push([r.episode, String(e?.message ?? e).slice(0, 80)]);
    }
  }
  return { done, failed };
}

// ── 메시지(일본어 — 작업자용) ──────────────────────────────
const epLabel = (n) => `${n}話`;

export function previewBlocks(batchId, rec) {
  const fix = rec.records.filter((r) => r.status === "fix");
  const clean = rec.records.filter((r) => r.status === "clean");
  const skip = rec.records.filter((r) => ["ambiguous", "complex_skip", "not_found", "error"].includes(r.status));
  const lines = [];
  lines.push(`*${rec.title}* の原本ファイル順を確認しました。`);
  if (fix.length) {
    lines.push("", `▼ 並べ替えが必要（${fix.length}話）`);
    for (const r of fix.slice(0, 10)) {
      lines.push(`・${epLabel(r.episode)}　${r.files.length}ファイル`);
      lines.push(`　現在: ${r.files.slice(0, 6).join(" → ")}${r.files.length > 6 ? " …" : ""}`);
      lines.push(`　修正後: ${r.sorted.slice(0, 6).join(" → ")}${r.sorted.length > 6 ? " …" : ""}`);
    }
    if (fix.length > 10) lines.push(`　…ほか ${fix.length - 10}話`);
  }
  if (clean.length) lines.push("", `▼ 問題なし（${clean.length}話）: ${clean.map((r) => epLabel(r.episode)).join(", ")}`);
  if (skip.length) {
    lines.push("", `▼ 自動判定できません（${skip.length}話） — 担当PMにご連絡ください`);
    for (const r of skip.slice(0, 6)) {
      const why = r.status === "ambiguous" ? "順番が一意に決まらない"
        : r.status === "complex_skip" ? "ファイル名の規則が複雑"
          : r.status === "not_found" ? "ファイルが見つからない" : `エラー: ${r.error || ""}`;
      lines.push(`・${epLabel(r.episode)} — ${why}`);
    }
  }
  const missing = rec.records.filter((r) => r.missing?.length);
  if (missing.length) {
    lines.push("", "▼ 抜けているページの可能性");
    for (const r of missing.slice(0, 6)) lines.push(`・${epLabel(r.episode)}: ${r.missing.join(", ")}`);
  }
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n").slice(0, 2900) } }];
  if (fix.length) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: `並べ替えを反映（${fix.length}話）` }, action_id: "wfo_confirm", value: batchId },
        { type: "button", text: { type: "plain_text", text: "キャンセル" }, action_id: "wfo_cancel", value: batchId },
      ],
    });
  } else {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "反映が必要な話数はありません。" }] });
  }
  return blocks;
}

export const GUIDE_TEXT = [
  "このチャンネルでは、担当作品の *原本ファイルの順番* の確認・並べ替えをお手伝いできます。",
  "",
  "例）『原本の順番がおかしいので直してください 12話』",
  "　　『12〜14話 ファイル順 確認お願いします』",
  "",
  "話数を必ず入れてください。詳しい使い方は『使い方』とお送りください。",
  "それ以外のご依頼は担当PMへお願いします。",
].join("\n");

// 「使い方」「説明」「ヘルプ」류 → 매뉴얼 전문
const WORD_HELP = /使い方|使いかた|つかいかた|説明|せつめい|ヘルプ|help|マニュアル|どうやって|方法|사용법|설명|도움말/i;
export const isHelpRequest = (text) => WORD_HELP.test(String(text ?? ""));

export const MANUAL_TEXT = [
  "*原本ファイル順チェック — 使い方*",
  "",
  "担当作品の原本ファイルが正しい順番に並んでいるかを確認し、必要なら並べ替えます。",
  "TOTUSのファイル管理画面を開かなくても、このチャンネルから依頼できます。",
  "",
  "*1. 依頼のしかた*",
  "話数を入れて、順番を直したい旨をお送りください。決まった書式はありません。",
  "・『原本の順番がおかしいので直してください 12話』",
  "・『12〜14話 ファイル順 確認お願いします』",
  "・『1,2,3話 原本の並び 確認』",
  "※ 話数が入っていないと作品・話数を特定できません。必ず入れてください。",
  "",
  "*2. 作品の指定は不要です*",
  "TOTUSの担当情報から自動で判定します。",
  "同じ話数で担当作品が複数ある場合のみ、作品名をお尋ねします。",
  "ご自身が担当していない話数は対象外です。",
  "",
  "*3. 確認画面が出ます（この時点では何も変わりません）*",
  "・並べ替えが必要な話数 — 現在の順番と修正後の順番を並べて表示します",
  "・問題のない話数",
  "・自動で判定できない話数 — ファイル名の規則が複雑、または順番が一意に決まらない場合",
  "・抜けているページの可能性",
  "",
  "*4. ボタンを押すと反映されます*",
  "『並べ替えを反映』を押すと、TOTUSのファイル順を更新し、その話数を確定処理まで行います。",
  "押さないかぎり何も変更されません。内容をご確認のうえ実行してください。",
  "",
  "*5. できないこと*",
  "・ファイル名の変更（順番のみ）",
  "・ファイルの追加・削除・差し替え",
  "・自動判定できない話数の強制並べ替え",
  "これらが必要な場合は担当PMにご連絡ください。",
  "",
  "*6. ご注意*",
  "反映後の取り消しは自動ではできません。確認画面の内容をご確認のうえ実行をお願いします。",
  "うまく動かない・結果がおかしいときは担当PMにご連絡ください。",
].join("\n");
