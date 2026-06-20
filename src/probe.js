// SA 접근 실측 + 탭 구조 읽기 (read-only). botV2 SA JWT→Sheets API.
import fs from "node:fs";
import crypto from "node:crypto";

const BOTV2_ENV = "c:/Users/P-205/Desktop/slack-inquiry-botV2/.env";
const b64url = (b) => Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function loadSA() {
  const raw = fs.readFileSync(BOTV2_ENV, "utf8").match(/^GOOGLE_CREDENTIALS=(.*)$/m)?.[1];
  if (!raw) throw new Error("GOOGLE_CREDENTIALS 없음");
  return JSON.parse(raw.trim().replace(/^['"]|['"]$/g, ""));
}
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const sa = loadSA();
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`토큰 실패: ${j.error_description || j.error}`);
  return j.access_token;
}

const SHEETS = {
  "납품 시트": "1QWCtU1GnCT2BQZvuF_N-8MnpgiyqIDTcM0x6hdCi8mQ",
  "운영통합": "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA",
  "작업자 매핑": "1lvHDrNCiBplWlfIdAgI2iYNPAFWGrHYlqxjjebnFpE8",
  "고객사 스케줄": "12y4jtsPJbJg7HdO5AfzoJK85suLenmk_bpWw4mRH2RQ",
  "리테이크": "1PzuVxMCbsTXIVNrodEFgrh2E_zGPnPTGnkWLziDhSCg",
  "설정집 모달 ST": "1mjUrj81QQ6pAdHFsHuCrh4m6oLcleTwO6phZVxs1bJ4",
  "랜덤체크 검수": "1erBEp7tr2CMB6KfZpQqc3UyFOf0j7adXHxu2qTU_Q8w",
  "번역검수(신)": "1Nj6c-TBuAlH_B-HSwsbeCBAv1xUX2gE3wgptgIIIJc8",
  "번역검수(구)": "1S-uVQHqkiXFT9QOq7GO8RJHrz1xqb7Fw22sJZwB0grk",
};

const token = await getToken();
for (const [alias, id] of Object.entries(SHEETS)) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties(title,sheetId,gridProperties)`;
  try {
    const j = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
    if (j.error) { console.log(`❌ ${alias}: ${j.error.status} (${j.error.message.slice(0, 50)})`); continue; }
    const tabs = (j.sheets || []).map((s) => `${s.properties.title}[gid:${s.properties.sheetId}]`);
    console.log(`✅ ${alias}: ${tabs.length}탭 — ${tabs.join(", ")}`);
  } catch (e) { console.log(`⚠️ ${alias}: ${e.message}`); }
}
