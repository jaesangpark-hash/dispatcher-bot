// reviewFollowup.js — 번역검수 AI 검수(v1) 결과 발송 후 팔로우업 (dispatcher-bot용)
// tick()에서 주기 호출됨. n8n [Toon Japan]번역검수 완료 — AI 검수(1-3화) WF가
// "중일 1-3화 번역검수 트래킹" 시트에 남긴 행(followupStatus=대기)을 이어받아:
//   1) v1 작업자 채널 스레드에 일본어 안내 답글
//   2) 48시간 동안 3~6시간 간격으로 스레드 댓글 트래킹
//   3) 작업자 댓글 발견 시 → 같은 번역검수 오퍼레이션의 v2(다음 버전) 작업자 채널로 릴레이
//   4) 48시간 무응답 시 만료 처리 + PM DM 알림

import fs from "node:fs";
import crypto from "node:crypto";

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

const BASE            = () => get("PLATFORM_API_URL");
const TOKEN           = () => get("PLATFORM_API_TOKEN");
const REVIEW_BOT_TOKEN = () => get("REVIEW_BOT_TOKEN");
const WORKER_SHEET_ID  = () => get("WORKER_SHEET_ID");
const WORKER_SHEET_RANGE = () => get("WORKER_SHEET_RANGE") || "작업자 DB!A:F";
const TRACK_SHEET_ID   = () => get("TOTALK_HISTORY_SHEET_ID");
const TRACK_TAB        = () => get("REVIEW_TRACK_TAB") || "중일 1-3화 번역검수 트래킹";
const PM_SLACK_ID      = () => process.env.DISPATCHER_USER_ID || get("PM_SLACK_ID") || "U04463JR4HH";

const EXPIRE_MS  = 48 * 3600 * 1000;          // 무응답 만료 기준
const CHECK_EVERY_MS = 3 * 3600 * 1000;       // 트래킹 체크 주기(3~6시간 중 하한으로 고정, tick 자체는 더 촘촘히 불려도 내부에서 스킵)

const PROMPT_JA = "上記の指摘事項をご確認いただき、修正が必要な箇所はこちらのスレッドにコメントで残してください。";

// ── Google Sheets JWT(쓰기 스코프) ───────────────────────
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

// ── 트래킹 시트 컬럼: A~T (고정) ──────────────────────────
const COLS = ["pivoId","workTitle","episode","deadline","status","registeredAt","completedAt","taskUuid","rowKey","ok","channel","message","message_timestamp","projectUuid","skip","alertedAt","followupStatus","followupComment","followupRelayedAt","japaneseTitle"];
const IDX = Object.fromEntries(COLS.map((c, i) => [c, i]));

async function loadTrackingRows() {
  const tok = await getWriteToken();
  const range = encodeURIComponent(`${TRACK_TAB()}!A2:T2000`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${TRACK_SHEET_ID()}/values/${range}`;
  const j = await (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json();
  if (j.error) throw new Error(`트래킹 시트 읽기 실패: ${j.error.message}`);
  return (j.values || []).map((row, i) => ({ sheetRow: i + 2, get: (col) => row[IDX[col]] || "" }));
}

async function patchTrackingRow(sheetRow, patch) {
  const tok = await getWriteToken();
  const values = [["followupStatus", "followupComment", "followupRelayedAt", "japaneseTitle"].map((c) => patch[c] !== undefined ? patch[c] : "")];
  // 기존 값 보존 위해 followupComment/japaneseTitle 등 미지정 필드는 호출측에서 항상 세 값 다 채워 넘길 것
  const range = encodeURIComponent(`${TRACK_TAB()}!Q${sheetRow}:T${sheetRow}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${TRACK_SHEET_ID()}/values/${range}?valueInputOption=USER_ENTERED`;
  await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
}

// ── 작업자 DB(이메일→채널) ────────────────────────────────
let _workerCache = { map: new Map(), at: 0 };
async function loadWorkerMap() {
  if (Date.now() - _workerCache.at < 5 * 60 * 1000 && _workerCache.map.size) return _workerCache.map;
  const tok = await getWriteToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${WORKER_SHEET_ID()}/values/${encodeURIComponent(WORKER_SHEET_RANGE())}`;
  const j = await (await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })).json();
  if (j.error) throw new Error(`작업자 시트 읽기 실패: ${j.error.message}`);
  const map = new Map();
  for (const row of (j.values || []).slice(1)) {
    const email = (row[1] || "").trim().toLowerCase();
    if (email) map.set(email, { name: row[0]?.trim() || "", slackId: row[2]?.trim() || "", channelId: row[3]?.trim() || "" });
  }
  _workerCache = { map, at: Date.now() };
  return map;
}

