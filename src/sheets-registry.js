// 시트 명부(registry) + 범용 조회. botV2 SA로 read-only.
// 컬럼 매핑은 2026-06-16 라이브 헤더 실측 기준. 새 시트는 VIEWS에 항목 추가만.
import fs from "node:fs";
import crypto from "node:crypto";

const BOTV2_ENV = "c:/Users/P-205/Desktop/slack-inquiry-botV2/.env";
const b64url = (b) => Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
function loadSA() {
  const raw = process.env.GOOGLE_CREDENTIALS || fs.readFileSync(BOTV2_ENV, "utf8").match(/^GOOGLE_CREDENTIALS=(.*)$/m)?.[1];
  if (!raw) throw new Error("GOOGLE_CREDENTIALS 없음");
  return JSON.parse(raw.trim().replace(/^['"]|['"]$/g, ""));
}
let _tok = null;
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_tok && _tok.exp > now + 60) return _tok.token;
  const sa = loadSA();
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`토큰 실패: ${j.error_description || j.error}`);
  _tok = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return _tok.token;
}

// ── 시트 ID 명부 ─────────────────────────────────────────────────
const SHEETS = {
  delivery: "1QWCtU1GnCT2BQZvuF_N-8MnpgiyqIDTcM0x6hdCi8mQ",   // 납품·이관
  ops: "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA",        // 운영통합
  worker: "1lvHDrNCiBplWlfIdAgI2iYNPAFWGrHYlqxjjebnFpE8",     // 작업자 매핑
  retake: "1PzuVxMCbsTXIVNrodEFgrh2E_zGPnPTGnkWLziDhSCg",     // 리테이크
  schedule: "12y4jtsPJbJg7HdO5AfzoJK85suLenmk_bpWw4mRH2RQ",   // 고객사 스케줄
  kp_eval: "1jd9lOvHwCXqsSYE9vQbSqcbxO9B9sryD5_dWHJhlm4U",    // 중일 KP 평가표
};

