// ── KP 고객사 FB → 윤문 프롬프트 개선 제안 (주 1회, 월요일 오전) ──────────────────
// 배경: review-engine의 윤문(스타일) 레이어는 KP FB 전수분석으로 만든 규칙 뭉치다(prompts_customer_fb.py
//   STYLE_SYSTEM_KO/ZH). 지금까지는 "생각날 때 몇 달치 몰아서 재분석"이라 반영이 늦었고, 같은 분석을
//   반복해 토큰만 태웠다. 그래서 ①신규 코멘트만 ②주 1회 ③임계 넘는 패턴만 제안하는 잡으로 고정한다.
//   (재상 님 지정: 주 1회 월요일 오전 / 신규 코멘트만 / 제안 임계는 여유롭게, 2026-09-08)
//
// 왜 "신규만"인가: FB 496건(8~9월) 중 307건(62%)은 사유 없이 수정문만 적혀 있어 규칙 기반 분류가 안 되고
//   번역문↔수정문을 LLM으로 대조해야 유형이 나온다. 전량 재대조는 매주 수백 건이라 낭비 — comment_uuid로
//   이미 본 건을 빼면 주당 유입분(중일 60건 내외)만 남아 2~3콜로 끝난다.
//
// 판단 기준을 하드코딩 복사본으로 두지 않는 이유: 프롬프트는 계속 손대는 살아있는 문서다. 복사본을 두면
//   금방 어긋나 "이미 있는 규칙"을 또 제안한다. 그래서 라이브 프롬프트 원문을 엔진 GET /prompt-rules에서
//   읽어 그대로 대조시킨다. 채택하지 않기로 결정한 항목(효과음·캐릭터 말투/어미·개행·조사 は/が)도
//   그 파일 docstring ⑦에 근거와 함께 적혀 있어 같이 내려온다 → 반려 근거를 모델이 직접 읽는다.
//
// 이 모듈은 데이터 수집·분류·판정·본문 작성까지만 한다. 스케줄 게이트와 DM 발송은 app.js(checkKpFbWeekly).
// LLM은 인자로 받은 ask(=toollessQuery)를 쓴다 — app.js를 import하면 순환 참조가 되고, 스크립트에서
// import만 해도 라이브 봇이 재부팅되는 사고가 있었다(메모: app.js 테스트 스크립트 import 금지).
import { readFileSync, writeFileSync } from "node:fs";
import { readRange } from "./sheets.js";

const OPS_SHEET_ID = "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";   // 운영 통합 시트(KP 중일/KP 한일 탭)
// 기본은 중일만. 한일 윤문 프롬프트(STYLE_SYSTEM_KO)는 1-3화 AI검수에서 아직 실사용이 아니라, 켜면
// 안 쓰는 프롬프트 제안이 섞인다. 한일 봇이 붙으면 KPFB_TABS="KP 중일,KP 한일"로 늘리면 된다.
const TABS = (process.env.KPFB_TABS || "KP 중일").split(",").map((s) => s.trim()).filter(Boolean);
const STATE_PATH = "data/kp-fb-seen.json";
const LAST_PATH = "data/kp-fb-last.json";       // 직전 분석 원자료(디버깅용, 발송본과 별개)
const BOOTSTRAP_DAYS = Number(process.env.KPFB_BOOTSTRAP_DAYS ?? 7);   // 첫 실행에서 과거 전량을 분석하지 않도록
const MIN_ITEMS = Number(process.env.KPFB_MIN_ITEMS ?? 3);   // 임계: 3건 이상
const MIN_WORKS = Number(process.env.KPFB_MIN_WORKS ?? 2);   //       AND 2작품 이상 (여유롭게 — 재상 님 지정)
const BATCH = Number(process.env.KPFB_BATCH ?? 25);          // 1콜당 대조 건수(실측 haiku 25건 ≈ 70초)
// 분류는 고정 택소노미 라벨링이라 값싼 모델로 충분하다(실측: haiku 25건 73초·파싱 정상). 판정 단계는
// 라이브 프롬프트 전문을 읽고 반려/보강을 가려야 해서 기본 모델(sonnet)을 그대로 쓴다.
const CLASSIFY_MODEL = process.env.KPFB_CLASSIFY_MODEL || "claude-haiku-4-5-20251001";
const MAX_NEW = Number(process.env.KPFB_MAX_NEW ?? 400);     // 폭주 방어(시트 대량 재적재 등)
const SEEN_CAP = 6000;                                       // seen 목록 상한(오래된 것부터 버림)
const HEARTBEAT_WEEKS = Number(process.env.KPFB_HEARTBEAT_WEEKS ?? 4);   // 이 주 수만큼 조용하면 생존신고 1줄

