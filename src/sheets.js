// 공용 구글시트 리더 (read-only). botV2 SA로 JWT→Sheets API. 토큰 1시간 캐시.
// 모든 데이터 조회 도구가 이걸 재사용한다.
import fs from "node:fs";
import crypto from "node:crypto";

const BOTV2_ENV = "c:/Users/P-205/Desktop/slack-inquiry-botV2/.env";

function loadSA() {
  let raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) raw = fs.readFileSync(BOTV2_ENV, "utf8").match(/^GOOGLE_CREDENTIALS=(.*)$/m)?.[1];
  if (!raw) throw new Error("GOOGLE_CREDENTIALS 없음 (dispatcher .env 또는 botV2 .env)");
  return JSON.parse(raw.trim().replace(/^['"]|['"]$/g, ""));
}

const b64url = (b) => Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

let _tok = null; // { token, exp }
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

// 시트 값 2차원 배열 반환. range 예: "탭이름!A:I"
export async function readRange(sheetId, range) {
  const token = await getToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const val = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (val.error) throw new Error(`시트 읽기 실패: ${val.error.message}`);
  return val.values || [];
}

// 스프레드시트 메타(제목·탭 목록) 조회 — 접근 가능 여부 확인 겸용
export async function getMeta(sheetId) {
  const token = await getToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties.title,sheets.properties.title`;
  const j = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (j.error) return { ok: false, error: j.error.message };
  return { ok: true, title: j.properties?.title, tabs: (j.sheets || []).map((s) => s.properties.title) };
}

// 작품명 정규화 (공백·물결표 제거)
export const norm = (s) => String(s || "").replace(/[\s~～〜〰]/g, "");