// ── 조회 뷰 명부 ─────────────────────────────────────────────────
// cols: {필드명: 0-indexed 컬럼}. key: 작품명 매칭에 쓸 필드(들). desc: 봇 프롬프트용 설명.
export const VIEWS = {
  title_match: {
    sheet: "ops", range: "출판사 드라이브 링크!A:K", desc: "작품명→PIVO ID·타이틀·담당 APM (한국어·일본어가제·FIX일본어 어느 이름으로도 검색)",
    key: ["ko_title", "jp_title", "fix_title"],
    cols: { apm: 0, cn_title: 1, ko_title: 2, jp_title: 3, fix_title: 4, publisher: 6, drive: 7, pivo_id: 8 },
  },
  assignment: {
    sheet: "ops", range: "배정 현황!A:M", desc: "작품별 진행상태·작업자(번역/검수/식자) 배정 현황",
    key: ["ko_title"],
    cols: { ko_title: 0, status: 1, pm: 2, apm: 3, sl: 4, tl: 5, client: 6, translate: 7, translate_skip: 8, review: 9, review_skip: 10, typeset: 11, typeset_skip: 12 },
  },
  setjip_logo: {
    sheet: "ops", range: "설정집 로고 수급 현황!A:J", desc: "FIX 설정집·타이틀 로고 수급 여부, 런칭일·납품일",
    key: ["ko_title", "jp_title", "fix_title"],
    cols: { apm: 0, cn_title: 1, ko_title: 2, jp_title: 3, fix_title: 4, publisher: 5, fix_setjip: 6, title_logo: 7, launch_date: 8, delivery_date: 9 },
  },
  resupply: {
    sheet: "ops", range: "재수급봇!A:J", desc: "원고 재수급 요청 이력(요청자·작품·회차·사유·링크)",
    key: ["work", "fix_title"],
    cols: { requester: 0, apm: 1, work: 2, episode_page: 3, reason: 4, requested_at: 5, msg_link: 6, fix_title: 7, original: 8, publisher: 9 },
  },
  completed: {
    sheet: "ops", range: "완결작!A:H", desc: "완결 처리된 작품 목록",
    key: ["ko_title", "jp_title"],
    cols: { apm: 0, cn_title: 1, ko_title: 2, jp_title: 3, episodes: 4, drive: 5, publisher: 6, drive_link: 7 },
  },
  transfer: {
    sheet: "delivery", range: "이관요청시트_V3!A:M", desc: "프로젝트 이관 요청(고객사·예정일·수행자·완료여부)",
    key: ["project"],
    cols: { client: 0, project: 1, pm: 2, apm: 3, job: 4, order: 5, transfer_date: 6, performer: 7, note_pm: 8, note_cfm: 9, done: 10, confirmed: 11, memo: 12 },
  },
  delivery_zh: {
    sheet: "delivery", range: "납품관리시트_Japan(중일 V5)!A:G", desc: "중일 원고 납품 일정(작품·회차·납품일). 날짜로 '그날 납품 작품' 조회 = dateField:delivery_date",
    key: ["work"],
    cols: { work: 1, pm: 2, apm: 3, episode: 4, delivery_date: 6 },
  },
  delivery_ko: {
    sheet: "delivery", range: "납품관리시트_Japan(한일 V5)!A:G", desc: "한일 원고 납품 일정(작품·회차·납품일). 날짜로 조회 = dateField:delivery_date",
    key: ["work"],
    cols: { work: 1, pm: 2, apm: 3, episode: 4, delivery_date: 6 },
  },
  work_log_zh: {
    sheet: "kp_eval", range: "作業記録(中日)_2026!A4:M", desc: "중일 작업기록(회차별 KP평가 이력): 대응일·작품·작업구분·KP평가·번역가·검수자. 기간조회 dateField:date(対応日)",
    key: ["work", "work_id"],
    cols: { date: 0, work_id: 1, work: 2, expected: 3, work_type: 4, note_add: 5, kp_eval: 6, kp_memo: 7, memo: 8, translator: 9, lg: 10, qa_reviewer: 11, qa_reviewer_id: 12 },
  },
  worker_db: {
    sheet: "worker", range: "작업자 DB!A:F", desc: "작업자 이름·이메일→Slack User ID·채널 ID 매핑",
    key: ["name", "email"],
    cols: { name: 0, email: 1, slack_id: 2, channel_id: 3, totus_email: 4, no_weekend: 5 },
  },
  retake_zh: {
    sheet: "retake", range: "중일_사본(작업용)!A:N", desc: "중일 리테이크 현황(작품·회차·수정내용·완료여부)",
    key: ["work", "totus_work"],
    cols: { in_date: 0, pivo: 1, work: 2, totus_work: 3, ep_pm: 4, episode: 5, fix_src: 6, fix_trans: 7, url: 8, type: 9, langset: 10, pm: 11, apm: 12, done: 13 },
  },
  retake_ko: {
    sheet: "retake", range: "한일_사본(작업용)!A:N", desc: "한일 리테이크 현황(작품·회차·수정내용·완료여부)",
    key: ["work", "totus_work"],
    cols: { in_date: 0, pivo: 1, work: 2, totus_work: 3, ep_pm: 4, episode: 5, fix_src: 6, fix_trans: 7, url: 8, type: 9, langset: 10, pm: 11, apm: 12, done: 13 },
  },
  translator_grade: {
    sheet: "kp_eval", range: "번역가_등급표(수식)!A2:I", desc: "중일 번역가별 전체 KP 등급 분포(A~F 건수)·총계·합격률(A+B)",
    key: ["translator"],
    cols: { translator: 0, gradeA: 1, gradeB: 2, gradeC: 3, gradeD: 4, gradeE: 5, gradeF: 6, total: 7, pass_rate: 8 },
  },
  translator_grade_monthly: {
    sheet: "kp_eval", range: "번역가_등급표(수식)!K2:T", desc: "중일 번역가별 월간 KP 등급 분포·합격률. 월(yyyy-mm) 단위",
    key: ["translator"],
    cols: { translator: 0, month: 1, gradeA: 2, gradeB: 3, gradeC: 4, gradeD: 5, gradeE: 6, gradeF: 7, total: 8, pass_rate: 9 },
  },
};

