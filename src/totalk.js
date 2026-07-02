// totalk.js — TOTUS ToTalk 멘션 폴링 → 작업자 슬랙 채널 알림 (dispatcher-bot용)
// tick()에서 3분마다 호출됨 (매 3번째 tick)

import fs from "node:fs";
import crypto from "node:crypto";

// ── botV2 .env fallback 로드 ──────────────────────────────
const BOTV2_ENV = "c:/Users/P-205/Desktop/slack-inquiry-botV2/.env";
function loadBotV2Env() {
  const env = {};
  try {
    for (const line of fs.readFileSync(BOTV2_ENV, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const idx = t.indexOf("=");
      if (idx < 0) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  } catch {}
  return env;
}
const _bv2 = loadBotV2Env();
const get = (k) => process.env[k] || _bv2[k] || "";

const BASE              = () => get("PLATFORM_API_URL");
const TOKEN             = () => get("PLATFORM_API_TOKEN");
const WORKER_SHEET_ID   = () => get("WORKER_SHEET_ID");
const WORKER_SHEET_RANGE= () => get("WORKER_SHEET_RANGE") || "작업자 DB!A:F";
const HISTORY_SHEET_ID  = () => get("TOTALK_HISTORY_SHEET_ID");
const HISTORY_TAB       = () => get("TOTALK_HISTORY_TAB") || "토톡";
const PM_SLACK_ID       = () => process.env.DISPATCHER_USER_ID || get("PM_SLACK_ID") || "U04463JR4HH";
const TOTUS_EDITOR_BASE = "https://main.totus.pro/ko";
const BATCH_SIZE        = 50;

// ── Google Sheets JWT 토큰 (쓰기 스코프) ─────────────────
const b64url = (b) => Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
let _writeTok = null;
async function getWriteToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_writeTok && _writeTok.exp > now + 60) return _writeTok.token;
  const raw = get("GOOGLE_CREDENTIALS");
  if (!raw) throw new Error("GOOGLE_CREDENTIALS 없음");
  const sa   = JSON.parse(raw);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim= b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig  = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key));
  const r    = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  const j    = await r.json();
  if (!j.access_token) throw new Error(`쓰기 토큰 실패: ${j.error_description || j.error}`);
  _writeTok  = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return _writeTok.token;
}

// ── 읽기 전용 토큰 ────────────────────────────────────────
let _readTok = null;
async function getReadToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_readTok && _readTok.exp > now + 60) return _readTok.token;
  const raw = get("GOOGLE_CREDENTIALS");
  if (!raw) throw new Error("GOOGLE_CREDENTIALS 없음");
  const sa   = JSON.parse(raw);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim= b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig  = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key));
  const r    = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  const j    = await r.json();
  if (!j.access_token) throw new Error(`읽기 토큰 실패: ${j.error_description || j.error}`);
  _readTok   = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return _readTok.token;
}

// ── workers 시트 캐시 ────────────────────────────────────
let _sheetCache = { map: new Map(), at: 0 };
async function loadWorkerMap() {
  if (Date.now() - _sheetCache.at < 5 * 60 * 1000 && _sheetCache.map.size) return _sheetCache.map;
  const tok = await getReadToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${WORKER_SHEET_ID()}/values/${encodeURIComponent(WORKER_SHEET_RANGE())}`;
  const j   = await (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json();
  if (j.error) throw new Error(`workers 시트 읽기 실패: ${j.error.message}`);
  const map = new Map();
  for (const row of (j.values || []).slice(1)) {
    const email = (row[1] || "").trim().toLowerCase();
    if (email) map.set(email, { name: row[0]?.trim() || "", slackId: row[2]?.trim() || "", channelId: row[3]?.trim() || "" });
  }
  _sheetCache = { map, at: Date.now() };
  console.log(`[totalk] workers ${map.size}명 로드`);
  return map;
}

// ── 중일 작품 필터 + APM: 출판사 드라이브 링크(A열 APM · I열 PIVO) ──────
// 멘션 프로젝트명의 PV-숫자가 이 시트에 있으면 중일 작품(발송 대상). 담당 APM도 여기서.
// (개발팀이 mentions 응답에 프로젝트명 추가 → PIVO→uuid 변환 불필요, 시트 1회 읽기로 끝)
const JUNGIL_FILE = "data/jungil.json";
const PUB_SHEET_ID = "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";
const PUB_TAB = "출판사 드라이브 링크";
const PUB_APM_COL = 0;    // A열 = APM 이름
const PUB_PIVO_COL = 8;   // I열 = PIVO ID
const APM_SLACK = { "서주원": "U07E0QPL8MV", "정태영": "U05CE8HFA6B", "박재상": "U04463JR4HH" };   // APM 이름→Slack ID
let _jungil = null;       // { pivoApm: { "146958": "정태영", ... } }

function loadJungil() { try { const j = JSON.parse(fs.readFileSync(JUNGIL_FILE, "utf8")); return { pivoApm: j.pivoApm || {} }; } catch { return { pivoApm: {} }; } }
function saveJungil(c) { try { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync(JUNGIL_FILE, JSON.stringify({ builtAt: new Date().toISOString(), pivoApm: c.pivoApm })); } catch (e) { console.warn("[totalk] jungil 저장 실패:", e.message); } }

// 출판사 드라이브 링크에서 PIVO→APM 맵 갱신(TOTUS 호출 없이 시트 1회 읽기).
export async function refreshJungil() {
  const cache = { pivoApm: {} };
  try {
    const tok = await getReadToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${PUB_SHEET_ID}/values/${encodeURIComponent(PUB_TAB + "!A:I")}`;
    const j = await (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json();
    if (j.error) { console.error("[totalk] 출판사시트 읽기 실패:", j.error.message); return _jungil || loadJungil(); }
    for (const row of (j.values || []).slice(1)) {
      const p = String(row[PUB_PIVO_COL] || "").trim();
      if (/^\d{4,}$/.test(p)) cache.pivoApm[p] = String(row[PUB_APM_COL] || "").trim();
    }
    _jungil = cache; saveJungil(cache);
    console.log(`[totalk] 중일 캐시: ${Object.keys(cache.pivoApm).length} 작품(PIVO→APM)`);
  } catch (e) { console.error("[totalk] 중일 캐시 갱신 실패:", e.message); _jungil = _jungil || loadJungil(); }
  return _jungil;
}

