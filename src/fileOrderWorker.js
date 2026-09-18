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
  // 「順」+「ください」 정도로는 안 된다(手順を確認してください 같은 평범한 말이 다 걸린다).
  // 원본·파일·페이지 계열이 반드시 같이 나와야 발동한다. 2026-09-18 오탐 제보 후 강화.
  return WORD_ORDER.test(t) && WORD_SOURCE.test(t);
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

// 작품명 매칭용 제목 인덱스: PIVO → [한국어·일본어·중국어·FIX 타이틀]
// 작업자는 일본어 제목으로 부르므로 한국어타이틀만 보면 못 맞춘다.
const DRIVE = "출판사 드라이브 링크";
export async function titleIndex() {
  const rows = await readRange(OPS, `'${DRIVE}'!A2:I`);
  const idx = {};
  for (const r of rows) {
    const pivo = String(r[8] ?? "").trim();
    if (!pivo) continue;
    idx[pivo] = [r[1], r[2], r[3], r[4]].map((x) => String(x ?? "").trim()).filter(Boolean);
  }
  return idx;
}

// 제목 비교용 정규화 — 공백·물결·괄호주석(（仮） 등)·기호를 떼고 본다.
export const normTitle = (s) => String(s ?? "")
  .replace(/[（(][^）)]*[）)]/g, "")
  .replace(/[\s~～〜〰・･:：!！?？'"“”‘’,，.。\-—–_[\]「」『』【】]/g, "")
  .toLowerCase();

// 본문에서 후보 작품을 고른다. 「」 안이 있으면 그것부터, 없으면 본문 전체에서 제목 포함 여부로.
export function pickByTitle(text, candidates, idx) {
  const t = String(text ?? "");
  if (!t.trim() || !candidates.length) return [];
  const quoted = [...t.matchAll(/[「『"]([^」』"]{2,60})[」』"]/g)].map((m) => m[1]);
  const probes = quoted.length ? quoted.concat([t]) : [t];
  for (const probe of probes) {
    const np = normTitle(probe);
    if (!np) continue;
    const hit = candidates.filter((c) => {
      const titles = [c.title, ...(idx[c.pivo] || [])].map(normTitle).filter((x) => x.length >= 2);
      return titles.some((x) => np.includes(x) || x.includes(np));
    });
    if (hit.length) return hit;
  }
  return [];
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
    lines.push("", `▼ 自動判定できません（${skip.length}話） — 『順番が違う』から手動で並べ替えできます`);
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
  const editable = editableRecords(rec);
  const els = [];
  if (fix.length) els.push({ type: "button", style: "primary", text: { type: "plain_text", text: `並べ替えを反映（${fix.length}話）` }, action_id: "wfo_confirm", value: batchId });
  // 자동 판정이 틀렸을 때 / 애매해서 건너뛴 회차를 작업자가 직접 고치는 입구.
  if (editable.length) els.push({ type: "button", text: { type: "plain_text", text: "順番が違う" }, action_id: "wfo_fix_open", value: batchId });
  if (els.length) {
    els.push({ type: "button", text: { type: "plain_text", text: "キャンセル" }, action_id: "wfo_cancel", value: batchId });
    blocks.push({ type: "actions", elements: els });
  } else {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "反映が必要な話数はありません。" }] });
  }
  return blocks;
}

export const GUIDE_TEXT = [
  "このチャンネルでは、担当作品の *原本ファイルの順番* の確認・並べ替えをお手伝いできます。",
  "",
  "ご依頼のときは *@툰식이 とメンション* してください。メンションのないメッセージには反応しません。",
  "例）『@툰식이 「アンデッド・スカージ」「12話」ファイル順がおかしい』",
  "",
  "作品名と話数の両方が必要です。詳しい使い方は『@툰식이 使い方』とお送りください。",
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
  "*@툰식이 とメンション* したうえで、「作品名」と「話数」を入れてお送りください。",
  "メンションのないメッセージには反応しませんので、普段の会話はそのまま続けていただけます。",
  "書式は厳密でなくて構いません。",
  "・『@툰식이 「アンデッド・スカージ」「12話」ファイル順がおかしい』",
  "・『@툰식이 「終末学院」「12〜14話」原本の順番を直してください』",
  "・『@툰식이 「終末学院」「1,2,3話」ファイルの並び 確認』",
  "※ 作品名・話数のどちらかが欠けていると特定できません。両方入れてください。",
  "※ 話数は「12話」「12〜14話」「1,2,3話」のいずれの書き方でも大丈夫です。",
  "",
  "*2. スレッドで依頼する場合*",
  "親メッセージに作品名が入っていれば、返信では話数だけで構いません。",
  "作品名が見つからないときはお尋ねします。ご自身が担当していない話数は対象外です。",
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
  "*5. 順番が違うとき — ご自身で並べ替えられます*",
  "『順番が違う』を押すと、現在の並び順が一覧で開きます。",
  "各行の右にある ⋯ から「上へ / 下へ / 先頭へ / 末尾へ」を選ぶと、その場で順番が入れ替わります。",
  "納得のいく並びになったら『この順番で反映』を押してください。",
  "自動判定できなかった話数も、ここからご自身で順番を決められます。",
  "上部の話数メニューで、続けて別の話数を直すこともできます。",
  "",
  "*6. できないこと*",
  "・ファイル名の変更（順番のみ）",
  "・ファイルの追加・削除・差し替え",
  "これらが必要な場合は担当PMにご連絡ください。",
  "",
  "*7. ご注意*",
  "反映後の取り消しは自動ではできません。確認画面の内容をご確認のうえ実行をお願いします。",
  "うまく動かない・結果がおかしいときは担当PMにご連絡ください。",
].join("\n");