// ── TOTUS: 같은 오퍼레이션의 v1 다음 버전(v2) 작업자 이메일 ──
async function resolveNextVersionWorkerEmail(projectUuid, taskUuid) {
  const res = await fetch(`${BASE()}/api/v1/projects/${projectUuid}/jobs`, { headers: { Authorization: `Bearer ${TOKEN()}` } });
  const json = await res.json();
  if (!json.success) { console.error("[reviewFollowup] jobs 조회 실패:", JSON.stringify(json).slice(0, 200)); return null; }
  for (const job of (json.data || [])) {
    for (const op of (job.오퍼레이션 || [])) {
      const tasks = op.태스크 || [];
      if (!tasks.some((t) => t.uuid === taskUuid)) continue;
      const sorted = [...tasks].sort((a, b) => new Date(a.시작일원본 || 0) - new Date(b.시작일원본 || 0));
      const pos = sorted.findIndex((t) => t.uuid === taskUuid);
      const next = sorted[pos + 1];
      return next?.작업자?.이메일 || null;
    }
  }
  console.warn(`[reviewFollowup] taskUuid(${taskUuid}) 소속 오퍼레이션 못 찾음`);
  return null;
}

// ── Slack: REVIEW_BOT_TOKEN으로 직접 호출(초도 검수 봇 identity) ──
async function reviewBotCall(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REVIEW_BOT_TOKEN()}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fetchThreadReplies(channel, ts) {
  const url = `https://slack.com/api/conversations.replies?${new URLSearchParams({ channel, ts, limit: "200" })}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${REVIEW_BOT_TOKEN()}` } });
  return res.json();
}

// ── 메인 처리 ──────────────────────────────────────────────
let _lastRunAt = 0;

