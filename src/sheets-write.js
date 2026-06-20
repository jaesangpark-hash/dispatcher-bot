// 시트 쓰기 (게이트 통과분만 호출됨). 쓰기 전용 스코프 토큰. botV2 SA.
// ⚠️ 이 모듈의 setCell은 반드시 사용자 확인(버튼) 후 commit 경로에서만 호출할 것.
import fs from "node:fs";
import crypto from "node:crypto";

const BOTV2_ENV = "c:/Users/P-205/Desktop/slack-inquiry-botV2/.env";

function loadSA() {
  let raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) raw = fs.readFileSync(BOTV2_ENV, "utf8").match(/^GOOGLE_CREDENTIALS=(.*)$/m)?.[1];
  if (!raw) throw new Error("GOOGLE_CREDENTIALS 없음");
  return JSON.parse(raw.trim().replace(/^['"]|['"]$/g, ""));
}
const b64url = (b) => Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

let _wtok = null;
async function getWriteToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_wtok && _wtok.exp > now + 60) return _wtok.token;
  const sa = loadSA();
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // 읽기와 별개로 쓰기 스코프(spreadsheets). 단 실제 쓰기는 시트 ACL이 편집자일 때만 성공(아니면 403).
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`토큰 실패: ${j.error_description || j.error}`);
  _wtok = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return _wtok.token;
}

// 단일 셀 쓰기. a1 예: "납품관리시트_Japan(중일 V5)!G123"
export async function setCell(sheetId, a1, value) {
  const token = await getWriteToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(a1)}?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[value]] }) });
  const j = await r.json();
  if (j.error) throw new Error(`쓰기 실패: ${j.error.message}`);
  return j;
}

// 단일 셀 읽기(커밋 직전 staleness 재확인용)
export async function getCell(sheetId, a1) {
  const token = await getWriteToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(a1)}`;
  const j = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (j.error) throw new Error(`읽기 실패: ${j.error.message}`);
  return j.values?.[0]?.[0] ?? "";
}