function jungilMap() { if (!_jungil) _jungil = loadJungil(); return _jungil.pivoApm; }
// APM 이름 → @멘션 문자열(맵에 있으면 <@id>, 없으면 이름+님, 비면 '-')
function apmMention(name) { const n = String(name || "").trim(); if (!n) return "-"; return APM_SLACK[n] ? `<@${APM_SLACK[n]}>` : `${n} 님`; }

// ── 히스토리 시트 append ──────────────────────────────────
async function logToSheet(mention, workerName, workerEmail, sent, reason) {
  if (!HISTORY_SHEET_ID()) return;
  try {
    const tok  = await getWriteToken();
    const now  = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const raw  = mention.에디터링크?.[0];
    const link = raw ? (raw.startsWith("http") ? raw : TOTUS_EDITOR_BASE + raw) : "";
    const row  = [
      now,
      mention.작성자?.이름 || mention.작성자?.이메일 || "",
      mention.작성자?.이메일 || "",
      workerName,
      workerEmail,
      (mention.본문 || "").slice(0, 150),
      link,
      sent ? "Y" : "N",
      reason || "",
      mention.프로젝트UUID || "",
      mention.생성일시 || "",
    ];
    const range = encodeURIComponent(`${HISTORY_TAB()}!A:K`);
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${HISTORY_SHEET_ID()}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    });
  } catch (e) {
    console.warn("[totalk] 시트 기록 실패:", e.message);
  }
}

// ── 발송 ts 기록(오발송 회수용) ───────────────────────────
// logs/totalk-sent.jsonl 에 {at, email, name, channel, ts} 한 줄씩. 회수 시 이 파일로 chat.delete.
function logSent(email, name, channel, ts) {
  try { fs.appendFileSync("logs/totalk-sent.jsonl", JSON.stringify({ at: new Date().toISOString(), email, name, channel, ts }) + "\n"); }
  catch (e) { console.warn("[totalk] ts 기록 실패:", e.message); }
}

// ── 중복 차단: 이미 발송/처리한 코멘트UUID 집합(재기동에도 유지) ──────
const SEEN_FILE = "data/totalk-seen.json";
function loadSeen() { try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); } catch { return new Set(); } }
function saveSeen(set) { try { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-3000))); } catch (e) { console.warn("[totalk] seen 저장 실패:", e.message); } }

// ── since 커서(파일 영속) ────────────────────────────────
const SINCE_FILE = "data/totalk-since.json";
let _since = null;
function saveSince(iso) { try { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync(SINCE_FILE, JSON.stringify({ since: iso })); } catch {} }

