// 작업자 설정집 자가검수 — 작업자 개인 채널에서 「設定集チェック」로 직접 돌린다(2026-10-05).
// 기존 웹 툴(sekkei-interactive.html + n8n sekkei-web-check)은 인증번호·폴링·결과 소실이
// 불편하다는 의견이 있어 툰식이로 옮긴다. 결과는 설정집 xlsx에 직접 써서 돌려준다.
import { readWorkbookIndex, mapFindings, annotateSetjip } from "./setjipAnnotate.js";

// 열어줄 작업자 — fileOrderWorker.WORKER_CHANNELS 중 재상 님이 지정한 4명(2026-10-05)
export const SETJIP_CHANNELS = {
  C056R2DBFT3: { name: "Yamamoto Yuka", email: "3yue3hao.yuka@gmail.com" },
  C06UA75SGRG: { name: "Emi Tamura", email: "etamura0807@gmail.com" },
  C058T0ZNSES: { name: "Tomomi Morishita", email: "pengmei.catspaw@gmail.com" },
  C09G7V2J352: { name: "Akiyama Miyu", email: "falling3goat8.5@gmail.com" },
};

export const DAILY_LIMIT = Number(process.env.SETJIP_CHECK_DAILY_LIMIT || 3);

// ── 트리거 ────────────────────────────────────────────────────
// 「設定集チェック」가 들어있으면 발동. 멘션은 필요 없다(본인 채널이므로).
const TRIGGER = /設定集\s*(?:チェック|検収|レビュー)|설정집\s*(?:체크|검수)|setjip\s*check/i;
export const isSetjipRequest = (text) => TRIGGER.test(String(text || ""));

// ── 국가 설정 ─────────────────────────────────────────────────
// ★엔진의 자동 추론은 한국어 키워드 기반이라 일본어로 쓰면 전부 기본값(日本設定)으로 떨어진다.
//   여기서 확정해 setting_type 으로 넘긴다(2026-10-05 확인).
const SETTINGS = [
  [/中国\s*設定|중국\s*설정|中国設定|중국|ZH설정/i, "中国設定"],
  [/武侠|武俠|무협|古代中国/i, "武侠設定"],
  [/ヨーロッパ\s*設定|欧州|欧米|유럽|европ|europe/i, "ヨーロッパ設定"],
  [/多国籍|マルチ|다국적/i, "多国籍設定"],
  [/日本\s*設定|일본\s*설정|日本設定|일본|JP설정/i, "日本設定"],
];
export function parseSetting(text) {
  const t = String(text || "");
  for (const [re, label] of SETTINGS) if (re.test(t)) return label;
  return null;
}

// ── 작품명 ────────────────────────────────────────────────────
// 「」『』로 감싼 첫 덩어리를 우선, 없으면 트리거·국가설정을 걷어낸 나머지.
export function parseWork(text) {
  const t = String(text || "");
  const q = t.match(/[「『]([^」』]{2,60})[」』]/);
  if (q) {
    const inner = q[1].trim();
    if (!parseSetting(inner) && !TRIGGER.test(inner)) return inner;
    // 「作品名」「国家設定」 처럼 두 개를 따로 감싼 경우 — 설정이 아닌 쪽을 고른다
    for (const m of t.matchAll(/[「『]([^」』]{2,60})[」』]/g)) {
      const s = m[1].trim();
      if (!parseSetting(s) && !TRIGGER.test(s)) return s;
    }
  }
  const rest = t
    .replace(/<@[^>]+>/g, "")
    .replace(TRIGGER, " ")
    .replace(/中国設定|武侠設定|ヨーロッパ設定|多国籍設定|日本設定|중국\s*설정|일본\s*설정|유럽|다국적|무협/gi, " ")
    .replace(/[「『」』]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return rest.length >= 2 ? rest : null;
}

// ── 하루 횟수 ─────────────────────────────────────────────────
const kstDay = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
export function quotaCheck(store, channel) {
  const day = kstDay();
  const cur = store.get(channel);
  const used = cur && cur.day === day ? Number(cur.used || 0) : 0;
  return { day, used, left: Math.max(0, DAILY_LIMIT - used), ok: used < DAILY_LIMIT };
}
export function quotaUse(store, channel) {
  const { day, used } = quotaCheck(store, channel);
  store.set(channel, { day, used: used + 1, createdAt: Date.now() });
}

/**
 * 검수 실행 — 첨부 파일이 있으면 그걸, 없으면 작품명으로 TOTUS에서 받아 검수한다.
 * @returns {{buffer:Buffer, filename:string, reviews:Array, skipped:Array, settingType:string}}
 */
export async function runSetjipCheck({ engineBase, apiKey, workbook, filename, workTitle, settingType }) {
  const body = {
    work_title: workTitle || (filename || "").replace(/\.xlsx$/i, ""),
    setting_type: settingType,
    ...(workbook ? { workbook_b64: workbook.toString("base64"), workbook_filename: filename } : {}),
  };
  const r = await fetch(`${engineBase}/review-settings`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(900000),
  });
  const txt = await r.text();
  if (r.status !== 200) throw new Error(`검수 엔진 ${r.status}: ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt);
  const reviews = j.reviews || [];

  // 주석을 달 원본 — 첨부본이 없으면 엔진이 TOTUS에서 받은 것이라 우리 쪽엔 파일이 없다
  if (!workbook) return { buffer: null, filename: null, reviews, skipped: [], settingType, meta: j.metadata };

  const index = await readWorkbookIndex(workbook);
  const { findings, skipped } = mapFindings(index, reviews);
  const { buffer } = await annotateSetjip(workbook, findings);
  const out = `【AI検収】${String(filename || "設定集").replace(/^\d+[【\[].*?[】\]]/, "").replace(/\.xlsx$/i, "")}.xlsx`;
  return { buffer, filename: out, reviews, skipped, settingType, meta: j.metadata };
}

// ── 결과 안내문(일본어 — 작업자가 읽는다) ──────────────────────
export function resultText({ reviews, skipped, settingType, left }) {
  const sev = (s) => reviews.filter((v) => v.severity === s).length;
  const bySheet = {};
  for (const v of reviews) {
    const k = String(v.sheet || "").replace(/★.*$/, "").replace(/シート$/, "").trim();
    bySheet[k] = (bySheet[k] || 0) + 1;
  }
  if (!reviews.length) return `✅ 設定集チェック完了（${settingType}）— 指摘はありませんでした。\n本日の残り回数: ${left}回`;
  const lines = [
    `📋 設定集チェック完了（${settingType}）— 指摘 *${reviews.length}件*`,
    `内訳: ${Object.entries(bySheet).map(([k, n]) => `${k} ${n}`).join(" / ")}`,
    "",
    "添付ファイルの一番右 *「AI検収」列* に指摘を記載し、該当セルを *黄色* にしています。",
    "画像・書式は元のままです。",
  ];
  if (skipped?.length) lines.push(`\n※ ${skipped.length}件は該当セルを特定できなかったため、ファイルには反映されていません。`);
  lines.push(`\n本日の残り回数: ${left}回`);
  return lines.join("\n");
}
