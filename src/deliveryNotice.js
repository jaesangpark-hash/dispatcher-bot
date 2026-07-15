// Toon_Japan 납품스레드 초안 생성 — 재상 님이 다운로드 폴더에 두는 "M_D-M_D 납품시트.xlsx" 파일 기반.
// 각 날짜 탭 안에 [한일] 섹션 → [중일] 섹션이 순서대로 들어있고(마커 단독행 "중일"로 구분),
// Job name이 "1-20" 같은 범위 표기면 초도, 아니면 일반 회차. 실제 발송은 send_message로(게이트).
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const DOWNLOADS = "C:/Users/P-205/Downloads";
// 고정 멘션(재팬팀 운영 리소스 레지스트리 기준, 2026-06-15 확정)
const MENTION_IDS = ["U02BTD7TY48", "U04463JR4HH", "U02GPTNGZ5W", "U05CE8HFA6B", "U07E0QPL8MV"];

// 다운로드 폴더에서 "납품시트" 포함 xlsx 중 가장 최근 파일을 찾는다.
export function findLatestDeliveryExcel() {
  const files = fs.readdirSync(DOWNLOADS)
    .filter((f) => /납품시트.*\.xlsx$/i.test(f) || /\.xlsx$/i.test(f) && /납품/.test(f))
    .map((f) => ({ name: f, full: path.join(DOWNLOADS, f), mtime: fs.statSync(path.join(DOWNLOADS, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full || null;
}

// "2026-07-16" 또는 "7/16" 등 다양한 표기 → 엑셀 탭명("716") + 표시용 "7/16"
function resolveTab(dateStr) {
  const s = String(dateStr).trim();
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  let month, day;
  if (m) { month = +m[2]; day = +m[3]; }
  else { m = s.match(/(\d{1,2})\s*[/.]\s*(\d{1,2})/); if (m) { month = +m[1]; day = +m[2]; } }
  if (!month || !day) return null;
  return { tab: `${month}${String(day).padStart(2, "0")}`, md: `${month}/${day}` };
}

function splitRow(r, chodo, list) {
  const title = String(r?.[0] || "").trim();
  const job = String(r?.[3] || "").trim();
  if (!title || !job) return;
  if (/^\d+\s*-\s*\d+$/.test(job)) chodo.push(`${title}\t${job.replace(/\s*-\s*/, "-")}`);
  else list.push(`${title}\t${job}`);
}

// 엑셀 파일 + 날짜 → { md, tab, chodo, hanil, zhongyi } (못 찾으면 error 필드)
export function parseDeliveryNoticeTab(filePath, dateStr) {
  const resolved = resolveTab(dateStr);
  if (!resolved) return { error: `날짜를 못 읽음: '${dateStr}' (예: 2026-07-16 또는 7/16)` };
  const { tab, md } = resolved;
  if (!fs.existsSync(filePath)) return { error: `파일 없음: ${filePath}` };
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[tab];
  if (!sheet) return { error: `'${tab}'(${md}) 탭이 파일에 없음. 있는 탭: ${wb.SheetNames.join(", ")}` };

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
  const zhIdx = rows.findIndex((r) => r && r.length === 1 && String(r[0]).trim() === "중일");
  if (zhIdx < 0) return { error: `'${tab}'(${md}) 탭에서 [중일] 구분 행을 못 찾음 — 형식이 다른 파일일 수 있음` };

  const hanilRows = rows.slice(2, zhIdx);
  const zhongyiRows = rows.slice(zhIdx + 2);
  const chodo = [], hanil = [], zhongyi = [];
  for (const r of hanilRows) splitRow(r, chodo, hanil);
  for (const r of zhongyiRows) splitRow(r, chodo, zhongyi);
  return { md, tab, chodo, hanil, zhongyi };
}

// 파싱 결과 → 실제 발송 텍스트(Slack mrkdwn). send_message(target=재팬_공지, text=이거)로 넘긴다.
export function buildNoticeText(parsed) {
  const { md, chodo, hanil, zhongyi } = parsed;
  const mentions = MENTION_IDS.map((id) => `<@${id}>`).join(" ");
  const sec = (title, arr) => `[${title}]\n${arr.length ? arr.join("\n") : "(없음)"}`;
  return [
    `*[${md} Toon_Japan 납품스레드]*`,
    mentions,
    `안녕하세요, 금일 납품목록입니다.`,
    `납품 완료 목록은 취소선으로 표시하겠습니다.`,
    ``,
    sec("초도", chodo),
    ``,
    sec("한일", hanil),
    ``,
    sec("중일", zhongyi),
  ].join("\n");
}