const norm = (s) => String(s || "").replace(/[\s~～〜〰]/g, "").toLowerCase();
// 날짜 문자열 → "yyyy-mm-dd" (비교 가능). 못 읽으면 null. (yyyy-mm-dd는 문자열 비교=시간순)
function toISO(s) {
  if (!s) return null;
  // "2026-04-28" / "2026. 4. 28" / "2026.4.28" / "2026/4/28" 등 (점·슬래시·공백 혼용) 대응
  const m = String(s).match(/(\d{4})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : null;
}

// 뷰 읽기 → 행을 {필드명: 값} 객체로 매핑. needle 주면 key 컬럼에서 부분일치 필터.
// where: {field, op, value} — op ∈ empty|notEmpty|eq|neq|contains. 상태(done 등) 서버측 필터.
// dateRange: {field, from, to} — 날짜 컬럼 범위 필터(yyyy-mm-dd). distinct: [field,...] — 중복 제거 기준(예: 작품+회차).
export async function queryView(viewKey, { needle = null, limit = 20, where = null, dateRange = null, distinct = null } = {}) {
  const v = VIEWS[viewKey];
  if (!v) throw new Error(`알 수 없는 뷰: ${viewKey}. 가능: ${Object.keys(VIEWS).join(", ")}`);
  const token = await getToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS[v.sheet]}/values/${encodeURIComponent(v.range)}`;
  const j = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (j.error) throw new Error(`시트 읽기 실패: ${j.error.message}`);
  const rows = (j.values || []).slice(1); // 헤더 제거
  let objs = rows.map((r) => {
    const o = {};
    for (const [f, i] of Object.entries(v.cols)) o[f] = r[i] ?? "";
    return o;
  });
  objs = objs.filter((o) => Object.values(o).some((x) => String(x).trim())); // 빈 행 제거
  if (needle) {
    const n = norm(needle);
    objs = objs.filter((o) => v.key.some((k) => { const cell = norm(o[k]); return cell && (cell.includes(n) || n.includes(cell)); }));
  }
  if (where && where.field) {
    if (!(where.field in v.cols)) throw new Error(`뷰 ${viewKey}에 없는 필드: ${where.field}. 가능: ${Object.keys(v.cols).join(", ")}`);
    const op = where.op || "eq";
    const wv = norm(where.value ?? "");
    objs = objs.filter((o) => {
      const cell = String(o[where.field] ?? "").trim();
      const c = norm(cell);
      switch (op) {
        case "empty": return cell === "";
        case "notEmpty": return cell !== "";
        case "neq": return c !== wv;
        case "contains": return c.includes(wv);
        case "eq": default: return c === wv;
      }
    });
  }
  if (dateRange && dateRange.field) {
    if (!(dateRange.field in v.cols)) throw new Error(`뷰 ${viewKey}에 없는 필드: ${dateRange.field}. 가능: ${Object.keys(v.cols).join(", ")}`);
    const from = toISO(dateRange.from), to = toISO(dateRange.to);
    objs = objs.filter((o) => {
      const d = toISO(o[dateRange.field]);
      if (!d) return false;                 // 날짜 못 읽는 행은 범위 밖으로
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }
  if (distinct && distinct.length) {
    const seen = new Set(), out = [];
    for (const o of objs) {
      const k = distinct.map((f) => norm(o[f])).join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(o);
    }
    objs = out;
  }
  const matched = objs.length;
  return { view: viewKey, matched, returned: Math.min(matched, limit), rows: objs.slice(0, limit) };
}

// ── 범용 탭 조회 (VIEWS 미등록 탭도 탭명으로 직접) ───────────────────
const _tabsCache = {};
async function tabsOf(sheetId) {
  if (_tabsCache[sheetId]) return _tabsCache[sheetId];
  const token = await getToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`;
  const j = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  _tabsCache[sheetId] = j.error ? [] : (j.sheets || []).map((s) => s.properties.title);
  return _tabsCache[sheetId];
}