// 분류 택소노미 — 집계 가능하게 고정 목록으로 받는다. 자유 서술로 받으면 같은 유형이 매주 다른 이름으로
// 쪼개져 임계를 절대 못 넘는다(8~9월 재분석에서 겪음).
const CATEGORIES = [
  "효과음", "말투·어미", "개행·말풍선", "조사", "어휘반복", "지시어·명사생략",
  "직역투·설명조", "축약·간결화", "주어·지칭", "문맥연결", "용어·설정집",
  "오역", "오탈자", "경어·호칭", "수치·고유명사", "기타",
];

const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const workOf = (project) => flat(project).replace(/^\[PV-\d+\]\s*\[[^\]]*\]\s*/, "").slice(0, 40);
const kstDay = (t) => new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);

export function loadKpFbState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { seen: [], lastRun: null, silentWeeks: 0 }; }
}
function saveKpFbState(st) {
  try { writeFileSync(STATE_PATH, JSON.stringify(st)); } catch (e) { console.error("[kpfb] 상태 저장 실패:", e?.message ?? e); }
}

// 시트 → 항목. 컬럼: A comment_created_date / C sub(번역문) / D comment_uuid / F comment(FB) / G tag / I project
async function readKpItems(tab) {
  const rows = await readRange(OPS_SHEET_ID, `${tab}!A2:M6000`);
  return (rows || []).map((r) => ({
    date: String(r[0] ?? "").slice(0, 10),
    ja: flat(r[2]),                     // 번역문(제출본)
    uuid: flat(r[3]),
    fb: flat(r[5]).replace(/^【KP-FB】\s*/, ""),
    tag: flat(r[6]),
    work: workOf(r[8]),
    lang: /한일/.test(tab) ? "ko" : "zh",
  })).filter((x) => x.uuid && x.fb);
}

// LLM 1: 번역문↔FB 대조로 유형 분류. FB에 사유가 없고 수정문만 있는 건(62%)이 이 단계의 핵심 대상.
async function classifyBatch(items, ask, label) {
  const list = items.map((x, i) => `${i + 1}. [${x.work}] 訳: ${x.ja.slice(0, 120)}\n   FB: ${x.fb.slice(0, 220)}`).join("\n");
  const prompt = `당신은 일본어 웹툰 번역 QA 분석자입니다. 고객사(픽코마) 담당자가 남긴 수정 요청 ${items.length}건을 유형화하세요.

주의: FB에 수정 이유가 안 적혀 있고 수정문만 있는 경우가 많습니다(전체의 60% 이상). 그때는 訳(제출 번역문)과
FB에 적힌 수정문을 직접 대조해서 "무엇이 어떻게 바뀌었는지"로 유형을 판단하세요. 추측이 안 되면 "기타".

유형(반드시 이 중 하나): ${CATEGORIES.join(" / ")}

각 건에 대해:
- category: 위 목록 중 하나
- generalizable: 작품·캐릭터 고유 설정을 몰라도 적용 가능한 일반 규칙으로 만들 수 있으면 true, 그 작품
  설정집·캐릭터 개성에 의존하면 false
- change: 무엇이 어떻게 바뀌었는지 한 줄(20자 내외, 한국어)

★출력 형식 엄수: 설명·사고과정 없이 JSON 배열만. 입력 순서·개수 그대로:
[{"n":1,"category":"...","generalizable":true,"change":"..."}]

=== 대상 ===
${list}`;
  const raw = (await ask(prompt, { label, model: CLASSIFY_MODEL })) || "";
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`분류 응답 파싱 실패: ${raw.slice(0, 120)}`);
  const arr = JSON.parse(m[0]);
  const out = [];
  for (const row of arr) {
    const it = items[Number(row?.n) - 1];
    if (!it) continue;
    out.push({ ...it, category: CATEGORIES.includes(row.category) ? row.category : "기타", generalizable: row.generalizable !== false, change: flat(row.change).slice(0, 60) });
  }
  return out;
}