// ── 폴링 1회 ─────────────────────────────────────────────
// opts.dryRun=true(기본): 발송/기록/커서이동 없이 새 멘션 목록만 반환(초안용).
// opts.dryRun=false: 실제 작업자 채널 발송 + ts 기록 + _since 이동.
export async function pollOnce(slackClient, opts = {}) {
  const dryRun = opts.dryRun !== false;   // 기본 안전: 발송 안 함
  try {
    const map    = await loadWorkerMap();
    const emails = [...map.keys()];
    if (!emails.length) { console.warn("[totalk] 이메일 없음"); return { dryRun, count: 0, items: [] }; }

    // 중일 작품 필터 준비(PIVO→APM 맵, 비어있으면 1회 빌드). 멘션 프로젝트명의 PV-숫자가 맵에 있으면 통과.
    let pmap = jungilMap();
    if (!Object.keys(pmap).length) { console.log("[totalk] 중일 캐시 비어있음 — 빌드"); await refreshJungil(); pmap = jungilMap(); }

    let sent = 0, unmapped = 0, skipped = 0, notJungil = 0;
    const items = [];   // 미리보기(초안)용 수집
    const seen = dryRun ? null : loadSeen();   // 발송 모드에서만 중복 차단

    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch  = emails.slice(i, i + BATCH_SIZE);
      const params = new URLSearchParams({ emails: batch.join(","), read: "false", size: "100" });
      if (_since) params.set("since", _since);

      const json = await (await fetch(`${BASE()}/api/v1/totalk/mentions?${params}`, {
        headers: { Authorization: `Bearer ${TOKEN()}` },
      })).json();

      if (!json.success) { console.error("[totalk] API 실패:", JSON.stringify(json).slice(0, 150)); continue; }

      for (const worker of (json.data || [])) {
        const email  = (worker.이메일 || "").toLowerCase();
        const name   = worker.이름 || email;
        const info   = map.get(email);

        for (const mention of (worker.멘션목록 || [])) {
          const pm = String(mention.프로젝트명 || "").match(/PV-(\d{4,})/);   // 프로젝트명의 PV-숫자
          const pivo = pm ? pm[1] : null;
          if (!pivo || !(pivo in pmap)) { notJungil++; continue; }   // 중일 작품만(출판사 드라이브 링크 시트 기준)
          const raw  = mention.에디터링크?.[0];
          const link = raw ? (raw.startsWith("http") ? raw : TOTUS_EDITOR_BASE + raw) : null;
          const who  = info?.slackId ? `<@${info.slackId}>` : name;   // 멘션 당한 작업자를 @ 멘션
          const title = String(mention.프로젝트명 || "").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();   // 작품명(대괄호 태그 제거)
          const apm = apmMention(pmap[pivo]);   // 담당 APM @멘션
          const body = String(mention.본문 || "").slice(0, 500);
          const text = [
            `📩 *Totalk 알림*`,
            `작품명 : ${title}`,
            `담당자 : ${apm}`,
            `본문 : ${who} ${body}`,
            `수신일시 : ${mention.생성일시 || ""}`,
            link ? `🔗 ${link}` : null,
          ].filter(Boolean).join("\n");

          items.push({ email, name, work: title, channel: info?.channelId || null, channelRegistered: !!info?.channelId, text });

          if (dryRun) continue;   // 초안 모드: 발송/기록 안 함

          const cid = mention.코멘트UUID;
          if (cid && seen.has(cid)) { skipped++; continue; }   // 이미 발송한 멘션 → 중복 차단
          if (cid) seen.add(cid);                              // 이번에 처리 표시(성공/실패 무관, 재발송 방지)

          if (!info?.channelId) {
            // 채널 미등록 → PM DM
            const dmRes = await slackClient.conversations.open({ users: PM_SLACK_ID() });
            const dmCh  = dmRes.channel?.id;
            if (dmCh) await slackClient.chat.postMessage({ channel: dmCh, unfurl_links: false,
              text: `⚠️ <@${PM_SLACK_ID()}> 토톡 멘션 미발송 — 작업자(${name} / ${email}) 채널 미등록\n\n${text}` });
            await logToSheet(mention, name, email, false, "채널미등록");
            unmapped++;
          } else {
            const res = await slackClient.chat.postMessage({ channel: info.channelId, text, unfurl_links: false })
              .catch(e => { console.error(`[totalk] 발송 실패(${email}):`, e.message); return null; });
            const ok = !!res?.ok;
            if (ok) logSent(email, name, info.channelId, res.ts);
            await logToSheet(mention, name, email, ok, ok ? "" : "발송오류");
            if (ok) sent++;
          }
        }
      }
    }

    if (dryRun) {
      console.log(`[totalk] 초안 조회 ${items.length}건 (중일 아님 제외 ${notJungil}, 발송 안 함)`);
      return { dryRun: true, count: items.length, notJungil, items };
    }
    saveSeen(seen);                          // 처리한 코멘트UUID 영속
    _since = new Date().toISOString();
    saveSince(_since);                       // 커서 영속(재기동에도 diff만)
    console.log(`[totalk] 발송 ${sent}건 / 미매핑 ${unmapped}건 / 중복스킵 ${skipped}건 / 중일아님 ${notJungil}건`);
    return { dryRun: false, sent, unmapped, skipped, notJungil, since: _since };
  } catch (e) {
    console.error("[totalk] 폴링 오류:", e.message);
    return { error: e.message };
  }
}

// ── register: tick()에서 3분마다 호출 ────────────────────
let _tickCount = 0;
export function tickTotalk(slackClient) {
  _tickCount++;
  if (_tickCount % 3 !== 0) return;   // 3분마다 (1분 tick 기준)
  pollOnce(slackClient).catch(e => console.error("[totalk] tick 오류:", e.message));
}

// ── since 초기화: 저장된 커서 복원(재기동에도 diff만), 없으면 오늘 KST 자정 ──
export function initSince() {
  try {
    const s = JSON.parse(fs.readFileSync(SINCE_FILE, "utf8"));
    if (s?.since) { _since = s.since; console.log(`[totalk] since 복원: ${_since}`); return; }
  } catch {}
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  _since = new Date(
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - 9 * 3600 * 1000
  ).toISOString();
  console.log(`[totalk] since 초기화(자정): ${_since}`);
}