// ── 순서 직접 수정 모달(2026-09-17 재상 님 요청) ─────────────────────────────
// Slack Block Kit에는 드래그 요소가 없다. 파일마다 ⋯ 메뉴를 달고, 누를 때마다
// views.update로 모달을 다시 그려서 "한 칸씩 미는" 체감으로 대신한다.
// 회차당 파일은 많아야 15개 남짓(재상 님 확인)이라 블록 한도는 문제되지 않는다.
export const MV_OPS = [["up", "↑ 上へ"], ["down", "↓ 下へ"], ["top", "⇧ 先頭へ"], ["bottom", "⇩ 末尾へ"]];

export function moveItem(arr, i, op) {
  const a = (arr || []).slice();
  if (!(i >= 0 && i < a.length)) return a;
  const [x] = a.splice(i, 1);
  const j = op === "up" ? Math.max(0, i - 1)
    : op === "down" ? Math.min(a.length, i + 1)
      : op === "top" ? 0 : a.length;
  a.splice(j, 0, x);
  return a;
}

// 손댈 수 있는 회차 — 파일 목록을 받아온 회차만(not_found·error는 제외).
export const editableRecords = (rec) => (rec?.records || []).filter((r) => Array.isArray(r.files) && r.files.length);

export function orderModalView(batchId, rec, episode, order) {
  const eps = editableRecords(rec).map((r) => r.episode);
  const opt = (n) => ({ text: { type: "plain_text", text: `${n}話` }, value: String(n) });
  const blocks = [];
  if (eps.length > 1) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*話数*" },
      accessory: { type: "static_select", action_id: "wfo_ep_pick", initial_option: opt(episode), options: eps.slice(0, 100).map(opt) },
    });
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${episode}話* — 上から順に並びます。右の ⋯ から移動してください。` } });
  blocks.push({ type: "divider" });
  (order || []).slice(0, 80).forEach((name, i) => {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `\`${String(i + 1).padStart(2, "0")}\`　${name}` },
      accessory: {
        type: "overflow",
        action_id: `wfo_mv_${i}`,
        options: MV_OPS.map(([op, label]) => ({ text: { type: "plain_text", text: label }, value: `${batchId}|${episode}|${i}|${op}` })),
      },
    });
  });
  return {
    type: "modal",
    callback_id: "wfo_order_submit",
    private_metadata: `${batchId}|${episode}`,
    title: { type: "plain_text", text: "ファイル順の修正" },
    submit: { type: "plain_text", text: "この順番で反映" },
    close: { type: "plain_text", text: "閉じる" },
    blocks,
  };
}

// 모달에서 확정한 순서를 그대로 반영 + 회차 확정.
export async function applyManualOrder(rec, episode, order) {
  const r = (rec?.records || []).find((x) => Number(x.episode) === Number(episode));
  if (!r) throw new Error("該当話数が見つかりません");
  const sources = (order || []).map((name, i) => ({ id: r.fileMap?.[name], order: i + 1 })).filter((s) => s.id != null);
  if (!sources.length || sources.length !== order.length) throw new Error("ファイルIDを取得できませんでした");
  await reorderFiles(sources);
  await completeSourceGroups([r.groupId]);
  return sources.length;
}

// 데모용 가짜 배치 — 동작을 보여드릴 때만. TOTUS에는 아무것도 쓰지 않는다(demo 플래그로 차단).
export function demoRecord(channel, ts) {
  const mk = (files) => { const m = {}; files.forEach((f, i) => { m[f] = i + 1; }); return m; };
  const cur12 = ["12话-1.psd", "12话-2.psd", "12话-10.psd", "12话-11.psd", "12话-3.psd", "12话-4.psd", "12话-5.psd", "12话-6.psd", "12话-7.psd", "12话-8.psd", "12话-9.psd", "12话-12.psd"];
  const fix12 = ["12话-1.psd", "12话-2.psd", "12话-3.psd", "12话-4.psd", "12话-5.psd", "12话-6.psd", "12话-7.psd", "12话-8.psd", "12话-9.psd", "12话-10.psd", "12话-11.psd", "12话-12.psd"];
  const cur13 = ["13话-1.psd", "13话-2.psd", "13话-3.psd", "13话-4.psd", "13话-5.psd", "13话-6.psd", "13话-6_2.psd", "13话-7.psd", "13话-8.psd", "13话-9.psd"];
  return {
    demo: true,
    worker: { name: "デモ", email: "" },
    title: "デモ作品（動作確認用）",
    pivo: "000000",
    uuid: "demo",
    records: [
      { episode: 12, status: "fix", groupId: 0, files: cur12, sorted: fix12, fileMap: mk(cur12), missing: [] },
      { episode: 13, status: "ambiguous", groupId: 0, files: cur13, sorted: cur13, fileMap: mk(cur13), missing: [] },
    ],
    channel, ts, at: Date.now(),
  };
}