// LLM 2: 임계를 넘은 클러스터를 라이브 프롬프트 원문과 대조 → 신규 제안 / 기존 규칙 커버 / 반려 판정.
async function judgeClusters(clusters, rules, ask) {
  const body = clusters.map((c, i) => {
    const ex = c.items.slice(0, 4).map((x) => `   · [${x.work}] 訳: ${x.ja.slice(0, 70)} → FB: ${x.fb.slice(0, 120)}`).join("\n");
    return `${i + 1}. ${c.category} — ${c.items.length}건 / ${c.works.length}작품 (${c.works.slice(0, 4).join(", ")})\n${ex}`;
  }).join("\n\n");
  const prompt = `당신은 웹툰 번역 검수 엔진의 프롬프트 관리자입니다. 아래는 지금 **라이브로 배포된** 윤문 제안 프롬프트 원문과,
이번 주 새로 들어온 고객사 FB에서 반복 관찰된 패턴입니다. 각 패턴이 프롬프트 수정을 필요로 하는지 판정하세요.

판정(verdict):
- "신규": 라이브 프롬프트에 해당 규칙이 없고, 일반화 가능하며, 추가하면 검수 품질이 올라간다
- "보강": 비슷한 규칙은 있으나 범위·예시가 이 사례를 못 덮는다 → 기존 항목을 어떻게 고칠지 제시
- "기존": 이미 충분히 커버된다 → 수정 불필요
- "반려": 프롬프트로 다루지 않기로 이미 결정된 영역이거나, 근거가 약해 반박당할 판정이다

★반드시 지킬 것:
- 아래 changelog(프롬프트 파일 docstring)에 "채택하지 않은 것"으로 명시된 영역(효과음, 캐릭터 말투·어미,
  개행 위치, 조사 は/が 뉘앙스)은 근거와 함께 배제 결정이 내려진 것이다 → "반려". 결정을 되집지 마라.
- "신규"·"보강"일 때 patch는 프롬프트에 그대로 붙여넣을 수 있는 실제 문구(한국어 규칙문 + 일본어 예시)여야 한다.
- 확신 없으면 "기존" 또는 "반려"로. 매주 도는 잡이므로 진짜 패턴이면 다음 주에 또 올라온다.

JSON 배열만 출력:
[{"n":1,"verdict":"신규|보강|기존|반려","target":"STYLE_SYSTEM_ZH의 어느 항목(신규면 '신규 h항' 등)","reason":"한국어 2문장 이내","patch":"실제 삽입/수정 문구(기존·반려면 빈 문자열)"}]

=== 라이브 프롬프트(윤문 ZH) ===
${rules.style_zh || "(조회 실패)"}

=== 프롬프트 changelog(채택/미채택 결정 이력) ===
${rules.changelog || "(조회 실패)"}

=== 이번 주 관찰 패턴 ===
${body}`;
  const raw = (await ask(prompt, { label: "KP FB 프롬프트 판정" })) || "";
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`판정 응답 파싱 실패: ${raw.slice(0, 120)}`);
  return JSON.parse(m[0]).map((v) => ({ ...v, cluster: clusters[Number(v?.n) - 1] })).filter((v) => v.cluster);
}

async function fetchPromptRules(base, apiKey) {
  const r = await fetch(`${base}/prompt-rules`, { headers: apiKey ? { "X-API-Key": apiKey } : {} });
  if (!r.ok) throw new Error(`GET /prompt-rules ${r.status}`);
  return r.json();
}

