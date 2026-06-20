// 납품 시트 조회 (read-only). botV2 SA로 JWT→Sheets API. 토큰 1시간 캐시.
import fs from "node:fs";
import crypto from "node:crypto";
import { resolveTitleAliases } from "./works.js";

const BOTV2_ENV = "c:/Users/P-205/Desktop/slack-inquiry-botV2/.env";
const SHEET_ID = "1QWCtU1GnCT2BQZvuF_N-8MnpgiyqIDTcM0x6hdCi8mQ";
const TABS = {
  "zh-ja": "납품관리시트_Japan(중일 V5)!A:G",
  "ko-ja": "납품관리시트_Japan(한일 V5)!A:G",
};

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

const norm = (s) => String(s || "").replace(/[\s~～〜〰]/g, "");

// 납품 시트 컬럼: B=작품명 C=PM D=APM E=회차 G=납품일
export async function lookupDelivery({ work, episode = "latest", lang = "zh-ja" }) {
  const range = TABS[lang] || TABS["zh-ja"];
  const token = await getToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const val = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (val.error) throw new Error(`시트 읽기 실패: ${val.error.message}`);
  const rows = val.values || [];
  const mapped = rows.map((r) => ({ name: r[1], pm: r[2], apm: r[3], ep: parseInt(r[4]), date: r[6] }));
  const match = (needles) => {
    const ns = needles.map(norm).filter(Boolean);
    return mapped.filter((r) => { const b = norm(r.name); return b && !isNaN(r.ep) && ns.some((n) => b.includes(n) || n.includes(b)); });
  };

  let hits = match([work]);
  let resolvedVia = null;
  if (!hits.length) {
    // JP/KO/FIX 혼재 대응: 마스터(출판사 드라이브 링크)로 정규화해 작품의 모든 제목으로 재검색
    const al = await resolveTitleAliases(work).catch(() => null);
    if (al && al.aliases.length) {
      hits = match(al.aliases);
      if (hits.length) resolvedVia = `'${work}' → ${al.koTitle || al.aliases[0]} (PIVO ${al.pivoId}) 정규화 후 매칭`;
    }
  }
  if (!hits.length) return { found: false, work, lang };
  const sorted = hits.sort((a, b) => a.ep - b.ep);
  const pick = (episode === "latest" || episode == null) ? sorted[sorted.length - 1] : sorted.find((r) => r.ep === parseInt(episode));
  return {
    found: true, work: sorted[0].name, lang, pm: sorted[0].pm, apm: sorted[0].apm,
    episodeRange: `${sorted[0].ep}~${sorted[sorted.length - 1].ep}화 (${hits.length}건)`,
    episode: pick ? pick.ep : null,
    deliveryDate: pick ? pick.date : null,
    resolvedVia,
    note: pick ? null : `${episode}화 없음. 보유 회차: ${sorted.map((r) => r.ep).join(",")}`,
  };
}