export async function tickReviewFollowup(slackClient) {
  if (!REVIEW_BOT_TOKEN()) return;   // 토큰 미설정이면 조용히 스킵
  const now = Date.now();
  if (now - _lastRunAt < CHECK_EVERY_MS) return;
  _lastRunAt = now;

  try {
    const rows = await loadTrackingRows();
    for (const row of rows) {
      const status = row.get("followupStatus");
      if (!status || status === "완료" || status === "만료") continue;

      const messageTs = row.get("message_timestamp");
      const channel    = row.get("channel");
      if (!messageTs || !channel) continue;   // n8n이 아직 안 채운 행

      const anchorMs = parseFloat(messageTs) * 1000;
      const ageMs = now - anchorMs;

      if (status === "대기") {
        // 1) 일본어 안내 답글
        const r = await reviewBotCall("chat.postMessage", { channel, thread_ts: messageTs, text: PROMPT_JA });
        if (!r.ok) { console.error("[reviewFollowup] 안내 발송 실패:", r.error); continue; }
        await patchTrackingRow(row.sheetRow, { followupStatus: "안내완료", followupComment: "", followupRelayedAt: "", japaneseTitle: row.get("japaneseTitle") });
        console.log(`[reviewFollowup] 안내 발송: ${row.get("workTitle")} (${channel})`);
        continue;
      }

      if (status === "안내완료") {
        if (ageMs > EXPIRE_MS) {
          // 4) 만료 + PM 알림
          await patchTrackingRow(row.sheetRow, { followupStatus: "만료", followupComment: "", followupRelayedAt: "", japaneseTitle: row.get("japaneseTitle") });
          try {
            const dm = await slackClient.conversations.open({ users: PM_SLACK_ID() });
            const dmCh = dm.channel?.id;
            if (dmCh) await slackClient.chat.postMessage({ channel: dmCh, unfurl_links: false,
              text: `⚠️ <@${PM_SLACK_ID()}> AI검수 v1 무응답(48시간 경과) — ${row.get("workTitle")} / <#${channel}>` });
          } catch (e) { console.error("[reviewFollowup] PM 알림 실패:", e.message); }
          console.log(`[reviewFollowup] 만료: ${row.get("workTitle")}`);
          continue;
        }

        // 2) 스레드 댓글 확인
        const replies = await fetchThreadReplies(channel, messageTs);
        if (!replies.ok) { console.error("[reviewFollowup] replies 조회 실패:", replies.error); continue; }
        const humanMsgs = (replies.messages || []).filter((m) => m.ts !== messageTs && !m.bot_id);
        if (!humanMsgs.length) continue;   // 아직 댓글 없음, 다음 체크 때 재확인

        const combinedComment = humanMsgs.map((m) => m.text || "").filter(Boolean).join("\n");

        // 3) v2 작업자 찾아서 릴레이
        const projectUuid = row.get("projectUuid");
        const taskUuid    = row.get("taskUuid");
        const nextEmail   = projectUuid && taskUuid ? await resolveNextVersionWorkerEmail(projectUuid, taskUuid) : null;

        if (!nextEmail) {
          console.warn(`[reviewFollowup] v2 작업자 조회 실패 — ${row.get("workTitle")}`);
          try {
            const dm = await slackClient.conversations.open({ users: PM_SLACK_ID() });
            const dmCh = dm.channel?.id;
            if (dmCh) await slackClient.chat.postMessage({ channel: dmCh, unfurl_links: false,
              text: `⚠️ <@${PM_SLACK_ID()}> AI검수 v2 작업자 조회 실패 — ${row.get("workTitle")} (projectUuid=${projectUuid}, taskUuid=${taskUuid})\n작업자 댓글:\n${combinedComment}` });
          } catch (e) { console.error("[reviewFollowup] PM 알림 실패:", e.message); }
          await patchTrackingRow(row.sheetRow, { followupStatus: "만료", followupComment: combinedComment.slice(0, 500), followupRelayedAt: "", japaneseTitle: row.get("japaneseTitle") });
          continue;
        }

        const workerMap = await loadWorkerMap();
        const nextInfo = workerMap.get(nextEmail.toLowerCase());
        const japaneseTitle = row.get("japaneseTitle") || row.get("workTitle");
        const relayText = `📩 *${japaneseTitle}* 1-3話 修正内容を反映してください\n\n本文：\n${combinedComment}`;

        if (nextInfo?.channelId) {
          const r = await reviewBotCall("chat.postMessage", { channel: nextInfo.channelId, text: relayText });
          if (!r.ok) console.error("[reviewFollowup] v2 릴레이 발송 실패:", r.error);
        } else {
          try {
            const dm = await slackClient.conversations.open({ users: PM_SLACK_ID() });
            const dmCh = dm.channel?.id;
            if (dmCh) await slackClient.chat.postMessage({ channel: dmCh, unfurl_links: false,
              text: `⚠️ <@${PM_SLACK_ID()}> AI검수 v2 작업자(${nextEmail}) 채널 미등록 — ${row.get("workTitle")}\n${relayText}` });
          } catch (e) { console.error("[reviewFollowup] PM 알림 실패:", e.message); }
        }

        await patchTrackingRow(row.sheetRow, { followupStatus: "완료", followupComment: combinedComment.slice(0, 500), followupRelayedAt: new Date().toISOString(), japaneseTitle: row.get("japaneseTitle") });
        console.log(`[reviewFollowup] v2 릴레이 완료: ${row.get("workTitle")} → ${nextEmail}`);
      }
    }
  } catch (e) {
    console.error("[reviewFollowup] tick 오류:", e.message);
  }
}