// 메인 — 신규 FB 수집 → 분류 → 임계 → 판정 → 발송 본문. 발송할 게 없으면 text=null.
// 상태(seen) 갱신은 분류까지 성공한 건만 반영한다(중간 실패 시 다음 주에 다시 본다).
export async function buildKpFbProposal({ ask, engineBase, apiKey, now = Date.now() } = {}) {
  const st = loadKpFbState();
  const seen = new Set(st.seen || []);
  const bootstrap = !st.lastRun;
  const cutoff = kstDay(now - BOOTSTRAP_DAYS * 86400000);

  let items = [];
  for (const tab of TABS) {
    try { items.push(...(await readKpItems(tab))); }
    catch (e) { console.error(`[kpfb] ${tab} 읽기 실패:`, e?.message ?? e); }
  }
  if (!items.length) return { text: null, reason: "FB 시트 읽기 실패", stats: null };

  // 첫 실행: 과거 전량이 "신규"로 보이므로 최근 BOOTSTRAP_DAYS만 분석하고 나머지는 본 것으로 처리.
  let fresh = items.filter((x) => !seen.has(x.uuid));
  if (bootstrap) {
    const old = fresh.filter((x) => x.date < cutoff);
    fresh = fresh.filter((x) => x.date >= cutoff);
    for (const x of old) seen.add(x.uuid);
    console.log(`[kpfb] 첫 실행 — 과거 ${old.length}건은 분석 없이 seen 처리, 최근 ${BOOTSTRAP_DAYS}일 ${fresh.length}건만 분석`);
  }
  if (fresh.length > MAX_NEW) {
    console.error(`[kpfb] 신규 ${fresh.length}건 — 상한 ${MAX_NEW} 초과, 최근분만 분석`);
    fresh = fresh.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, MAX_NEW);
  }

  const stats = {
    new: fresh.length,
    works: new Set(fresh.map((x) => x.work)).size,
    from: fresh.reduce((a, x) => (a && a < x.date ? a : x.date), ""),
    to: fresh.reduce((a, x) => (a > x.date ? a : x.date), ""),
  };
  if (!fresh.length) {
    st.lastRun = kstDay(now); st.silentWeeks = (st.silentWeeks || 0) + 1; st.seen = [...seen].slice(-SEEN_CAP); saveKpFbState(st);
    return { text: null, reason: "신규 FB 없음", stats };
  }

  // 분류
  const classified = [];
  for (let i = 0; i < fresh.length; i += BATCH) {
    const chunk = fresh.slice(i, i + BATCH);
    try { classified.push(...(await classifyBatch(chunk, ask, `KP FB 분류 ${i / BATCH + 1}`))); }
    catch (e) { console.error("[kpfb] 분류 실패(이 배치는 다음 주로 미룸):", e?.message ?? e); }
  }
  if (!classified.length) return { text: null, reason: "분류 전량 실패", stats };
  for (const x of classified) seen.add(x.uuid);   // 분류까지 성공한 건만 본 것으로 처리

  // 클러스터링 — 일반화 가능한 것만, 임계(건수·작품수) 통과분만 판정에 올린다.
  const byCat = new Map();
  for (const x of classified) {
    if (!x.generalizable) continue;
    if (!byCat.has(x.category)) byCat.set(x.category, []);
    byCat.get(x.category).push(x);
  }
  const clusters = [], nearMiss = [];
  for (const [category, arr] of byCat) {
    const works = [...new Set(arr.map((x) => x.work))];
    const c = { category, items: arr, works };
    if (arr.length >= MIN_ITEMS && works.length >= MIN_WORKS) clusters.push(c);
    else if (arr.length >= 2) nearMiss.push(c);
  }
  clusters.sort((a, b) => b.items.length - a.items.length);

  let verdicts = [];
  if (clusters.length) {
    try {
      const rules = await fetchPromptRules(engineBase, apiKey);
      verdicts = await judgeClusters(clusters, rules, ask);
    } catch (e) {
      console.error("[kpfb] 판정 단계 실패:", e?.message ?? e);
      st.lastRun = kstDay(now); st.seen = [...seen].slice(-SEEN_CAP); saveKpFbState(st);
      return { text: null, reason: `판정 실패: ${e?.message ?? e}`, stats };
    }
  }
  try {
    writeFileSync(LAST_PATH, JSON.stringify({
      at: new Date().toISOString(), stats,
      clusters: clusters.map((c) => ({ category: c.category, n: c.items.length, works: c.works })),
      verdicts: verdicts.map(({ cluster, ...v }) => v),
    }, null, 1));
  } catch { /* 무시 */ }

  const actionable = verdicts.filter((v) => v.verdict === "신규" || v.verdict === "보강");
  st.lastRun = kstDay(now);
  st.seen = [...seen].slice(-SEEN_CAP);
  st.silentWeeks = actionable.length ? 0 : (st.silentWeeks || 0) + 1;
  saveKpFbState(st);

  // 제안이 없으면 조용히(주간 "이상 없음" DM은 노이즈). 단 몇 주 연속 조용하면 생존신고 한 줄.
  if (!actionable.length) {
    if (st.silentWeeks >= HEARTBEAT_WEEKS) {
      st.silentWeeks = 0; saveKpFbState(st);
      return { text: `🧪 *KP FB 프롬프트 점검* — 최근 ${HEARTBEAT_WEEKS}주간 프롬프트를 고칠 만한 반복 패턴 없었어요.\n_최근 주 신규 FB ${stats.new}건 / ${stats.works}작품 · 임계 ${MIN_ITEMS}건·${MIN_WORKS}작품_`, reason: "생존신고", stats, verdicts };
    }
    return { text: null, reason: `제안 없음(클러스터 ${clusters.length}, 판정 ${verdicts.map((v) => v.verdict).join("/") || "-"})`, stats, verdicts };
  }

  const lines = [
    `🧪 *KP FB 주간 프롬프트 점검* — 제안 ${actionable.length}건`,
    `_신규 FB ${stats.new}건 / ${stats.works}작품 (${stats.from}~${stats.to}) · 분류 ${classified.length}건 · 임계 ${MIN_ITEMS}건·${MIN_WORKS}작품_`,
    "",
  ];
  for (const v of actionable) {
    const c = v.cluster;
    lines.push(`*${v.verdict === "신규" ? "신규 규칙" : "기존 규칙 보강"} — ${c.category}* (${c.items.length}건 / ${c.works.length}작품: ${c.works.slice(0, 3).join(", ")}${c.works.length > 3 ? " 외" : ""})`);
    lines.push(`· 대상: ${flat(v.target) || "STYLE_SYSTEM_ZH"}`);
    lines.push(`· 판단: ${flat(v.reason)}`);
    if (flat(v.patch)) lines.push("```" + String(v.patch).trim() + "```");
    lines.push(`· 근거: ${c.items.slice(0, 2).map((x) => `[${x.work}] ${x.change}`).join(" / ")}`);
    lines.push("");
  }
  const skipped = verdicts.filter((v) => v.verdict === "기존" || v.verdict === "반려");
  if (skipped.length) lines.push(`_수정 불필요: ${skipped.map((v) => `${v.cluster.category}(${v.verdict})`).join(", ")}_`);
  if (nearMiss.length) lines.push(`_임계 미달(관찰만): ${nearMiss.map((c) => `${c.category} ${c.items.length}건/${c.works.length}작품`).join(", ")}_`);
  lines.push("_반영하려면 말씀만 주세요 — prompts_customer_fb.py에 제가 적용하고 회귀 테스트까지 돌립니다._");
  return { text: lines.join("\n"), reason: "제안 발송", stats, verdicts };
}

// 드라이런 하네스용 내부 노출(운영 경로에선 안 씀) — 판정 단계만 따로 검증할 수 있게.
export { judgeClusters as _judgeClusters, fetchPromptRules as _fetchPromptRules };