// 탭 이름으로 임의 탭 조회. 시트의 실제 헤더행을 필드명으로 사용. sheet 생략 시 알려진 시트에서 탭명 검색.
export async function readTab({ sheet = null, tab, headerRow = 1, where = null, dateRange = null, distinct = null, limit = 50 } = {}) {
  if (!tab) throw new Error("tab(탭 이름) 필요");
  const want = norm(tab);
  let sheetId = sheet && SHEETS[sheet] ? SHEETS[sheet] : null;
  let resolvedTab = tab;
  if (sheetId) {
    const tabs = await tabsOf(sheetId);
    resolvedTab = tabs.find((t) => norm(t) === want) || tabs.find((t) => norm(t).includes(want) || want.includes(norm(t))) || tab;
  } else {
    for (const id of Object.values(SHEETS)) {
      const tabs = await tabsOf(id);
      const hit = tabs.find((t) => norm(t) === want) || tabs.find((t) => norm(t).includes(want) || want.includes(norm(t)));
      if (hit) { sheetId = id; resolvedTab = hit; break; }
    }
    if (!sheetId) throw new Error(`탭 '${tab}'을 알려진 시트들에서 못 찾음`);
  }
  const token = await getToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(resolvedTab)}`;
  const j = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (j.error) throw new Error(`시트 읽기 실패: ${j.error.message}`);
  const values = j.values || [];
  const hi = Math.max(0, (headerRow | 0) - 1);
  const headers = values[hi] || [];
  const colOf = (f) => {
    const fn = norm(f);
    let i = headers.findIndex((h) => norm(h) === fn);
    if (i < 0) i = headers.findIndex((h) => { const hn = norm(h); return hn && (hn.includes(fn) || fn.includes(hn)); });
    return i;
  };
  let objs = values.slice(hi + 1).map((r) => { const o = {}; headers.forEach((h, i) => { if (h) o[h] = r[i] ?? ""; }); return o; })
    .filter((o) => Object.values(o).some((x) => String(x).trim()));
  if (where && where.field) {
    const i = colOf(where.field);
    if (i < 0) throw new Error(`헤더 '${where.field}' 없음. 헤더: ${headers.filter(Boolean).join(", ")}`);
    const hk = headers[i], op = where.op || "eq", wv = norm(where.value ?? "");
    objs = objs.filter((o) => { const cell = String(o[hk] ?? "").trim(), c = norm(cell); switch (op) { case "empty": return cell === ""; case "notEmpty": return cell !== ""; case "neq": return c !== wv; case "contains": return c.includes(wv); default: return c === wv; } });
  }
  if (dateRange && dateRange.field) {
    const i = colOf(dateRange.field);
    if (i < 0) throw new Error(`날짜 헤더 '${dateRange.field}' 없음. 헤더: ${headers.filter(Boolean).join(", ")}`);
    const hk = headers[i], from = toISO(dateRange.from), to = toISO(dateRange.to);
    objs = objs.filter((o) => { const d = toISO(o[hk]); if (!d) return false; if (from && d < from) return false; if (to && d > to) return false; return true; });
  }
  if (distinct && distinct.length) {
    const seen = new Set(), out = [];
    for (const o of objs) { const k = distinct.map((f) => { const i = colOf(f); return i >= 0 ? norm(o[headers[i]]) : ""; }).join("|"); if (seen.has(k)) continue; seen.add(k); out.push(o); }
    objs = out;
  }
  const alias = Object.keys(SHEETS).find((a) => SHEETS[a] === sheetId) || sheetId;
  return { sheet: alias, tab: resolvedTab, headerRow: hi + 1, headers: headers.filter(Boolean), matched: objs.length, returned: Math.min(objs.length, limit), rows: objs.slice(0, limit) };
}

export const VIEW_CATALOG = Object.entries(VIEWS).map(([k, v]) => `- ${k} (탭 "${v.range.split("!")[0]}"): ${v.desc} (필드: ${Object.keys(v.cols).join(", ")})`).join("\n");
