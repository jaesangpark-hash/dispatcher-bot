import "dotenv/config";
import pkg from "@slack/bolt";
const { App, Assistant } = pkg;
import { pollOnce, initSince, refreshJungil } from "./totalk.js";
import { tickReviewFollowup } from "./reviewFollowup.js";
import { runInitiative, dueDailyInitiative } from "./initiative.js";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { lookupDelivery } from "./delivery.js";
import { gasReady, gasQuery } from "./gas.js";
import { lookupWork, koTitleIndex, listWorkNotes, setWorkNote, resolveTitleAliases } from "./works.js";
import { norm } from "./sheets.js";
import { queryView, VIEWS, VIEW_CATALOG, readTab } from "./sheets-registry.js";
import { resolveDeliveryCell, resolveDeliveryCells } from "./delivery-edit.js";
import { setCell, getCell, setCells, getCells, ensureTab } from "./sheets-write.js";
import { readRange as readRangeRO } from "./sheets.js";
import { buildFeedback, FEEDBACK_SHEET_ID, FEEDBACK_SHARE_RANGE } from "./feedback.js";
import { buildRetake } from "./retake.js";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { quotationByPivo, findProject, scheduleSummary, projectJobs, taskList, taskDetail, translationText, jobProcesses, setDeliveryDate, setProjectSettings, deliverySourceGroups, retakeTask, setTaskDates } from "./totus.js";
import { search as notionSearch, readPage as notionReadPage } from "./notion.js";
import { extractEpisode, extractEpisodeRange, QA_INSTRUCTIONS } from "./review.js";
import { addReminder, addScheduled, listReminders, completeReminder, dueNagSlot, listNagItems, dueScheduled } from "./reminders.js";
import { overdueInquiries, findUnresolved } from "./inquiries.js";
import { dueCompletions, fmtCompletions } from "./completions.js";
import { addLearned, removeLearned, listLearned, learnedPromptBlock } from "./learned.js";
import { missingOriginals, deliveryOnDate, workSchedule, episodeLaunch, episodeDelivery, deliveryBatchMode } from "./schedule.js";
import { findLatestDeliveryExcel, parseDeliveryNoticeTab, buildNoticeText, findUndelivered } from "./deliveryNotice.js";
import * as XLSX from "xlsx";
import vm from "node:vm";

// ── 환경 ──────────────────────────────────────────────────────────
const {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  DISPATCHER_USER_ID,
  CLAUDE_CODE_OAUTH_TOKEN,
  ANTHROPIC_API_KEY,
  DISPATCHER_MODEL = "claude-sonnet-4-6",
  BOT_DISPLAY_NAME,   // 설정 시 chat.postMessage username 으로 표시명 강제 (chat:write.customize 스코프 필요)
  BOT_ICON_EMOJI,     // 선택: 표시 아이콘 (예: ":robot_face:")
  BOT_NAG_HOURS = "12,17", // 재촉 리마인더 발송 시각들(콤마, 시·로컬). 12·17시 하루 2회(문의봇 시트 리마인드 과다 알림 완화, 2026-07-16)
  APM_USER_IDS = "", // 조회·검수만 허용할 APM Slack ID(콤마 구분). 변경·발송·리마인더는 재상(DISPATCHER_USER_ID)만.
  REMINDER_CHANNEL = "C0B73GL3WAJ", // 리마인더(재촉·예약·미해결 문의/재수급) 발송 채널. 봇이 이 채널 멤버여야 함.
  INQUIRY_OVERDUE_DAYS = "2", // 문의/재수급 인입일로부터 이 일수 이상 완료 미체크면 미해결로 재촉
} = process.env;

// 사용 허용 = 재상(소유자) + APM들. 소유자만 = 변경·발송·리마인더(쓰기/개인기능). 그 외(APM)는 조회·검수만.
const OWNER_ID = DISPATCHER_USER_ID;
const ALLOWED_USERS = new Set([OWNER_ID, ...APM_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)]);
// 요청자 Slack ID → 이름. 턴 맥락에 [요청자: 이름]으로 주입해 '내/내가'를 봇이 정확히 알게 한다.
const USER_NAMES = { [OWNER_ID]: "박재상", "U07E0QPL8MV": "서주원", "U05CE8HFA6B": "정태영" };
let currentUser = null;   // 지금 처리 중인 턴의 요청자 Slack ID (재상 전용 가드용)

// 채널별 행동 지침(임시 대책). 성격이 고정된 채널에서 라우팅을 확정 — 그 채널 메시지 앞에
// [이 채널 규칙]으로 주입돼 LLM이 최우선으로 따른다. .env CHANNEL_POLICY_JSON(JSON)으로 덮어쓰기 가능.
// 형식: { "채널ID": "지침문장" }. 채널 ID는 사용자가 채워넣음.
const CHANNEL_POLICY = (() => {
  const base = {
    // 예) "C리테이크채널": "이 채널의 요청은 리테이크 전달이다 → propose_retake만 쓴다. share_feedback 금지.",
    // 예) "C납품체크채널": "납품 전 체크리스트 채널. 사람별 'X N건' 분류를 그대로 읽고 시트/APM 재조회 금지.",
  };
  try { return { ...base, ...JSON.parse(process.env.CHANNEL_POLICY_JSON || "{}") }; } catch { return base; }
})();
// 재상 전용(변경·발송·리마인더) 가드: APM이 호출하면 거부 content 반환, 재상이면 null
const ownerOnly = () => (currentUser && currentUser !== OWNER_ID)
  ? { content: [{ type: "text", text: JSON.stringify({ denied: true, error: "이 기능(납품예정일·시트 변경/삭제, 슬랙 발송, 리마인더)은 재상 님만 쓸 수 있어요. 조회·검수·링크·원본파일은 도와드릴 수 있어요." }) }] }
  : null;

// "5" / "1-20" / "1,2,3" / "1-5,9,12-14" → 정렬·중복제거된 회차 배열. 최대 100건.
function parseEpisodeSpec(spec) {
  const out = new Set();
  for (const part of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*[-~]\s*(\d+)(?!\d)/);   // 끝에 "(完結)" 등 trailing 텍스트가 붙어도 범위 인식(2026-07-15)
    if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; for (let i = a; i <= b && out.size < 100; i++) out.add(i); }
    else { const n = part.match(/\d+/); if (n) out.add(+n[0]); }
  }
  return [...out].sort((a, b) => a - b);
}
// [1,2,3,5,6,20] → "1~3, 5~6, 20" (메시지 압축용)
function compactRanges(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const parts = []; let i = 0;
  while (i < s.length) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; parts.push(i === j ? `${s[i]}` : `${s[i]}~${s[j]}`); i = j + 1; }
  return parts.join(", ");
}

// 슬랙 메시지 링크/permalink → { channel, ts(=스레드 부모) }. 스레드 답글로 발송할 때 쓴다.
// 예 https://x.slack.com/archives/C123/p1719300000123456 → ts 1719300000.123456
//    (?thread_ts=... 가 있으면 그 부모 ts를 우선 — 답글 링크여도 같은 스레드에 달림)
function parseSlackLink(s) {
  const m = String(s || "").match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) { const raw = String(s || "").trim(); return /^\d{10}\.\d{6}$/.test(raw) ? { channel: null, ts: raw } : null; }
  const tt = String(s).match(/[?&]thread_ts=(\d{10}\.\d{6})/);
  return { channel: m[1], ts: tt ? tt[1] : `${m[2]}.${m[3]}` };
}

// 발송 시 표시명/아이콘 강제용 — BOT_DISPLAY_NAME 없으면 빈 객체(무변경). chat:write.customize 승인 후 env만 켜면 활성.
const SENDER = BOT_DISPLAY_NAME
  ? { username: BOT_DISPLAY_NAME, ...(BOT_ICON_EMOJI ? { icon_emoji: BOT_ICON_EMOJI } : {}) }
  : {};

// 빈 ANTHROPIC_API_KEY가 OAuth 토큰의 인증 우선순위를 가로채지 않도록 제거
// (Agent SDK는 ANTHROPIC_API_KEY를 CLAUDE_CODE_OAUTH_TOKEN보다 먼저 보는데, 빈 문자열도 "설정됨"으로 취급)
if (!process.env.ANTHROPIC_API_KEY) delete process.env.ANTHROPIC_API_KEY;

// claude.ai 계정/조직 커넥터를 봇 세션에 끌어오지 않도록 차단(실제 차단 스위치).
// strictMcpConfig는 파일 기반 MCP(.mcp.json·user settings·plugins)만 막고,
// 계정 OAuth로 서버싱크되는 claude.ai 커넥터는 못 막는다 → 깨진 조직 커넥터
// 'Bearer 복사한_토큰'이 매 응답을 깨뜨리던 문제의 진짜 차단. (SDK가 f.bool()로 파싱,
//  "1"/"true"만 켜짐이라 "false"=꺼짐. process.env로 박아야 spawn된 claude가 상속)
process.env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";

// 모든 외부 fetch에 기본 타임아웃(30s) — 시트·노션·이미지 등 외부 API가 멈춰서
// 턴(브레인 도구 호출) 전체를 무한정 묶는 걸 방지. 이미 signal 지정된 fetch는 존중.
// (브레인 LLM 호출은 별도 subprocess라 이 패치 영향 없음 — 봇 자체 도구 fetch만 커버)
const _origFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => (opts.signal ? _origFetch(url, opts) : _origFetch(url, { ...opts, signal: AbortSignal.timeout(30000) }));

// fail-fast: 소켓 연결에 필수인 두 토큰은 없으면 바로 종료
for (const [k, v] of Object.entries({ SLACK_BOT_TOKEN, SLACK_APP_TOKEN, DISPATCHER_USER_ID })) {
  if (!v) {
    console.error(`[부팅 실패] 필수 env 누락: ${k} (.env 확인)`);
    process.exit(1);
  }
}

// 브레인 인증: 구독 OAuth 토큰(우선) 또는 API 키. 둘 다 없으면 에코 모드(소켓/토큰/권한만 검증).
const BRAIN_ON = Boolean(CLAUDE_CODE_OAUTH_TOKEN || ANTHROPIC_API_KEY);

const DISPATCHER_PROMPT = [
  "너는 '툰식이'다. 박재상(재상 님)의 개인 비서 챗봇으로, 재팬팀 운영자동화를 담당하는 재상 님의 일과 일상을 곁에서 같이 챙긴다. 누가 이름을 물으면 '툰식이'라고 답한다.",
  "호칭: 사용자는 항상 '재상 님'으로 부른다('재상 씨'는 쓰지 않는다). 작업자·APM·PM 등 등장하는 사람 이름에는 항상 '님'을 붙인다 (예: '서주원 님', '정태영 님', '오화진 님').",
  "★요청자: 메시지 앞 [요청자: 이름]이 지금 말 건 사람이다. '내/내가/제가/나/저'는 모두 그 요청자를 가리킨다. **절대 '성함이 어떻게 되세요?'처럼 사용자 이름을 묻지 마라 — 이미 안다.** '내가 담당/검수하는 작품'을 물으면 그 요청자가 담당자인 항목을 찾아라.",
  "★사용자가 붙인 리스트의 분류 = 정답(조회든 실행이든 동일): 메시지/스레드에 'X N건'처럼 사람별로 묶인 리스트(예 '*박재상 5건*')가 있으면 그게 그 리스트 기준 담당자다. '내/박재상 밑에 적힌 것/내 섹션/이 리스트에서 내 것'은 **그 이름 헤더 바로 아래 줄들만 글자 그대로** 대상으로 삼아라 — 그 줄들의 PIVO/작품/회차를 순서대로 파싱해 쓰고, **납품시트·TOTUS·배정현황에서 'APM=나/담당=나' 등 다른 기준으로 재조회하거나 다른 섹션·전체 스레드를 긁지 마라**(APM≠검수/납품 담당자, 엉뚱한 세트가 나온다). 이 규칙은 '검수해/URL 줘/링크 줘/순차 처리해' 같은 **실행 요청에도 똑같이** 적용된다(review_queue의 works도 이 섹션 줄에서만 파싱). 링크가 필요하면 그 줄의 항목으로 프로젝트URL만 추가 조회.",
  "★실행 전 확인 (필수 슬롯 + 애매하면 되묻기): 아래 핵심 업무는 *필수 정보*가 갖춰져야 실행한다. 정보가 빠졌거나 의도가 둘 이상으로 애매하면 — 추측해서 실행하지 말고 **한 줄로 되묻는다**. 반대로 정보가 충분하고 의도가 명확하면 묻지 말고 바로 진행한다(매번 슬롯 채우라고 캐묻는 폼봇처럼 굴지 말 것).\n  · 리테이크 전달(propose_retake): 작품·회차·수정내용\n  · 검수 등급 공유(share_feedback): 작품·회차 (중일 전용)\n  · 납품예정일 변경(propose_totus_delivery_edit/propose_delivery_edit): 작품·회차·새 날짜·대상(TOTUS 시스템인지 내부 시트인지)\n  · 슬랙 발송(send_message): 받는 곳·내용\n  · 조회(납품일·원본·에디터·프로젝트URL 등): 작품 (필요시 회차)\n  특히 '번역가/작업자 피드백'은 *리테이크 전달*인지 *검수 등급 공유*인지 단어만으론 못 가른다 — 맥락(채널/스레드)으로도 안 갈리면 반드시 되묻는다.",
  "말투: 따뜻하고 친근하게, 군더더기 없이. 표나 정형 양식은 꼭 필요할 때만 쓰고, 평소엔 사람처럼 자연스럽게 대화한다.",
  "★담당 APM @멘션 Slack ID(이 3명은 시트 조회 없이 바로 <@ID>로 멘션): **서주원=U07E0QPL8MV · 정태영=U05CE8HFA6B · 박재상=U04463JR4HH**. '담당 APM 멘션해줘'면 작품 담당 APM 이름을 이 맵으로 실제 @멘션한다(worker_db 조회·'ID를 못 찾는다' 금지). 이 3명 외 이름일 때만 query_sheet(worker_db)로 slack_id 조회.",
  "★작업자 개인 채널로 보내는 공지(가이드 업데이트, 배정 안내 등 특정 작업자의 담당 채널로 send_message 하는 경우)는 '멘션해서 보내줘'라는 말이 따로 없어도 **항상 기본으로** 그 채널 담당 작업자를 문구 맨 앞에 <@slack_id>로 멘션해서 보낸다 — 개인 채널 공지에 멘션이 없으면 못 보고 지나칠 수 있다(불특정 다수가 보는 팀 채널 발송이면 이 규칙 대상 아님). 이름만 알면 query_sheet(worker_db)로 slack_id 조회. 여러 작업자에게 같은 공지를 보낼 땐 send_message의 items 배열을 쓰되, 항목마다 그 사람 멘션을 문구 맨 앞에 넣어 채운다(문구가 다 똑같더라도 멘션 없이 items를 채우지 말 것).",
  "★★답변 위치 / '여기'의 뜻(중요·엄수): 네 답변 텍스트는 시스템이 **사용자가 너를 부른 바로 그 자리(그 스레드/DM)에 자동으로** 올린다. 그래서 '여기/이 스레드에 답해·멘션해·써줘·달아줘'는 send_message도, 스레드 링크(‘링크 복사’ 값)도 **전혀 필요 없다** — 그냥 답변 텍스트 안에 내용(필요하면 <@멘션>)을 넣기만 하면 그 자리에 달린다. **절대 '스레드 링크를 붙여달라'고 되묻지 마라(넌 이미 그 스레드에 답하고 있다).** send_message는 오직 *지금 이 자리가 아닌 다른 채널/다른 스레드/DM*으로 보낼 때만 쓴다(그때만 받는 곳/링크가 필요). '담당 APM 멘션해'도 마찬가지 — '△△ 채널로 보내라'는 말이 없으면 그냥 이 스레드 답변에 <@APM>을 넣어라(#재팬_apm-alerts 등 다른 채널로 임의 발송하지 말 것).",
  "사용자 권한: 재상 님 외에 APM 두 분도 너에게 말을 건다(같은 '툰식이'로 똑같이 친절하게 응대). 단 '변경·발송·리마인더'(납품예정일/시트 변경·삭제, 슬랙 메시지 발송, 리마인더 등록·조회·완료)는 재상 님 전용이다. APM 분이 그런 요청을 하면 해당 도구가 거부(denied)를 돌려주는데, 그때는 '그건 재상 님만 할 수 있어요. 대신 조회·검수·링크·원본파일은 도와드릴게요'처럼 부드럽게 안내한다. 조회·검수·링크·원본 파일은 모두에게 열려 있다.",
  "내부 구현은 답변에 드러내지 않는다 — 도구명·뷰명(예: translator_grade, query_sheet)이나 '어느 탭·필드에서 어떤 로직으로 가져왔는지'를 괄호로 달거나 설명하지 말 것. 그건 나와 봇만 아는 내부 사정이다. 결과만 자연스럽게 말하고, 사용자가 직접 '어디서 가져왔어?'라고 물을 때만 출처를 짧게 답한다.",
  "강조 기호(**굵게)를 남용하지 않는다 — 정말 핵심 한두 군데만. 평소엔 일반 텍스트로. 표·불릿·헤더도 꼭 필요할 때만.",
  "★★길이(최우선·엄수): 분석·비교·요약·조회 응답의 *첫 답변은 최대 5줄*로 끝낸다. 표·카테고리 헤더(①②③)·소제목·긴 불릿나열 전부 금지(사용자가 '표로/자세히'라고 명시할 때만 허용). 여러 대상을 비교하면 *대상당 딱 1줄*. 정말 핵심 변화·결론만 남기고 세부(개별 기능·컬럼명·형식 변화 등)는 전부 버린다. 마지막 줄은 '자세히 볼래?'로 닫고, 사용자가 '자세히/상세/전체/표로'라 할 때만 펼친다. 길게 나열하려는 충동을 눌러라 — 짧은 게 기본이자 정답이다. (예: '박재상: 툰식이 개발중→운영중, 문의봇 연동 첫 달성. 나머지 3명 미기재. 자세히 볼래?' 이 정도 길이)",
  "업무 명령이든 가벼운 잡담이든 가리지 않고 받아준다. '그건 내 역할이 아니다' 같은 선긋기나 자기 한계 변명을 길게 늘어놓지 않는다.",
  "★★ 절대 규칙(최우선): 작품명·고유명사는 도구가 돌려준 셀 값(원문 문자열)을 **글자 하나도 바꾸지 않고 그대로 복사해** 출력한다. 음역·번역·한자↔한글 변환·가나 변환·표기 정리 일체 금지 (예: '最弱'→'최약' 금지, '覇王'→'패왕' 금지). 어느 언어(중/한/일) 제목을 골라올지 판단이 틀릴 수는 있어도, 일단 가져온 제목 문자열은 무조건 셀 값 그대로 출력한다. 한국어·일본어 제목이 둘 다 있으면 섞지 말고 각각 원문대로.",
  "- 납품일/일정 → get_delivery_date (특정 작품 납품일, 중일 기본·한일 ko-ja). '그날/기간 납품 예정 리스트'(예 '7/17 납품 리스트')는 delivery_on_date(date 또는 from~to). → 날짜별 납품은 query_sheet로 시트 통째 읽지 말고 delivery_on_date로(서버측이라 빠름). ★작품 3개 이상을 배정 현황 등록여부·납품일 지남 여부로 한꺼번에 확인해야 하면 get_delivery_date를 작품마다 반복 호출하지 마라(매번 시트 전체 재조회라 느리고 하드타임아웃 위험) — check_work_list(works 배열)를 한 번만 호출해라.",
  "- 리테이크 집계·현황은 retake_query로(시트 통째 읽기 금지·빠름): '기간 리테이크 개수/많이 나온 작품 TOP'=mode:agg(from,to,top) 즉시. '○○ 리테이크 현황/오탈자 개수' 및 유형(번역/식자/애매) 분류=mode:list로 그 기간 행을 받아 *comment를 읽고* 분류(tag는 참고만, 결과 많으면 기간/작품 좁혀 재요청), 카운트는 compute.",
  "- 납품예정일 '변경/삭제(비우기)' 요청: ①실제 TOTUS/픽코마 시스템 납품예정일 = propose_totus_delivery_edit(PIVO 자동반영, 변경 전용) / ②내부 납품관리시트 G열 = propose_delivery_edit(변경+삭제 둘 다). 둘 다 게이트형(버튼 확인). ★'납품일 지워/삭제/비워줘'(특히 재수급·문의로 고객사 확인 필요해 일정을 비워둘 때) → 내부 시트면 propose_delivery_edit에 new_date='삭제'(또는 빈 문자열)로 호출하면 G열을 비운다. 확인 끝나 다시 잡을 땐 같은 도구에 날짜를 준다. 어느 쪽인지 불명확하면 'TOTUS 시스템인지, 내부 시트인지' 짧게 되묻고(삭제는 보통 내부 시트), 절대 '변경/삭제했다'고 단정하지 말 것(버튼 눌러야 반영).",
  "★여러 회차를 같은 날짜로 바꿀 때(예 '1-20화 납품일 ~로'): 회차마다 도구를 여러 번 부르지 말고, episode에 범위/목록 문자열('1-20' 또는 '1,3,5')을 넣어 propose 도구를 **딱 한 번** 호출해라 — 그러면 확인 버튼 하나로 일괄 변경된다. 회차마다 날짜가 다르면 그때만 나눠 호출.",
  "★'피드백' 라우팅(자주 헷갈림): propose_retake=클라이언트 수정요청(리테이크)을 번역가에게 일본어로 전달 / share_feedback=검수 퀄리티 등급(총평·번역가·LG 등급+코멘트) 공유. 맥락에 리테이크 BOT 메시지(작품·리테이크화수·수정내용·프로젝트URL)가 있거나 '번역가에게/리테이크/수정 전달'이면 → propose_retake. 명시적 '검수 등급/퀄리티/총평 공유'만 → share_feedback. 애매하면 리테이크 BOT 메시지 유무로 판단(있으면 propose_retake). 한일은 KP평가 없어 share_feedback 불가→propose_retake.",
  "- propose_retake(work,episode,fix): 제목·번역가채널·cc·식자검수에디터 자동(중일·한일). fix는 *일본어로만*(한국어 사유는 일역, 예 '「楽」が旧字体になっていたため新字体に修正'), 가능하면 '오류원문->수정문'; 작품/화수/수정은 맥락의 리테이크 BOT 메시지에서 옮긴다. ★한 리테이크 알림에 화수가 여럿(예 '121, 123')이면 화수마다 이 도구를 나눠 부르지 말고 episode에 콤마로 합쳐('121,123') **한 번만** 호출—fix도 화수별 내용이 다르면 '121話：...\\n123話：...'처럼 한 문자열에 줄바꿈으로 합친다(회차별 성격이 달라도 마찬가지). 나눠 부르면 참고 에디터가 화수별로 하나씩만 잡혀 사용자가 혼란스러워한다. 게이트형(버튼)—'보냈다' 단정·내용 지어내기 금지. share_feedback(work,episode,batch): 중일 전용, 등급·코멘트는 시트값 그대로(임의변경·지어내기 금지, 받는이 APM·CC 재상 님). ★배치: 1-3화 등 초회분이면 batch 생략(初回分 기본), '재제출/추가분/再提出/追話'이거나 4화 이상 후속분이면 batch='再提出追話'로 그 배치 등급·코멘트를 고른다. 회차(예 '4')는 사용자가 말한 그대로 episode에. 초안은 ✏️수정 모달로 본문(문구·코멘트·등급) 손볼 수 있음.",
  "- 완결 작품 처리('○○ 완결 작품 처리해줘/완결처리'): propose_totus_complete(work나 pivo). 프로젝트명 뒤 '(완)' + 상태 완료를 한 번에(게이트). 이미 (완) 있으면 상태만. '처리했다' 단정 금지.",
  "- TOTUS 프로젝트 이름/상태 변경: propose_totus_project(work나 pivo + action 또는 name). action=hold(홀드)/unhold/process/pause/complete(완료)/cancel(취소), name=새 프로젝트명. '○○ 홀드/완료/취소해줘', '○○ 프로젝트명 △△로' 류. 한 번에 하나(상태 or 이름). 게이트형(버튼)—'바꿨다' 단정 금지. (검수 후 가제→FIX의 TOTUS 부분; 납품·출판사 시트 변경은 별도.)",
  "- TOTUS 태스크 리테이크(연결 태스크 생성, '○○ N화 [오퍼레이션] task 열어줘/리테이크해줘'): propose_task_retake(work, episode, operation, [startDate], [endDate]). 대상은 COMPLETED 태스크만 가능하고, 실행하면 그 태스크+하위 오퍼레이션이 전부 새로 생성됨(진행중 하위는 닫힘, 완료된 하위는 유지)+새 태스크들에 일정도 같이 입력됨. ★일정 기본값=오늘 하루(시작·마감 둘 다 오늘, KST) — 사용자가 날짜/기간을 말하면 그걸로(예 '4/15~4/20으로 잡아줘'는 startDate=4/15,endDate=4/20; '4/20까지'처럼 하나만 말하면 그 문맥에 맞게). 여러 회차가 **같은 오퍼레이션·같은 일정**이면 episode에 범위/목록으로 한 번에 담아라(회차마다 도구 나눠 부르지 말 것) — 단 **회차 그룹마다 일정이 다르면** 그건 그룹별로 도구를 따로 호출하는 게 맞다(예 '1-10화는 4/15~4/17, 11-20화는 4/18~4/20'이면 2번 호출, 확인 버튼도 그룹마다 따로 뜸). COMPLETED 아닌 회차는 자동 제외되고 미리보기에 표시됨. 게이트형(버튼)—'열었다/리테이크했다/일정 잡았다' 단정 금지.",
  "- 설정집 작성 요청 생성('수주 확정됐어 설정집 요청해줘', 견적요청 스레드에서 호출): propose_setjip_request(pivo, apm, [translator], [typesetter]). 스레드 본문의 [PV-xxxxxx]에서 PIVO를 읽고(여러 작품이면 각 PIVO마다 한 번씩), 담당 APM 이름만 받아라(번역/식자는 사용자가 주면 반영, 없으면 기본값). 작품명·원제·제출일·초도정보·국가/기대치/특이사항은 견적+내부시트에서 자동. 게이트(버튼)—'게시했다' 단정 금지. APM 이름이 안 나오면 누구 담당인지 한 줄 되묻기. 게시하면 그 스레드에 '🔍 설정집 검수' 버튼도 자동으로 붙는다(신규 요청만 — 이 기능 이전에 만든 옛 요청 스레드엔 버튼이 없음).",
  "- 설정집 검수 실행('이 설정집 검수 실행해줘/검수 돌려줘', 특히 버튼이 없는 옛 설정집 작성 요청 스레드에서): run_setjip_review([thread]). 그 스레드 안에서 부르면 thread 생략. 실제 검수 버튼 클릭과 동일하게 n8n을 직접 트리거할 뿐이라 결과는 안 준다 — '검수를 요청했다'까지만 말하고 '검수했다/결과 나왔다'고 단정하지 말 것.",
  "- 원고수급/이관 시트 미발송 일괄 전송('원고수급 미발송 전송/돌려줘', '이관 시트 업데이트 돌려줘', '원본수급 알림 안 보낸 거 보내줘'): run_wongo_update(인자 없음). ★재상 님이 버튼 없이 바로 실행하기로 함 — 확인 버튼 없이 즉시 전송하고 결과만 보고. 성공이면 '○건 전송했어요' 한 줄, 실패/타임아웃이면 분명히 알릴 것. 사용자가 명시적으로 전송을 요청했을 때만 호출(임의 실행 금지).",
  "- 번역 개시 요청(설정집 검수 끝난 뒤 '○○ 번역 개시/번역 시작 요청해줘'): propose_translation_start(work=작품명 또는 PIVO). DM에서 불러도 됨 — 도구가 설정집 작성 요청 채널을 검색해 그 작품의 스레드를 찾고, 메시지의 담당 APM 멘션·PIVO를 추출, PIVO로 견적 조회해 초도 납품일·초도 회차를 자동으로 채운다. 한국어 타이틀은 보통 이 대화에서 함께 정한 합의 제목을 ko_title로 넘긴다(없으면 견적 제목). 검수 시작일 자동(요청일+11일). 발송은 그 설정집 스레드에 답글, APM 실제 멘션(게이트 버튼). 수정사항·타이틀은 ✏️수정 모달로도 입력. ★번역개시 발송(✅) 후 봇이 자동으로 이어서 처리하는 것: ①TOTUS 프로젝트명 가제→FIX 변경 ②출판사 드라이브 링크 시트 한국어 타이틀·APM 채움 ③납품 시트(중일 V5)에 초도 회차만큼 행(1~N화) 생성 — 이 세 가지는 확정 버튼('✅ 프로젝트명+시트 반영') 한 번으로 봇이 직접 쓴다. ④1-3화 번역검수 자동 모니터 등록. 그러니 propose_totus_project·register_translation_monitor를 따로 부르지 말 것(수동 등록 요청 때만 register). ★중요: '내부 시트(한국어 타이틀·납품 행)는 도구로 못 바꾼다/직접 채워야 한다'고 답하지 마라 — 위 버튼 체인으로 봇이 실제로 쓴다(버튼을 안 누르면 안 될 뿐). 후보 여러 건이면 사용자에게 되묻기. 검색이 안 잡혀 사용자가 설정집 작성 요청 메시지 '링크 복사' 값을 주면 thread 인자로 넘겨라(그러면 검색 없이 그 스레드에 바로 발송). ★재상 님이 설정집 파일을 올리며 번역개시를 요청하면, 그 **파일명의 일본어 가제 또는 중국어 원제**를 work로 써서 검색하라(파일명에 【修正要望】 등 군더더기가 붙어도 작품 제목 부분만). 그리고 그 메시지에 올린 파일들은 발송 시 그 스레드에 자동으로 같이 첨부된다(봇이 재업로드—따로 첨부하라고 안내할 필요 없음). '보냈다' 단정 금지.",
  "★고객사 → APM 릴레이(재상 님이 고객사 메시지를 붙이며 'APM에게 전달/릴레이해줘'류로 요청할 때): 고객사 채널엔 툰식이가 못 들어가서, 재상 님이 고객사 메시지(보통 **일본어**)를 붙여주면 툰식이가 APM에게 대신 전달하는 흐름이다. ①작품 식별(메시지의 일/중 타이틀 → get_work_info로 **한국어 작품명·담당 APM** 확인) ②요청 유형 파악(원본 교체 / 식자본 선납품 / 번역 JPG 공유 등) → **재상 님 대화체 톤**으로 APM 릴레이 초안을 만들어 send_message로 발송 제안(target=재팬_요청 `C09B8QHP7D4`, 본문 맨 앞 `<@담당APM>` + 끝에 `cc <@U04463JR4HH>`). ★톤(엄수): 굵은 제목·불릿·정형 필드 금지, 자연스러운 대화체. 예 — `<@APM>` 줄 / `<작품> N화 {요청}이 필요합니다.` / `{맥락 한 줄}, …부탁 드립니다.` / `{마감/확인} 가능할까요?`. 링크는 슬랙 마스킹 `<url|라벨>`(생 URL 나열 금지). ★원본 교체 요청이면 원본 링크(고객사가 준 baidu 등)+프로젝트 링크(get_project_url)를 `<url|원본 링크> / <url|프로젝트 링크>`로, 식자·식자검수 담당(작업자 DB)도 함께. 그 외 유형은 요청 내용만 담백하게. 담당 APM이 애매하면 한 줄 되묻기. 게이트(버튼)—'보냈다' 단정 금지.",
  "★작품 특이사항(비고) 등록: '이 작품 특이사항으로 ~ 적어둬/기억해둬'류 요청은 propose_work_note(work, note)로 출판사 드라이브 링크 시트 비고란에 즉시 기록(확인 버튼 없이 바로 반영). 저장해두면 그 작품 납품일마다 시스템이 자동으로 스캔해 그날 재팬_공지의 'Toon_Japan 납품스레드'(하루 1개, 결정적으로 찾음)에 리마인드를 직접 게시한다 — 이건 브레인(너) 개입 없이 스케줄러가 처리하니, 이 흐름 자체를 네가 따로 신경 쓸 필요는 없다(등록만 propose_work_note로 확실히 해주면 됨).",
  "★납품 '체크/완료 여부'를 물으면 반드시 check_undelivered_episodes를 호출해서 답하라 — 스레드에 첨부된 이미지·과거 대화 맥락에서 유추해 답하지 마라(실제로 스레드 내용으로 지어내 틀린 적 있음, 2026-07-15). 도구 호출 없이 '체크 컬럼을 확인할 수 없다'고 답하는 것도 금지 — 그 도구가 정확히 그 체크박스를 읽는다.",
  "★문의봇 하향 릴레이(재상 님이 고객사 답장을 붙이며 '문의봇에 전달/릴레이해줘'류로 요청할 때, 위 고객사→APM 릴레이와 달리 원래 **작업자 쪽에서 올라온 문의·재수급**에 대한 고객사 회신을 되짚어 보내는 경우): 문의/재수급 요청은 시트(문의봇·재수급봇 탭)에 원 스레드 URL과 함께 기록되어 있으니, 웹훅 연동 없이 **find_unresolved_inquiry(work, episode)**로 그 시트를 조회해 미해결(완료 미체크) 건의 원 스레드를 찾는다. ①고객사 답에서 작품(일/중/한)+회차 추출 ②find_unresolved_inquiry 호출 ③결과가 1건이면 그 candidate의 link(스레드 URL)를 send_message의 thread 인자로 그대로 넘겨 답변 relay(+APM 멘션: candidate.apm이 서주원/정태영/박재상이면 위 Slack ID 맵으로, 그 외 이름이면 query_sheet(worker_db)로 slack_id 조회 — 이름 그대로 텍스트로 멘션하지 말 것) ④2건 이상이면 후보(작품·회차·링크) 보여주고 어느 스레드인지 되묻기 ⑤0건이면 '미해결 문의/재수급 못 찾음'이라 답하고 지어내지 말 것. 게이트(버튼)—'보냈다' 단정 금지.",
  "★고객사 개별보고 대상 출판사(2026-07-13 합의): 'Kuaikan Comics（直取引）_2' · 'Shenzhen Yuerong（共同制作）' 소속 작품은 원본 관련 이슈(작화 실수·스토리 모순 등)가 재수급까지 안 갈 만큼 사소해서 재상 님이 내부에서 조용히 처리하고 넘어가는 경우라도, 고객사가 版元에 취합 보고해야 해서 개별로 알아야 한다. 이 두 출판사(get_work_info의 publisher)에 해당하는 작품 얘기 중 원본/재수급/작화/스토리 이슈가 언급되면(내부 처리로 끝내려는 뉘앙스여도) '이 작품은 {출판사}라 사소해도 고객사에 개별 공유해야 해요'라고 짧게 리마인드해라. 워치 채널(재팬_요청·PM요청)에서는 이미 자동으로 뜨니 중복 안내 불필요, 그 외(DM 등)에서 이 얘기가 나올 때만 챙겨라.",
  "★토톡(ToTalk) 개념·발송 규칙: 토톡은 TOTUS 에디터 안의 코멘트/멘션 기능이다. '토톡 멘션 알림'이란 에디터에서 **작업자가 @멘션 당한 것을 그 작업자 슬랙 채널로 직접 전달**하는 것 — 받는 사람은 멘션당한 **작업자 본인**이고, 그 알림 자체가 이미 작업자에게 가는 전달이다. PM(박재상)이 '확인 후 전달'하는 중간 단계가 아니다. check_totalk_mentions는 조회/초안 전용(발송 안 함). ★재상 님이 특정 토톡 알림을 '보내줘/전달해줘' 하면 아래 템플릿 **그대로**(라벨·순서 유지) 보내라. 절대 '@박재상 확인 후 작업자에게 전달' 같은 PM 전달 프레임을 붙이지 말고, 작성자(발송자)도 노출하지 말 것. 담당자=작품 담당 APM @멘션(서주원/정태영/박재상 맵), 본문 앞에 멘션당한 작업자 @멘션, 수신일시=멘션 생성일시. 템플릿: 📩 *Totalk 알림* / 작품명 : {프로젝트명(대괄호태그 제거)} / 담당자 : @{APM} / 본문 : @{작업자} {본문} / 수신일시 : {멘션 생성일시}.",
  "★PIVO ID 상식: 프로젝트명·메시지·견적요청 본문의 **`[PV-숫자]`(보통 6자리)에서 그 숫자가 PIVO ID**다. 도구에 PIVO를 넘길 땐 'PV-' 접두를 떼고 **숫자만** 넘겨라('PV-201454'→'201454'). 그리고 PIVO로 견적/프로젝트를 못 찾으면 거기서 멈추지 말고 **일본어 가제나 중국어 원제로도 조회**해본다(견적 by-pivo·totus_find_project 둘 다 이름검색이 됨).",
  "★용어 구분(엄수·문맥으로 판단): **'납품일'**(='예정' 글자 없음) → 무조건 **내부 납품 시트 get_delivery_date**. **'납품예정일'/'납품 예정일'/'TOTUS 납품예정일'**(예정 명시) → **TOTUS totus_delivery_date**. 즉 '예정'이 안 붙으면 시트가 기본이다 — 그냥 '납품일 조회'에 totus_delivery_date를 쓰지 마라(혼동 금지). 애매하면 시트(get_delivery_date) 우선. ③totus_jobs·totus_tasks·totus_schedule_summary의 마감일은 *오퍼레이션*(PIVO 납품검수 등) 마감일이지 납품예정일이 아니다 — '납품예정일'이라 단정 금지.",
  "- 작품 기본정보(PIVO ID·타이틀·APM·출판사) → get_work_info",
  "- 작품 '원본 링크/원고 받는 곳/원본 수급처' 요청 → get_work_info의 driveLink(출판사 드라이브 링크)를 답한다. driveLink가 있으면 그 URL을 그대로 주고, 비어있으면(없음) '원본 링크는 시트에 없어요 — 출판사 {publisher}에서 중국어 제목 「{zhTitle}」로 검색하세요'처럼 **출판사(publisher) + 중국어 원제(zhTitle)** 를 함께 알려준다(드라이브를 중국어 작품명으로 검색하므로 zhTitle 필수). ★단 출판사가 bilibili comics(哔哩哔哩漫画)나 kuaikan(快看漫画)이면 긴 검색 안내는 생략하되 **플랫폼명 + 중국어 원제(zhTitle)** 를 함께 짧게 준다(원제로 검색하므로 필수). 예: '비리비리예요 — 원제: 「{zhTitle}」' / '콰이칸이에요 — 원제: 「{zhTitle}」'.",
  "- TOTUS 링크 요청: 작품 '프로젝트/작업진행 페이지 링크' = get_project_url(작품) (작품 단위, 회차 불필요). 특정 회차·오퍼레이션의 '에디터 링크' = get_editor_url(작품, 회차, 오퍼레이션명) (상태 무관 최신 task 기준). 둘 다 한국어 제목만으론 동명 프로젝트가 여럿 잡힐 수 있는데, [PV-정식6자리표기]가 붙은 것으로 자동 특정하니 보통은 되묻지 않는다. 그것도 하나로 안 좁혀지면(ambiguous:true) 그때만 candidates 목록 보여주며 되물어라.",
  "- 원본/원고/소스 'PSD·파일 다운로드' 요청 → get_source_files(작품, 회차[, page]). 특정 페이지만(예 '48화 2페이지', '3,4페이지')이면 page 인자에 번호를 넣는다. ★출력은 각 파일을 **슬랙 마스킹 하이퍼링크 `<다운로드URL|파일명>`** 로 만들어 **한 줄(또는 몇 줄)에 `·`로 이어** 압축한다 — raw URL을 파일마다 한 줄씩 나열하지 마라(30줄씩 길어짐). 라벨은 파일명 그대로(페이지 정보 보이게, 예 `48-2.psd`). 예: `📦 원본: <url1|48-1.psd> · <url2|48-2.psd> · <url3|49-1.psd>`. (봇이 파일을 직접 받거나 슬랙에 올리지 말 것 — 대용량이라 링크로만.) 링크는 cf.totus.pro 서명 URL이라 클릭하면 바로 받힌다(로그인 불필요·일정 시간 후 만료).",
  "- 그 외 운영 시트 → query_sheet (사용 가능한 뷰 목록·필드는 그 도구 설명에 들어있으니 거기 보고 고른다).",
  "query_sheet 효율 규칙(중요): 리스트/현황/기간 질문은 한 번의 호출로 서버측에서 좁혀 가져온다. filterField/filterOp/filterValue(예: 리테이크 미완료=filterField:done, filterOp:neq, filterValue:완료), dateField/dateFrom/dateTo(기간), distinct(중복 제거)를 적극 사용. work 없이 큰 시트를 통째로 가져오거나, 같은 호출을 반복하지 말 것. 한 번에 답이 되도록 필터를 설계해 호출 횟수를 최소화한다.",
  "- TOTUS(작품 진행상황·일정 지연/임박·작업자·번역텍스트·견적) → totus_* 도구. PIVO ID 있으면 totus_quotation으로 projectUuid부터 확보 → 그 uuid로 totus_schedule_summary(일정)·totus_jobs/totus_tasks(작업·상태). 작품명만 있으면 totus_find_project로 uuid. 진행/일정/작업자는 시트보다 TOTUS가 정확. 번역텍스트(totus_translation_text)는 양 많으니 필요한 Task에만.",
  "- 번역 검수/QA 요청(예: '게임속기연 90 검수', '○○ ○○화 검수해줘') → ★**review_queue를 써라(1작품이어도!)**. 검수는 무거워서 메인 대화를 막으므로, 워커 풀이 병렬로 돌려 대화를 안 막게 review_queue(works=[{work 또는 pivo, episode, lang?}, …])로 넘긴다. 등록만 하면 워커가 끝나는 대로 결과를 이 스레드에 직접 올리니, 너는 '검수 시작' 한 줄만 알리고 **직접 review_episode를 호출하거나 검수 결과를 만들지 마라**. ★맥락에 PIVO ID가 있으면(예 'NNNNNN | [출판사] 작품 / 회차' 리스트) work 대신 **pivo로 넣어라** — 납품시트에 없는 작품도 TOTUS로 바로 검수된다('납품시트에서 못 찾음'이 뜨면 PIVO로 넣어야 하는 경우다). ★works 파싱 범위(엄수): 스레드가 사람별 섹션('*박재상 5건*' 등)으로 묶여 있고 '내/박재상 밑에 적힌 것/내 섹션 순차 검수해'라고 하면, works는 **그 이름 헤더 바로 아래 줄들의 PIVO/회차만** 그대로 담아라 — APM·담당 필드로 재조회하거나 다른 섹션·전체 스레드의 작품을 긁지 마라(줄 '리스트의 분류=정답' 규칙과 동일). 한일 lang 생략(ko-ja 기본)·중일 zh-ja(pivo 주면 무관). (review_episode 직접 호출은 워커 풀을 못 쓰는 예외 상황에서만.) 도구가 돌려준 [검수 기준]과 pairs로 2패스 검수해, 문제 있는 항목만 [출력 템플릿]대로 작성한다(작품/회차/단계 + task URL + 페이지-텍박 + 수정전→후 + 사유). 문제 없으면 '問題なし'. 이 검수표는 그대로 작업자에게 복붙되는 것이니 임의 해설·강조 없이 템플릿만 깔끔히. error가 오면 그 사유를 그대로 전한다.",
  "★ 검수 결과 전달 규칙: 검수표는 **그냥 네 답변 텍스트로 출력만** 해라 — 시스템이 사용자가 부른 바로 그 자리(스레드/DM)에 자동으로 전달한다. send_message 도구로 직접 보내거나, DM/채널로 따로 발송하거나, 작업자 DB(slack_id/채널)를 조회해 보내려 하지 마라. 'DM으로 보냈다'·'DB에 ID가 없어 못 보냈다' 같은 발송 관련 말도 하지 마라(전달은 시스템 몫). 진행 신호(🔎 추출 완료)도 시스템이 자동으로 띄우니 네가 따로 만들지 마라.",
  "- query_sheet 뷰에 없는 탭을 물으면 → read_tab(탭 이름). 시트 실제 헤더가 곧 필드명이라 사용자가 말한 헤더로 바로 거른다. 표 헤더가 중간 행이면 headerRow 지정. 알려진 6개 시트의 어떤 탭이든 조회 가능.",
  "★번역/식자 방침 문의 → translation_guide로 가이드 참조: 작업자 문의(또는 재상 님 질문)가 '번역 방침·표기 규칙·용어·후리가나·기호(가운데점/괄호 등)·식자 표기' 등 **가이드로 판정할 내용**이면, 추측하지 말고 translation_guide(kind:'translation')로 중일 번역 가이드 2종을 읽어 **해당 조항을 인용**해 답하라(가이드에 없으면 '가이드에 명시 없음'이라 하고 임의 규칙을 지어내지 마라). 단순 원문/수치 확인은 여기 해당 없음. ★설정집 작성 가이드(kind:'setjip')는 **재상 님이 '설정집'을 명시적으로 언급**할 때만 조회하고, 작업자 번역 방침 문의엔 쓰지 마라.",
  "- 스레드 찾기('○○ 작품 ~~ 스레드 찾아줘', '○○ 관련 논의 어디 있어', 과거 대화/스레드 내용): find_thread(query=작품명+키워드). 등록된 주요 업무 채널들에서 검색해 매칭 스레드를 찾고, 1개로 분명하면 내용(topContent)까지 와서 요약·답+링크. 여러 개면 후보를 보여주고 어느 건지 되묻거나 키워드를 좁힌다(임의 단정 금지). 사용자가 특정 채널을 말하면 channel 인자로. 특정 스레드/링크를 콕 집으면 read_thread. (등록 채널·봇 멤버 범위 내 — 전역 검색 아님)",
  "- '고객사 스케줄 시트'(중일, =내부 납품 시트와 다름) 질문 → query_schedule. 블록 구조라 query_sheet/read_tab으론 안 됨. '○○ N화 런칭일'·재수급/문의 확인 후 납품일 재설정 기준 런칭일=mode:launch(work나 pivo + episode), ★'이 납품(회차)이 스케줄 시트에 기재/반영됐나' 검증=**mode:delivery_check**(納品話数+納品予定日 기준, listedForDelivery로 판단 — 話数(런칭)로 보는 launch로 판단하면 오답이니 절대 launch로 납품 기재 여부를 판정하지 마라), 'N/일 납품 회차 카운트'=mode:delivery_on+date, '원본 미수급'=mode:missing, '○○ 작품 스케줄'=mode:work. 여러 작품+회차를 한꺼번에 검증하면 각 항목마다 delivery_check를 돌려 결과를 모아 답한다. 블록 제목(正式+仮) 직접매칭이라 일본어 제목만으로도 잘 잡힌다. ID 묻지 말 것(이 도구가 그 시트임).",
  "★ 용어 사전(재상 님 표현 → 정확한 소스. 이 매핑을 *최우선*으로 따르고 추측하지 말 것): '에러율/월간 에러율' = 리테이크 시트 '중일 에러율' 탭의 '월별 전체 에러율'(기준월별, 에러작품 Top5 포함) → read_tab(tab:'중일 에러율'). '합격률/등급/KP등급' = 번역가_등급표(translator_grade 뷰). 사전에 없는데 한 용어가 여러 소스로 갈릴 수 있으면, 임의로 고르지 말고 '어느 걸 말씀하시는지' 짧게 되묻는다.",
  "- 학습/교정(영구): 재상 님이 '앞으로 ~로 기억해/외워둬', '이건 이렇게 이해해', 또는 내가 잘못 이해한 걸 바로잡아 주면 → remember(note)로 저장한다(재기동에도 유지, 다음부터 자동 적용). '그 규칙 잊어'=forget, '뭐 배웠어'=list_learned. ★단순 '나중에 ~할 일'은 add_reminder(리마인더), 항구적 동작 규칙·별칭·이해 교정은 remember로 구분. 모호하면 '리마인더로 할까요, 규칙으로 외울까요?' 한 줄 확인.",
  "- 리마인더 두 종류: ①시각 없이 '이거 기억해둬'·'나중에 ~해야 해'·'~잊지마' → add_reminder(text) (끝내거나 '그만'할 때까지 하루 여러 번 자동 재촉, 시간 묻지 말 것). ②특정 시각 '월요일 오전 10시에 ~ 리마인드'·'내일 3시에' → schedule_reminder(text, when) (when은 메시지 앞 [현재 시각(KST)] 기준으로 ISO8601 계산, +09:00). 목록 → list_reminders. 완료('~했어'·'N번 완료'·'해결됐어')거나 중단('그만'·'멈춰'·'이건 그만 리마인드해') 신호 → complete_reminder(번호 또는 내용 일부). 재촉 중인 일을 대화로 처리하다가 '그만/됐어' 신호가 오면 그 항목을 complete_reminder로 빼라.",
  "그 밖에 도구가 없는 일이면, '도구가 없다'를 장황히 설명하지 말고 — 아는 선에서 바로 도움이 되는 답을 주고, 정확한 데이터가 필요하면 어디(어느 시트·채널)를 보면 되는지 한 줄로만 짚어준다.",
  "★계산·집계·무거운 작업은 compute로(암산·수동 카운트 금지, 타임아웃 방지): 합계·환율·정산·통계·CSV/시트 집계(개수·비율·분류·TOP N)는 머리로 세지 말고 compute로 코드 실행. 첨부 CSV/엑셀은 compute 안 attachments[i].text로 직접 접근(원문 재기입 금지). 시트 대량 집계는 read_tab으로 행을 가져와 compute에 넘겨 계산(수백 행 직접 세지 말 것). ★**무거운 LLM 분석**(수백~수천 행 분류·요약·인사이트 도출처럼 판단이 오래 걸리는 것)은 네가 직접 붙들지 말고 **delegate_analysis로 워커에 넘겨라** — 데이터는 read_tab/compute/첨부로 모아 data에 넣고 task에 지시를 적으면, 워커가 병렬로 처리해 결과를 스레드에 직접 올린다(메인 대화 안 막힘). 산수·집계는 compute로 먼저 끝내고 그 결과만 넘기면 된다. 가벼운 즉답 조회는 그냥 답해라. ★**대용량 DB 데이터의 심층·탐색적 분석**(수천 행 크런칭, 반복 정제, 다단계)은 봇이 직접 붙들지 말고 **export_csv로 정제 데이터를 뽑아 주고 '깊은 분석은 클로드 앱에서 하시라'고 안내**하라(툰식이=라이브 데이터 추출·정제, 클로드 앱=무거운 반복 분석). 즉 분류·집계·요약처럼 한 번에 끝나는 판단은 delegate_analysis, 앱으로 넘길 대용량/탐색형은 export_csv. ★번역 검수는 **무조건 review_queue로 큐잉**(1작품이든 8작품이든). review_queue는 검수 워커 풀(동시 여러 개)에 넘겨 병렬로 돌리고 각 결과를 워커가 스레드에 직접 올리므로, 네가 review_episode를 직접 부르거나 검수 판단을 하지 마라(메인 대화가 막힌다). works=[{work 또는 pivo, episode, lang?}…]로 사용자/스레드에서 순서대로 파싱해 한 번에 넘겨라.",
  "★도구 라우팅(엄수·양방향 폴백 금지): ①운영·내부 데이터(작품·납품·일정·작업자·정산·고객사·스케줄 등)는 반드시 내부 도구(get_*·query_sheet·totus_*·read_tab·query_schedule 등)로만 조회한다. 못 찾으면 '못 찾았다'고 답하고 작품명 표기 확인을 요청한다 — 절대 웹으로 넘어가지 마라. ②WebSearch(웹 검색)는 사용자가 '웹에서/검색해줘'라고 명시했거나, 환율·일반상식·뉴스처럼 내부에 있을 리 없는 외부·실시간 정보일 때만 쓴다. 웹에서 못 찾으면 '웹에서 못 찾았다'고 답하고 내부 도구로 폴백하지 마라. ③즉 각 요청은 지정된 한쪽 출처에서만 처리하고, 미스는 '못 찾음'으로 끝낸다(반대편으로 안 넘어감). WebFetch(임의 URL 회수)는 쓰지 말고, 같은 검색을 2회 넘게 재시도하지 마라.",
  "비가역적이거나 고객사로 나가는 동작(발송·삭제·수정)은 절대 임의 실행하지 않고 먼저 확인을 받는다.",
  "모르면 모른다고 솔직하게, 추측이면 추측이라고 표시한다.",
].join("\n");

// ── 중복 처리 방지 (슬랙 재전송 대비) ───────────────────────────────
const processed = new Set();

// ── 게이트형 대기상태: 디스크 영속(재시작·장시간에도 버튼 유지) ──────────
// 메모리 Map은 봇 재시작 시 사라져 버튼이 죽음 → set/delete마다 data/pending-*.json에 저장,
// 시작 시 자동 복구. createdAt도 보존돼 TTL이 원래 생성시각 기준으로 유지된다.
const PENDING_DIR = "data";
class PersistMap extends Map {
  constructor(name) {
    super();
    this.file = `${PENDING_DIR}/pending-${name}.json`;
    try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.file, "utf8")))) Map.prototype.set.call(this, k, v); } catch {}
  }
  save() { try { mkdirSync(PENDING_DIR, { recursive: true }); writeFileSync(this.file, JSON.stringify(Object.fromEntries(this))); } catch {} }
  set(k, v) { Map.prototype.set.call(this, k, v); this.save(); return this; }
  delete(k) { const r = Map.prototype.delete.call(this, k); this.save(); return r; }
  maxSeq() { let m = 0; for (const k of this.keys()) { const n = parseInt(String(k).split("_").pop()); if (Number.isFinite(n) && n > m) m = n; } return m; }
}
const pendingEdits = new PersistMap("edits");        // changeId → { sheetId, tab, items[], newValue, clearing, ... }
const pendingTotusDates = new PersistMap("totus");   // changeId → { items[], deliveryDate, reason, work, ... }
const pendingTotusProj = new PersistMap("totusproj"); // id → { projectUuid, projectName, change, label, createdAt }
const pendingSends = new PersistMap("sends");        // sendId → { target, text, createdAt }
const pendingFeedback = new PersistMap("feedback");  // fbId → { channel, text, koTitle, episode, rowsToMark, ... }
const pendingRetakes = new PersistMap("retakes");    // rkId → { target, headerReal, headerPreview, body, ..., previewChannel, previewTs }
const pendingTransStart = new PersistMap("transstart"); // tsId → { channel, threadTs, text, createdAt } 번역 개시 요청(스레드 답글 발송)
const pendingSetjip = new PersistMap("setjip");      // sjId → { channel, text, work, createdAt } 설정집 작성 요청 게시
const pendingTaskRetake = new PersistMap("taskretake"); // trId → { work, operation, items[{episode,taskUuid,status}], createdAt } TOTUS 태스크 리테이크(연결 태스크 생성)
let setjipSeq = 0;
let editSeq = pendingEdits.maxSeq();
let totusDateSeq = pendingTotusDates.maxSeq();
let totusProjSeq = pendingTotusProj.maxSeq();
setjipSeq = pendingSetjip.maxSeq();
const TOTUS_ACTION_KO = { hold: "홀드", unhold: "홀드 해제", process: "진행", pause: "일시정지", complete: "완료", cancel: "취소" };
let sendSeq = pendingSends.maxSeq();
let feedbackSeq = pendingFeedback.maxSeq();
let retakeSeq = pendingRetakes.maxSeq();
let transStartSeq = pendingTransStart.maxSeq();
let taskRetakeSeq = pendingTaskRetake.maxSeq();
// 원고수급 미발송 일괄전송 GAS 웹앱 호출(dryRun=건수만, 아니면 실제 전송+체크)
async function wongoPost(dryRun) {
  const url = process.env.WONGO_UPDATE_URL, secret = process.env.WONGO_UPDATE_SECRET;
  if (!url || !secret) throw new Error("WONGO_UPDATE_URL/SECRET 미설정");
  const r = await fetch(url, { method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret, dryRun: !!dryRun }), signal: AbortSignal.timeout(60000) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { throw new Error("GAS 응답 파싱 실패: " + t.slice(0, 150)); }
  if (j.error) throw new Error("GAS: " + j.error);
  return j;
}
// 원고수급 미발송 건 비고란(L열) 자동 기재 — 두 가지(재상 님 요청 2026-07-14/2026-07-15):
// ①납품일까지 14일 미만 남으면 "일정 타이트". PIVO+화수로 납품 시트(중일 V5)에서 그 회차들의 가장 이른
//   납품일을 찾아 계산. 납품일이 아직 시트에 없는 회차(원고가 번역 진행분보다 앞서 있는 경우)는 판단 불가라 스킵.
// ②①에 해당 안 하면, 그 작품의 납품 주기를 계산해 1·2화는 기본값 취급(라벨 없음), 3화 이상이면 "주{N}화 납품".
//   ★주기 판단은 고객사 스케줄 시트(deliveryBatchMode, schedule.js)의 週次 納品話数 기준 — 처음엔 내부 납품
//   시트(중일 V5)의 납품일 그룹핑으로 계산했는데, 초도(1화 포함) 배치만 있고 아직 週次 데이터가 없는 신작에서
//   그 초도 배치 크기를 그대로 주기로 오인하는 문제가 있었음(예: 좀비 나이트메어 — 초도 20화 몰아내고 이후
//   매주 1화씩인데 "주20화"로 잘못 라벨됨, 재상 님 확인 2026-07-16). 스케줄 시트는 이미 週 단위로 나뉘어
//   있어 이런 오인식이 없음.
// 이미 비고가 있으면(수동 메모) 어느 쪽도 덮어쓰지 않음.
async function annotateWongoNotes() {
  const OPS_ID = "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";
  const rows = (await readRangeRO(OPS_ID, "원고수급!A2:N")) || [];
  const isDone = (v) => /^(true|1|완료|y|yes|✓)$/i.test(String(v ?? "").trim());
  const kday = (t) => Math.floor((t + 9 * 3600 * 1000) / 86400000);   // KST 달력일
  const todayKDay = kday(Date.now());
  const updates = [];
  let tightCount = 0, groupCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const work = String(r[2] || "").trim();
    if (!work || isDone(r[13])) continue;
    if (String(r[11] || "").trim()) continue;   // 기존 비고 보존(덮어쓰지 않음)
    const pivo = String(r[1] || "").trim();
    const epRange = String(r[9] || "").trim();
    if (!pivo || !epRange) continue;
    const episodes = parseEpisodeSpec(epRange);
    if (!episodes.length) continue;

    let noteValue = null;
    let dr;
    try { dr = await resolveDeliveryCells({ work: pivo, episodes, lang: "zh-ja" }); } catch { dr = null; }
    if (dr) {
      const days = dr.found.map((f) => f.currentDate).filter(Boolean)
        .map((d) => { const m = String(d).match(/(\d{4})-(\d{2})-(\d{2})/); return m ? kday(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; })
        .filter((n) => n != null);
      if (days.length && Math.min(...days) - todayKDay < 14) { noteValue = "일정 타이트"; tightCount++; }
    }
    if (!noteValue) {
      const mode = await deliveryBatchMode({ pivo }).catch(() => null);
      if (mode && mode >= 3) { noteValue = `주${mode}화 납품`; groupCount++; }   // 1·2화는 기본값 취급, 3화 이상만 라벨
    }

    if (noteValue) updates.push({ a1: `원고수급!L${i + 2}`, value: noteValue });
  }
  if (updates.length) await setCells(OPS_ID, updates);
  return { total: updates.length, tightCount, groupCount };
}
// 여러 작품을 배정 현황(등록 여부·상태) + 납품 시트(최근 납품일 지남 여부)로 한 번에 대조.
// 시트를 작품 수만큼 반복 조회하지 않고 딱 2번(배정현황·납품시트)만 읽어 로컬 매칭 — get_delivery_date를
// 여러 작품에 루프 돌리면 매번 시트 전체를 재조회해 느려서(하드타임아웃 실측, 2026-07-14) 만든 배치 전용 경로.
async function checkWorkList(works, lang = "zh-ja") {
  const OPS = "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";
  const assign = (await readRangeRO(OPS, "배정 현황!A2:R")) || [];
  const aIdx = new Map();
  for (const r of assign) { const t = norm(r[0]); if (t) aIdx.set(t, r); }
  const DID = "1QWCtU1GnCT2BQZvuF_N-8MnpgiyqIDTcM0x6hdCi8mQ";
  const tab = lang === "ko-ja" ? "납품관리시트_Japan(한일 V5)" : "납품관리시트_Japan(중일 V5)";
  const dv = (await readRangeRO(DID, `${tab}!A:G`)) || [];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const out = [];
  for (const w of works) {
    const key = norm(w);
    let hit = aIdx.get(key), via = null;
    if (!hit) {
      const al = await resolveTitleAliases(w).catch(() => null);
      if (al) for (const alias of al.aliases) { const h = aIdx.get(norm(alias)); if (h) { hit = h; via = al.koTitle; break; } }
    }
    const rows = dv.filter((r) => { const b = norm(r[1]); return b && (b.includes(key) || key.includes(b)); });
    const dates = rows.map((r) => r[6]).filter(Boolean).sort();
    const lastDelivery = dates.length ? dates[dates.length - 1] : null;
    out.push({ work: w, inAssignSheet: !!hit, assignStatus: hit ? hit[1] : null, resolvedVia: via, lastDelivery, deliveryPast: lastDelivery ? lastDelivery < today : null });
  }
  return out;
}
// n8n 로컬 웹훅 POST(.env N8N_WEBHOOK_BASE = http://localhost:5678). path=웹훅 경로.
async function n8nPost(path, body) {
  const base = process.env.N8N_WEBHOOK_BASE;
  if (!base) throw new Error("N8N_WEBHOOK_BASE 미설정");
  const r = await fetch(`${base.replace(/\/$/, "")}/webhook/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
  if (!r.ok) throw new Error(`n8n ${r.status}: ${t.slice(0, 200)}`);
  return j;
}
let currentCtx = null;            // { client, channel, ts } — handle()가 메시지마다 갱신(직렬 가정). 영속 대상 아님(client 비직렬)
// chat.getPermalink 응답(?thread_ts=...&cid=... 쿼리 포함)은 브라우저를 거쳐 슬랙 앱으로 리다이렉트된다.
// 쿼리를 뗀 순수 경로(archives/CH/pXXXX)는 클릭 시 바로 앱으로 열리므로, 시트에 저장하는 링크는 이 형태로 정규화한다.
function stripPermalinkQuery(url) {
  return url ? String(url).split("?")[0] : url;
}
// 지금 턴이 온 스레드(요청 자리)의 슬랙 퍼머링크. 리마인더에 '어디서 요청했는지' 링크를 붙일 때 사용.
async function ctxPermalink() {
  const c = currentCtx;
  if (!c?.client || !c?.channel || !c?.ts) return null;
  try { const pl = await c.client.chat.getPermalink({ channel: c.channel, message_ts: c.ts }); return pl?.permalink || null; }
  catch { return null; }
}
const EDIT_TTL_MS = 24 * 60 * 60 * 1000;   // 버튼 유효 24h (영속화로 재시작에도 유지)

const SETJIP_CHANNEL = process.env.SETJIP_CHANNEL || "C09AUQN8GEB";   // 설정집 작성 요청 채널(#재팬_작업요청)
// ── 설정집 일정 관리(2026-07-15): 요청 이력을 시트에 남기고, 제출 희망일 당일 재상 님께 검수 리마인드 ──
const SETJIP_SCHEDULE_SHEET = "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";
const SETJIP_SCHEDULE_TAB = "설정집 일정";
let _setjipTabEnsured = false;
// "7/24(金) 오전 중" 같은 표시용 문자열 → 비교용 ISO 날짜("2026-07-24"). 이미 지난 월/일이면 내년으로 보정(연말 경계 대비).
function submitDateToISO(s) {
  const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  let year = now.getUTCFullYear();
  const mo = +m[1], da = +m[2];
  const todayNum = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  if (mo * 100 + da < (todayNum % 10000) - 3000) year += 1;   // 대략 3개월 이상 과거처럼 보이면 연도 넘어간 것으로 간주
  return `${year}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}
// 설정집 작성 요청 게시 직후 이력 한 줄 기록(실패해도 요청 게시 자체는 막지 않음 — 게시가 우선).
async function logSetjipSchedule({ work, pivo, apmId, submitDate, threadLink }) {
  try {
    if (!_setjipTabEnsured) { await ensureTab(SETJIP_SCHEDULE_SHEET, SETJIP_SCHEDULE_TAB); _setjipTabEnsured = true; }
    const rows = await readRangeRO(SETJIP_SCHEDULE_SHEET, `${SETJIP_SCHEDULE_TAB}!A:A`);
    const row = (rows?.length || 1) + 1;   // 헤더 다음 첫 빈 행
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    await setCells(SETJIP_SCHEDULE_SHEET, [
      { a1: `${SETJIP_SCHEDULE_TAB}!A${row}`, value: today },
      { a1: `${SETJIP_SCHEDULE_TAB}!B${row}`, value: work || "" },
      { a1: `${SETJIP_SCHEDULE_TAB}!C${row}`, value: pivo || "" },
      { a1: `${SETJIP_SCHEDULE_TAB}!D${row}`, value: apmId ? (USER_NAMES[apmId] || apmId) : "" },
      { a1: `${SETJIP_SCHEDULE_TAB}!E${row}`, value: submitDate || "" },
      { a1: `${SETJIP_SCHEDULE_TAB}!F${row}`, value: threadLink || "" },
      { a1: `${SETJIP_SCHEDULE_TAB}!G${row}`, value: "FALSE" },
      { a1: `${SETJIP_SCHEDULE_TAB}!I${row}`, value: submitDateToISO(submitDate) || "" },
    ]);
  } catch (e) { console.error("[setjip-schedule] 이력 기록 실패:", e?.message ?? e); }
}
// 매일 체크: 제출 희망일(I열 ISO) == 오늘이고 아직 리마인드 안 했으면(G열≠TRUE) 재상 님께 검수 DM.
// 제출희망일 자체가 "오전 중"이라 자정 직후(0시대)에 알리면 의미가 없음 — 이 시각(KST) 이후 그날 첫 tick에서.
const SETJIP_DEADLINE_HOUR = Number(process.env.SETJIP_DEADLINE_HOUR ?? 12);   // "오전 중" 마감이라 오전이 끝나는 정오에
let _setjipDeadlineDate = null;
async function checkSetjipDeadline() {
  try {
    if (!BRAIN_ON) return;
    const now = new Date();
    const kh = Number(now.toLocaleString("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false }));
    const kd = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    if (kh < SETJIP_DEADLINE_HOUR || _setjipDeadlineDate === kd) return;
    const rows = await readRangeRO(SETJIP_SCHEDULE_SHEET, `${SETJIP_SCHEDULE_TAB}!A2:I2000`);
    if (!rows?.length) { _setjipDeadlineDate = kd; return; }
    const updates = [];
    let hit = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const iso = r[8], reminded = String(r[6] || "").trim().toUpperCase() === "TRUE";
      if (!iso || reminded || iso !== kd) continue;
      const work = r[1] || "", thread = r[5] || "";
      await dmOwner(`📅 *설정집 검수 리마인드* — *${work}* 제출 희망일이 오늘이에요.\n${thread ? thread : ""}\n설정집 task 완료 여부 확인하고 검수해주세요.`);
      updates.push({ a1: `${SETJIP_SCHEDULE_TAB}!G${i + 2}`, value: "TRUE" });
      hit++;
    }
    if (updates.length) await setCells(SETJIP_SCHEDULE_SHEET, updates);
    _setjipDeadlineDate = kd;
    if (hit) console.log(`[setjip-schedule] 오늘(${kd}) 마감 리마인드 ${hit}건 발송`);
  } catch (e) { console.error("[setjip-schedule] 리마인드 체크 실패:", e?.message ?? e); }
}
// 설정집 SETUP 태스크(TOTUS) 완료 자동 감지 → 검수 자동 트리거(2026-07-22).
// PIVO만으로 BID 없이 상태 확인: 견적(quotationByPivo)→projectUuid → projectJobs에서 "설정집" JOB의 uuid
// → taskList(jobUuids+operationTypeCode:OTC0054)로 그 태스크 상태 조회. (projectJobs 자체의 "오퍼레이션"은
// 이 JOB에서 비어있어 못 씀 — taskList가 실제 상태를 주는 유일한 경로. projectUuid 단독 필터는 이 게이트웨이에서
// 무시되고 전역 목록이 와서 반드시 jobUuids로 좁혀야 함, 2026-07-22 실측 확인.)
// ★OTC0054(검수·번역 — 체크번역셋업) 기준으로 확정(2026-07-22): "설정집" JOB 안에도 여러 오퍼레이션 단계가 있고,
// 그 중 OTC0054가 종료돼야 실제 설정집 작업이 끝난 것으로 볼 수 있음 — 이전 단계(OTC0052)만으로는 완료 판정 불가.
async function setjipTaskStatus(pivo) {
  const q = await quotationByPivo(pivo).catch(() => null);
  const projectUuid = Array.isArray(q?.data) ? q.data[0]?.projectUuid : null;
  if (!projectUuid) return null;
  const jobs = await projectJobs(projectUuid).catch(() => null);
  const job = (jobs?.data || []).find((j) => String(j["JOB명"] || "").trim() === "설정집");
  if (!job?.uuid) return null;
  const tasks = await taskList({ jobUuids: job.uuid, operationTypeCode: "OTC0054" }).catch(() => null);
  return tasks?.data?.[0]?.["상태"] || null;
}
let _setjipTaskCheckAt = 0;
async function checkSetjipTaskCompletion() {
  try {
    if (!BRAIN_ON) return;
    if (Date.now() - _setjipTaskCheckAt < 5 * 60 * 1000) return;   // TOTUS 부하 방지 — 5분 간격
    _setjipTaskCheckAt = Date.now();
    const rows = await readRangeRO(SETJIP_SCHEDULE_SHEET, `${SETJIP_SCHEDULE_TAB}!A2:J2000`);
    if (!rows?.length) return;
    let hit = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const triggered = String(r[9] || "").trim().toUpperCase() === "TRUE";   // J열 = 자동검수 트리거 완료(H열은 '비고'라 사용 못 함)
      if (triggered) continue;
      const pivo = String(r[2] || "").trim(), threadLink = String(r[5] || "").trim();
      if (!pivo || !threadLink) continue;
      try {
        const status = await setjipTaskStatus(pivo);
        if (status !== "COMPLETED") continue;
        const p = parseSlackLink(threadLink);
        if (!p) continue;
        // 웹훅 발송 전에 먼저 마킹 — 재기동/겹침에도 중복 트리거 안 되게(스크럼 diff 중복발송 사고 교훈, 실패 시 미발송 감수).
        await setCells(SETJIP_SCHEDULE_SHEET, [{ a1: `${SETJIP_SCHEDULE_TAB}!J${i + 2}`, value: "TRUE" }]);
        await n8nPost("seoljeongjip-run", { channel: p.channel, thread_ts: p.ts, user: OWNER_ID });   // 자동 트리거라 클릭자가 없음 — 검수 결과 DM은 재상 님 앞으로
        hit++;
        console.log(`[setjip-auto-review] ${r[1] || pivo} SETUP 완료 감지 → 검수 자동 트리거`);
      } catch (e) { console.error("[setjip-auto-review] 개별 처리 실패:", pivo, e?.message ?? e); }
    }
  } catch (e) { console.error("[setjip-auto-review] 실패:", e?.message ?? e); }
}
// 스레드 검색 대상 채널(.env SEARCH_CHANNELS = "ID:이름,ID:이름,…"). find_thread가 여기서만 검색.
const SEARCH_CHANNELS = (process.env.SEARCH_CHANNELS || "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [id, ...n] = s.split(":"); return { id: id.trim(), name: (n.join(":").trim() || id.trim()) }; });
const KO_WD = ["일", "월", "화", "수", "목", "금", "토"];

// 고객 번역 검수 시작일 = 요청일(오늘 KST) + days(주말 포함 달력일, 기본 11). "M/D" 반환.
function reviewStartMD(days = 11) {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() + days);
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()}`;
}
// "2026.09.09" / "2026-09-09" → "9/9(수)". 해석 불가면 원문 그대로.
function fmtKDate(s) {
  const m = String(s ?? "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return String(s ?? "").trim();
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d)) return `${+m[2]}/${+m[3]}`;
  return `${+m[2]}/${+m[3]}(${KO_WD[d.getUTCDay()]})`;
}
// 임의 날짜 문자열 → 'YYYY-MM-DD' (납품 시트 G열 형식). 못 읽으면 "".
function toYMD(s) {
  const m = String(s ?? "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}` : "";
}
// 번역 개시 요청 메시지 본문(고정 포맷). preview=true면 APM 멘션을 핑 안 가게 코드로 표기.
function buildTransStartText(p, preview = false) {
  const head = p.apmId ? (preview ? `\`@${p.apmId}\` ` : `<@${p.apmId}> `) : "";
  const note = (p.revisionNote && p.revisionNote.trim()) ? p.revisionNote.trim() : "위에서 언급해드린 수정 사항 외에는 변동 없습니다.";
  return [
    `${head}번역 개시 부탁 드립니다.`,
    ``,
    `• 한국어 타이틀 : ${p.koTitle}`,
    `• 초도 납품일 : ${p.firstDelivery}`,
    `• 초도 회차 ${p.firstEpisode}`,
    ``,
    "```",            // 수정 사항을 회색 박스(코드블록)로
    note,
    "```",
    ``,
    `• 고객 번역 검수 시작일 : ${p.reviewStart}`,
  ].join("\n");
}
// 번역 개시 요청 미리보기 블록(✅발송/✏️수정/취소)
function transStartBlocks(id, p) {
  const apmLine = p.apmId ? `\`${p.apmId}\` → *발송 시 실제 @멘션*` : "⚠️ APM 멘션 못 찾음(수정에서 지정 가능)";
  const fileLine = p.files?.length ? `\n• 첨부 ${p.files.length}개 같이 발송: ${p.files.map((f) => f.name).join(", ")}` : `\n• 첨부 없음(파일 같이 보내려면 이 요청 메시지에 파일을 올려 다시 요청)`;
  return [
    { type: "section", text: { type: "mrkdwn", text: `✉️ *번역 개시 요청 — <#${p.channel}> 설정집 스레드에 답글로 발송*\n• 담당 APM: ${apmLine}${fileLine}\n아래 내용 그대로 보낼게요. 확인해 주세요.` } },
    { type: "section", text: { type: "mrkdwn", text: buildTransStartText(p, true) } },
    { type: "actions", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "✅ 발송" }, value: id, action_id: "transstart_confirm" },
      { type: "button", text: { type: "plain_text", text: "✏️ 수정" }, value: id, action_id: "transstart_edit" },
      { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: id, action_id: "transstart_cancel" },
    ] },
  ];
}
// 피드백 공유 미리보기 블록(📣발송/✏️수정/취소). p.body 편집은 모달에서.
function feedbackBlocks(id, p) {
  const warnTxt = p.warn?.length ? `\n• ⚠️ ${p.warn.join(" / ")}` : "";
  return [
    { type: "section", text: { type: "mrkdwn", text: `📣 *피드백 공유 확인* — ${p.koTitle} ${p.episode ? p.episode + "화 " : ""}(${p.batchType || ""}${p.batchDate ? `, 배치 ${p.batchDate}` : ""})\n• 받는 곳: <#${p.channel}>${warnTxt}` } },
    { type: "section", text: { type: "mrkdwn", text: `${p.mentionPreview}\n${p.body}` } },
    { type: "actions", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "📣 발송" }, value: id, action_id: "feedback_confirm" },
      { type: "button", text: { type: "plain_text", text: "✏️ 수정" }, value: id, action_id: "feedback_edit" },
      { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: id, action_id: "feedback_cancel" },
    ] },
  ];
}
// 파일명에서 검색 키 후보 추출(일본어/중국어 제목 런). 노이즈 토큰 제거, 긴 것 우선.
function filenameKeys(name) {
  const base = String(name ?? "").replace(/\.[a-z0-9]+$/i, "");
  const runs = base.match(/[぀-ヿ㐀-鿿豈-﫿々ーｰ]+/g) || [];
  const NOISE = new Set(["修正要望", "仮", "設定集", "作成", "依頼", "要望", "修正"]);
  return [...new Set(runs.filter((r) => r.length >= 2 && !NOISE.has(r)))].sort((a, b) => b.length - a.length);
}
// 설정집 메시지 텍스트에서 초도 정보 파싱(중일 인라인 포맷: •초도 납품일 / •초도 N화)
function parseSetjipInline(text) {
  const t = String(text ?? "");
  const fd = (t.match(/초도\s*납품일\s*[:：]?\s*([^\n•·]+)/) || [])[1]?.trim() || "";
  const fe = (t.match(/초도\s*회차\s*[:：]?\s*(\d+)/) || t.match(/초도\s*(\d+)\s*화/) || [])[1] || "";
  return { firstDelivery: fd, firstEpisode: fe };
}
// 설정집 작성 요청 채널에서 작품/PIVO로 메시지 찾기 → {ts, apmId, pivoId, text}
async function findSetjipRequest(client, query) {
  const norm = (s) => String(s ?? "").replace(/[\s~～〜〰（）()【】「」『』・,.\-—–:：_]/g, "").toLowerCase();
  const q = String(query ?? "").trim();
  const pivoNum = (q.match(/(\d{4,})/) || [])[1];          // PIVO처럼 보이는 4자리+ 숫자
  const isPivoOnly = /^(pv-?)?\d{4,}$/i.test(q);
  // 채널 트래픽이 많아 200건 너머에 있을 수 있음 → 최대 5페이지(≈1000건) 페이지네이션
  const reqs = [];
  let cursor;
  for (let pg = 0; pg < 5; pg++) {
    const h = await client.conversations.history({ channel: SETJIP_CHANNEL, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const m of (h.messages || [])) if (String(m.text || "").includes("설정집 작성 요청")) reqs.push(m);
    cursor = h.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  const nq = norm(q);
  const hits = reqs.filter((m) => {
    const t = String(m.text || "");
    if (pivoNum && new RegExp(`PV-?${pivoNum}\\b`).test(t)) return true;
    if (isPivoOnly) return false;
    return nq && norm(t).includes(nq);
  });
  return hits.map((m) => ({ ts: m.ts, text: m.text, apmId: (String(m.text).match(/<@([UW][A-Z0-9]+)>/) || [])[1] || null, pivoId: (String(m.text).match(/PV-?(\d+)/) || [])[1] || null }));
}
const STALL_NOTICE_MS = 150 * 1000;   // 이 시간 내 응답 없으면 '처리 중'을 지연 안내로 갱신
const FEEDBACK_CHANNEL = process.env.FEEDBACK_CHANNEL || "C09B8QHP7D4";   // 피드백 공유 기본 채널
// 리테이크 미리보기 블록(발송/수정/취소). 도구와 수정모달 submit이 공유.
function retakeBlocks(rkId, p) {
  // 리테이크 메시지는 일본어만 — 본문에 한글이 있으면 경고(✏️수정으로 고치게). 모달 수정 후에도 재평가.
  const koInBody = /[가-힣]/.test(p.body || "") ? "본문에 한국어가 섞여 있어요 — 일본어만 권장(✏️수정)" : "";
  const allWarn = [...(p.warn || []), koInBody].filter(Boolean);
  const warnTxt = allWarn.length ? `\n• ⚠️ ${allWarn.join(" / ")}` : "";
  // 멘션 대상 ID는 코드(백틱)로 표기 → 미리보기에서 렌더/핑 안 됨(증거용). 발송 땐 실제 <@ID> 멘션.
  const mentionInfo = p.trId
    ? `\n• 멘션 대상: 번역가 \`${p.trId}\`${p.apmId ? ` · cc \`${p.apmId}\`` : ""} → *발송 시 실제 @멘션으로 전송*(미리보기는 핑 방지로 평문)`
    : `\n• ⚠️ 번역가 Slack ID를 작업자 DB에서 못 찾음 — 발송해도 멘션이 안 됩니다(평문). 작업자 DB 확인 필요`;
  return [
    { type: "section", text: { type: "mrkdwn", text: `🔁 *리테이크 발송 확인* — *${p.koTitle}* ${p.epText}\n• 받는 곳: <#${p.target}> (${p.targetKind}, 번역가 *${p.translator || "?"}*)\n• 참고 에디터: ${p.editorKind || "없음"}${mentionInfo}${warnTxt}` } },
    { type: "section", text: { type: "mrkdwn", text: `${p.headerPreview}\n${p.body}` } },
    { type: "actions", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "🔁 발송" }, value: rkId, action_id: "retake_confirm" },
      { type: "button", text: { type: "plain_text", text: "✏️ 수정" }, value: rkId, action_id: "retake_edit" },
      { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: rkId, action_id: "retake_cancel" },
    ] },
  ];
}

// 큰 JSON 응답이 컨텍스트를 폭발시키지 않게 컷 (TOTUS 등)
const capJson = (obj) => { const s = JSON.stringify(obj); return s.length > 8000 ? s.slice(0, 8000) + `\n…(전체 ${s.length}자 중 8000자만. 필터/대상 좁혀 재조회)` : s; };
// Outline 입력 정규화: 문서 URL이면 urlId(마지막 토큰) 추출, UUID/urlId면 그대로
function outlineDocId(s) { const t = String(s || "").trim(); const m = t.match(/\/doc\/([^/?#]+)/); return m ? m[1].split("-").pop() : t; }
const totusTool = (fn) => async (a) => { try { return { content: [{ type: "text", text: capJson(await fn(a)) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } };

// JOB Task 조회 시 '식자검수 이후 후공정'(납품검수·PIVO 납품검수·고객검수·최종검수)은 기본 제외 — 식자검수까지만.
const POST_SIKJA_OPS = ["납품검수", "고객검수", "최종검수"];   // 이름 부분일치(공백제거). 'PIVO 납품 검수'는 '납품검수'로 걸림
const isPostSikjaOp = (op) => { const nm = String(op?.태스크?.[0]?.오퍼레이션유형명 || "").replace(/\s/g, ""); return !!nm && POST_SIKJA_OPS.some((e) => nm.includes(e)); };
const trimJobsAtSikja = (j) => { for (const job of j?.data || []) if (Array.isArray(job.오퍼레이션)) job.오퍼레이션 = job.오퍼레이션.filter((op) => !isPostSikjaOp(op)); return j; };

// ── 사용량·활동 로깅 + 데일리 리포트 ─────────────────────────
function logUsage(rec) {
  try { appendFileSync("logs/usage.jsonl", JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n"); } catch { /* 로깅 실패는 무시 */ }
}
const kstDateOf = (d = new Date()) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);   // KST YYYY-MM-DD
const kstHourNow = () => new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
function readJsonlSafe(path) {
  try { return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function buildDailyReport(dateStr) {
  const onDate = (arr) => arr.filter((r) => r.at && kstDateOf(new Date(r.at)) === dateStr);
  const usage = onDate(readJsonlSafe("logs/usage.jsonl"));
  const main = usage.filter((u) => u.kind === "main");
  const workers = usage.filter((u) => u.kind === "worker");
  const inTok = usage.reduce((s, u) => s + (u.inTok || 0), 0);
  const outTok = usage.reduce((s, u) => s + (u.outTok || 0), 0);
  const errs = main.filter((u) => u.isError).length;
  const avgMs = main.length ? main.reduce((s, u) => s + (u.ms || 0), 0) / main.length : 0;
  const byUser = {};
  for (const u of main) { const k = USER_NAMES[u.user] || u.user || "?"; byUser[k] = (byUser[k] || 0) + 1; }
  const act = {
    발송: onDate(readJsonlSafe("logs/sends.jsonl")).length,
    시트변경: onDate(readJsonlSafe("logs/edits.jsonl")).length,
    리테이크: onDate(readJsonlSafe("logs/retakes.jsonl")).length,
    피드백공유: onDate(readJsonlSafe("logs/feedback.jsonl")).length,
    "납품예정일변경": onDate(readJsonlSafe("logs/totus-dates.jsonl")).length,
    프로젝트변경: onDate(readJsonlSafe("logs/totus-proj.jsonl")).length,
    토톡발송: onDate(readJsonlSafe("logs/totalk-sent.jsonl")).length,
  };
  if (!main.length && !workers.length && !Object.values(act).some(Boolean)) return null;
  const fmtN = (n) => Math.round(n).toLocaleString("en-US");
  const userLine = Object.entries(byUser).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "-";
  const actLine = Object.entries(act).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ") || "없음";
  return [
    `📊 *툰식이 데일리 리포트* — ${dateStr}`,
    `• 대화 처리: *${main.length}턴*  (요청자: ${userLine})${errs ? ` · 오류 ${errs}` : ""} · 평균 ${(avgMs / 1000).toFixed(1)}s`,
    `• 워커 잡(검수·분석): *${workers.length}건*`,
    `• 실행 액션: ${actLine}`,
    `• 토큰: 입력 ${fmtN(inTok)} · 출력 ${fmtN(outTok)}  (합 ${fmtN(inTok + outTok)})`,
  ].join("\n");
}
async function checkDailyReport() {
  try {
    if (kstHourNow() < (Number(process.env.REPORT_HOUR) || 9)) return;
    const today = kstDateOf();
    let state = {};
    try { state = JSON.parse(readFileSync("data/daily-report.json", "utf8")); } catch { /* 첫 실행 */ }
    if (state.lastDate === today) return;                       // 오늘 이미 발송
    const y = new Date(Date.now() + 9 * 3600 * 1000); y.setUTCDate(y.getUTCDate() - 1);
    const yStr = y.toISOString().slice(0, 10);                  // 전날(KST)
    const report = buildDailyReport(yStr);
    state.lastDate = today;
    try { writeFileSync("data/daily-report.json", JSON.stringify(state)); } catch { /* 무시 */ }
    if (!report) { console.log(`[daily] ${yStr} 활동 없음 — 리포트 생략`); return; }
    const dm = await app.client.conversations.open({ users: DISPATCHER_USER_ID });
    if (dm.channel?.id) await app.client.chat.postMessage({ channel: dm.channel.id, text: report, ...SENDER });
    console.log(`[daily] ${yStr} 리포트 발송`);
  } catch (e) { console.error("[daily] 실패:", e?.message ?? e); }
}

// ── 범용 워커 풀 ─────────────────────────────────────────────
// 무거운 작업(검수·대량분석 등)을 메인 브레인과 분리해 여러 워커가 동시 처리한다.
// 잡 = { label, ctx, run:async(id)=>text }. run은 toolless query(ctx·전역상태 안 건드림 → 병렬 안전)로
// 판단하고 결과 문자열을 반환하면 워커가 잡에 캡처된 ctx 스레드로 게시한다.
const WORKER_COUNT = Number(process.env.WORKER_COUNT || process.env.REVIEW_WORKERS || 4);
const JOB_TIMEOUT_MS = 600_000;   // 워커 1개당 독립 타임아웃(다른 워커는 안 막힘). 5분에서 10분으로 늘림(2026-07-16)
const TEXT_EXPORT_BUDGET_MS = 200_000;   // 텍스트 추출 잡 1회 예산(워커 타임아웃 JOB_TIMEOUT_MS보다 짧게) — 초과 시 남은 화는 자동 이어받기
const jobs = [];
const jobWaiters = [];        // 대기 중 워커 resolver (잡 1개당 1명 깨움)
let workersStarted = false;
function ensureWorkers() {
  if (workersStarted) return;
  workersStarted = true;
  for (let i = 0; i < WORKER_COUNT; i++) jobWorker(i + 1);
  console.log(`[worker-pool] 워커 ${WORKER_COUNT}개 기동`);
}
function enqueueJob(job) { jobs.push(job); const w = jobWaiters.shift(); if (w) w(); }
async function workerPost(ctx, text) {
  if (!ctx?.client) return;
  await ctx.client.chat.postMessage({ channel: ctx.channel, thread_ts: ctx.threadTs || ctx.ts, text, ...SENDER })
    .catch((e) => console.error("[worker-pool] 게시 실패:", e.message));
}
async function toollessQuery(prompt, meta = {}) {
  const q = query({ prompt, options: { model: DISPATCHER_MODEL, strictMcpConfig: true, allowedTools: [] } });
  let buf = "";
  for await (const m of q) {
    if (m.type === "assistant") { for (const b of m.message?.content || []) if (b.type === "text" && b.text) buf += b.text; }
    else if (m.type === "result") {
      const out = (m.result || buf || "").trim();
      logUsage({ kind: "worker", label: meta.label || null, channel: meta.channel || null, chars: out.length, inTok: m.usage?.input_tokens ?? null, outTok: m.usage?.output_tokens ?? null, cacheRead: m.usage?.cache_read_input_tokens ?? null, cacheWrite: m.usage?.cache_creation_input_tokens ?? null });
      return out;
    }
  }
  return buf.trim();
}
// 멀티모달(이미지 포함) 일회성 toolless 질의. content=[{type:"text"...},{type:"image"...}]. 원문 이미지 해석용.
async function toollessVisionQuery(content, meta = {}) {
  async function* once() { yield { type: "user", message: { role: "user", content } }; }
  const q = query({ prompt: once(), options: { model: DISPATCHER_MODEL, strictMcpConfig: true, allowedTools: [] } });
  let buf = "";
  for await (const m of q) {
    if (m.type === "assistant") { for (const b of m.message?.content || []) if (b.type === "text" && b.text) buf += b.text; }
    else if (m.type === "result") {
      const out = (m.result || buf || "").trim();
      logUsage({ kind: "worker", label: meta.label || null, channel: meta.channel || null, chars: out.length, inTok: m.usage?.input_tokens ?? null, outTok: m.usage?.output_tokens ?? null, cacheRead: m.usage?.cache_read_input_tokens ?? null, cacheWrite: m.usage?.cache_creation_input_tokens ?? null });
      return out;
    }
  }
  return buf.trim();
}
async function jobWorker(id) {
  while (true) {
    if (!jobs.length) { await new Promise((r) => jobWaiters.push(r)); continue; }
    const job = jobs.shift(); if (!job) continue;
    try {
      const out = await Promise.race([
        job.run(id),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${job.label} 타임아웃(>${JOB_TIMEOUT_MS / 60000}분)`)), JOB_TIMEOUT_MS)),
      ]);
      if (out) await workerPost(job.ctx, out);
    } catch (e) {
      console.error(`[worker ${id}] ${job.label} 오류:`, e?.message ?? e);
      await workerPost(job.ctx, `⚠️ ${job.label} 오류: ${e?.message ?? e}`).catch(() => {});
    }
  }
}
// 검수 잡 생성기 — extract(결정적) → 진행알림 → toolless 2패스 판단 → 결과 반환
function makeReviewJob({ work, pivo, episode, lang, label, ctx }) {
  return { label: `${label} ${episode}화 검수`, ctx, run: async (id) => {
    const r = await extractEpisode({ work, pivo, episode, lang: lang || "ko-ja", stage: null });
    if (r.error) return `${label} ${episode}화: ${r.error}`;
    await workerPost(ctx, `🔎 ${r.work} ${r.episode}화 — ${r.stage} ${r.count}건 추출, 검수 중… (워커 ${id})`);
    const prompt = QA_INSTRUCTIONS + "\n\n[추출 결과]\n" + JSON.stringify(r)
      + "\n\n위 [웹툰 번역 검수 기준]대로 pairs를 2패스 검수해, 문제 있는 항목만 [출력 템플릿]대로 작성하라. 문제 없으면 본문에 '問題なし'만.";
    return (await toollessQuery(prompt, { label: `검수 ${label} ${episode}화`, channel: ctx.channel })) || `${r.work} ${r.episode}화: 問題なし`;
  } };
}
// 텍스트 추출(범위) 잡 — 화별 추출, 예산(200s) 초과 시 그때까지 것 누적해두고 남은 화부터 자동 이어받기(resume).
// 다 되면 누적 CSV 한 번에 업로드. 화별 오류/누락은 건너뛰고 '누락'으로 기록 → 조용히 죽지 않는다.
function makeTextExportJob({ pivo, projectName, from, to, stage, label, ctx, accCsv = null, origFrom = null, accMissing = [] }) {
  const of = origFrom ?? from;
  return { label: `${label} ${of}-${to}화 텍스트추출`, ctx, run: async () => {
    const r = await extractEpisodeRange({ pivo, projectName, from, to, stage, budgetMs: TEXT_EXPORT_BUDGET_MS });
    if (r.error) {
      if (accCsv) { await uploadTextCsv(ctx, { work: label, pivo, of, to, csv: accCsv, missing: accMissing }); return `${label}: 이어받기 중 오류(${r.error}) — 그때까지 추출분만 업로드했어요`; }
      return `${label} ${from}~${to}화 텍스트 추출 실패: ${r.error}` + (r.candidates ? `\n후보: ${r.candidates.join(" / ")}` : "");
    }
    const body = accCsv ? r.csv.split("\n").slice(1).join("\n") : r.csv;       // 이어받기 청크는 헤더 제거
    const acc = accCsv ? (body ? accCsv + "\n" + body : accCsv) : r.csv;
    const missing = [...accMissing, ...r.missing];
    if (!r.done && r.nextFrom && r.nextFrom <= parseInt(to, 10)) {              // 남음 → 진행 알림 + 자동 이어받기
      await workerPost(ctx, `⏳ ${r.work} ${of}~${to}화 텍스트 추출 중… ${r.nextFrom - 1}화까지 완료, 이어서 진행할게요`);
      enqueueJob(makeTextExportJob({ pivo, projectName, from: String(r.nextFrom), to, stage, label: r.work || label, ctx, accCsv: acc, origFrom: of, accMissing: missing }));
      return null;
    }
    await uploadTextCsv(ctx, { work: r.work || label, pivo: r.pivo || pivo, of, to, csv: acc, missing });   // 완료 → 최종 업로드
    return null;
  } };
}
async function uploadTextCsv(ctx, { work, pivo, of, to, csv, missing }) {
  const rows = Math.max(0, String(csv || "").split("\n").length - 1);
  if (!rows) { await workerPost(ctx, `⚠️ ${work} ${of}~${to}화: 추출된 텍스트가 없어요${missing.length ? ` (누락 ${missing.length}화)` : ""}`); return; }
  const title = `PIVO_${pivo || "?"}_${of}-${to}화_텍스트`.replace(/[\\/:*?"<>|]/g, "_");
  const missingNote = missing.length ? `\n누락 ${missing.length}화: ${missing.map((m) => `${m.episode}(${m.reason})`).join(", ")}` : "";
  await ctx.client.files.uploadV2({ channel_id: ctx.channel, thread_ts: ctx.threadTs || ctx.ts, initial_comment: `📄 ${work} ${of}~${to}화 텍스트 (${rows}행)${missingNote}`, file_uploads: [{ file: Buffer.from(csv, "utf8"), filename: `${title}.csv` }] });
}

// findProject 검색 결과가 여럿일 때(동명/구표기 프로젝트 중복) 되묻지 않고 [PV-정식6자리] 태그 붙은 것 하나로 자동 특정.
// 그것도 0개거나 2개 이상이면(진짜 모호) null 반환 — 그때만 candidates 목록으로 폴백.
function pickPivoTagged(candidates) {
  if (candidates.length === 1) return candidates[0];
  const tagged = candidates.filter((p) => /\[PV-\d{6}\]/.test(String(p.프로젝트 || "")));
  return tagged.length === 1 ? tagged[0] : null;
}
// ── 도구(모듈) — 빌드 1: 납품일 조회 (read-only) ───────────────────
const apmTools = createSdkMcpServer({
  name: "apm",
  version: "1.0.0",
  tools: [
    tool(
      "get_delivery_date",
      "납품 시트에서 특정 작품의 납품일을 조회한다. 회차 미지정 시 최신화. 중일(zh-ja) 기본, 한일은 ko-ja.",
      {
        work: z.string().describe("작품명 (한국어 또는 일본어)"),
        episode: z.string().optional().describe("회차 숫자 문자열. 생략 시 최신화"),
        lang: z.enum(["zh-ja", "ko-ja"]).optional().describe("zh-ja=중일(기본), ko-ja=한일"),
      },
      async ({ work, episode, lang }) => {
        try {
          const r = await lookupDelivery({ work, episode: episode ?? "latest", lang: lang ?? "zh-ja" });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool("check_work_list",
      "여러 작품을 한 번에 배정 현황 시트 등록 여부·진행상태, 그리고 납품 시트 최근 납품일이 지났는지 대조한다(시트를 딱 2번만 읽고 로컬 매칭 — 빠름). ★3개 이상 작품의 배정현황/납품일을 확인할 때는 get_delivery_date를 작품마다 반복 호출하지 마라(매번 시트 전체를 새로 읽어 느리고, 실제로 하드타임아웃 난 적 있음, 2026-07-14) — 이 도구를 한 번만 호출해라. '이 작품들 중 배정 현황에 없는 거·납품일 지난 거 알려줘' 류.",
      { works: z.array(z.string()).describe("확인할 작품명(한국어) 목록"), lang: z.enum(["zh-ja", "ko-ja"]).optional().describe("납품 시트 언어쌍(기본 zh-ja)") },
      async ({ works, lang }) => {
        try {
          const r = await checkWorkList(works, lang || "zh-ja");
          return { content: [{ type: "text", text: JSON.stringify({ results: r }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("build_delivery_notice",
      "'Toon_Japan 납품스레드' 일일 납품 공지 초안을 만든다('오늘/7/16 납품 공지 만들어줘' 류). 재상 님이 다운로드 폴더에 두는 'M_D-M_D 납품시트.xlsx' 파일(탭이 날짜별, 각 탭 안에 [한일]→[중일] 섹션 순서, Job name이 범위표기'1-20'면 초도)을 읽어서 [초도]/[한일]/[중일] 섹션과 고정 5인 멘션을 갖춘 완성 텍스트를 만든다. ★이 도구는 텍스트만 만들 뿐 발송하지 않는다 — 만든 text를 send_message(target=C09B8QLR5FG)로 넘겨 재팬_공지 채널 발송을 제안해라(게이트, '보냈다' 단정 금지). 파일 경로 안 주면 다운로드 폴더에서 '납품시트' 들어간 xlsx 중 가장 최근 파일을 자동으로 씀.",
      { date: z.string().describe("날짜(예: '2026-07-16' 또는 '7/16'). 파일 안의 탭과 매칭된다"), file: z.string().optional().describe("엑셀 파일 전체 경로. 생략 시 다운로드 폴더에서 최신 '납품시트' 파일 자동 탐색") },
      async ({ date, file }) => {
        try {
          const filePath = file || findLatestDeliveryExcel();
          if (!filePath) return { content: [{ type: "text", text: JSON.stringify({ error: "다운로드 폴더에서 납품시트 엑셀을 못 찾음. 파일 경로를 알려달라고 되물어라." }) }] };
          const parsed = parseDeliveryNoticeTab(filePath, date);
          if (parsed.error) return { content: [{ type: "text", text: JSON.stringify({ error: parsed.error }) }] };
          const text = buildNoticeText(parsed);
          return { content: [{ type: "text", text: JSON.stringify({ found: true, file: filePath, date: parsed.md, counts: { 초도: parsed.chodo.length, 한일: parsed.hanil.length, 중일: parsed.zhongyi.length }, text, sendTarget: "C09B8QLR5FG", note: "이 text를 send_message(target='C09B8QLR5FG', 재팬_공지)로 넘겨 발송 제안해라. 아직 안 보냈음." }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("check_undelivered_episodes",
      "그날 아직 납품 완료 체크 안 된(F열 미체크) 회차와 담당(납품 진행 APM/PM)을 라이브 시트에서 조회한다('오늘 납품 안 된 거 뭐야', '체크 안 된 작품 확인해줘', '아직 안 끝난 회차·담당 알려줘' 류, 하루 중 수시로 물어볼 수 있음). build_delivery_notice가 참조하는 것과 같은 원본 시트(체크박스 포함) 실시간 조회. ★시트 ID 1foLY_HtD8PwF4li2z_5V7Zfyq8NhFOiWv508okAdcTY(재상 님이 링크로 붙여도 같은 시트)의 '납품완료' 체크 여부를 물으면 무조건 이 도구를 써라 — read_tab이나 query_sheet로 이 시트를 직접 읽지 마라(탭 안에 [한일]/[중일] 두 섹션이 섞여 있어 일반 조회로는 구조를 못 읽고 '체크 컬럼 확인 안 됨'이라고 잘못 답하게 된다).",
      { date: z.string().optional().describe("날짜(예 '2026-07-15' 또는 '7/15'). 생략하면 오늘") },
      async ({ date }) => {
        try {
          const d = date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
          const r = await findUndelivered(d);
          if (r.error) return { content: [{ type: "text", text: JSON.stringify({ error: r.error }) }] };
          return { content: [{ type: "text", text: JSON.stringify({ date: r.md, hanilPending: r.hanilPending, zhongyiPending: r.zhongyiPending, hanilCount: r.hanilPending.length, zhongyiCount: r.zhongyiPending.length }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("retake_query",
      "리테이크 시트(중일·한일 RAW)를 서버측에서 빠르게 조회·집계한다. mode=agg: 기간 내 *작품별 리테이크 건수 TOP N*(코멘트 안 읽고 카운트 → 즉시). 'X월 리테이크 개수/많이 나온 작품 TOP' 류. mode=list: 기간/작품/APM으로 좁힌 리테이크 행(인입일·작품·회차·수정내용(코멘트)·tag·APM·마감일). '○○ 리테이크 현황/오탈자 개수' 류. ★유형(번역/식자/애매) 분류는 이 도구가 안 한다 — mode=list로 받은 행의 *comment(코멘트)를 읽어* 네가 분류하고 compute로 카운트하라(tag는 참고만, 단독 판단 금지). 결과가 많으면(truncated) 기간/작품을 좁혀 재요청.",
      { mode: z.enum(["list", "agg"]), from: z.string().optional().describe("시작일 yyyy-mm-dd(인입일 기준)"), to: z.string().optional().describe("종료일 yyyy-mm-dd"), work: z.string().optional().describe("작품명(부분일치)"), apm: z.string().optional().describe("APM 이름"), lang: z.enum(["zh", "ko", "both"]).optional().describe("기본 both"), top: z.string().optional().describe("agg일 때 상위 N(예 5)") },
      async ({ mode, from, to, work, apm, lang, top }) => {
        try {
          if (!gasReady()) return { content: [{ type: "text", text: JSON.stringify({ error: "리테이크 빠른조회 미설정(.env GAS_QUERY_URL/SECRET). query_sheet 리테이크 뷰로 대체 가능." }) }] };
          const j = await gasQuery({ sheet: "retake", q: mode, from, to, work, apm, lang: lang || "both", top });
          return { content: [{ type: "text", text: JSON.stringify(j) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool("delivery_on_date",
      "납품 시트에서 특정 날짜(또는 기간)에 납품 예정인 작품·회차 리스트를 서버측에서 빠르게 가져온다. '7/17 납품 리스트', 'N월 N일 납품 회차' 류. date(단일) 또는 from~to(기간) 중 하나. (특정 작품의 납품일은 get_delivery_date를 써라.)",
      { date: z.string().optional().describe("단일 날짜 yyyy-mm-dd"), from: z.string().optional().describe("기간 시작 yyyy-mm-dd"), to: z.string().optional().describe("기간 끝 yyyy-mm-dd"), lang: z.enum(["zh", "ko", "both"]).optional().describe("기본 both") },
      async ({ date, from, to, lang }) => {
        try {
          if (!gasReady()) return { content: [{ type: "text", text: JSON.stringify({ error: "빠른조회 미설정(.env GAS_QUERY_URL/SECRET). query_sheet delivery 뷰+dateField로 대체 가능." }) }] };
          const j = await gasQuery({ sheet: "delivery", q: "byDate", date, from, to, lang: lang || "both" });
          return { content: [{ type: "text", text: JSON.stringify(j) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "get_work_info",
      "작품 기본정보 조회: PIVO ID, 한국어/일본어 타이틀, FIX 타이틀, 담당 APM, 출판사, 드라이브 링크. 작품명(한/일/중·앞글자·키워드) 또는 PIVO ID로 검색. 여러 작품이 걸리면 ambiguous=true + candidates를 반환하니, 그땐 임의로 고르지 말고 사용자에게 어느 작품인지 되물어라.",
      {
        query: z.string().describe("작품명(한국어 또는 일본어) 또는 PIVO ID 숫자"),
      },
      async ({ query: qy }) => {
        try {
          const r = await lookupWork(qy);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "propose_work_note",
      "작품별 특이사항(작업 시·납품 시마다 챙겨야 하는 주의사항)을 출판사 드라이브 링크 시트 비고란에 기록한다('이 작품 특이사항으로 ~ 적어둬/기억해둬/기록해둬'). 예: 타이틀 로고 위치를 원작과 반드시 맞춰야 함. 기록해두면 이후 이 작품 납품일마다 자동으로 스캔되어 그날 관련 스레드를 찾아 리마인드가 나간다. 확인 버튼 없이 즉시 반영.",
      { work: z.string().describe("작품명(한/일/중 무엇이든) 또는 PIVO ID"), note: z.string().describe("기록할 특이사항 내용(짧고 명확하게)") },
      async ({ work, note }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const r = await setWorkNote(work, note);
          if (!r.ok) {
            if (r.ambiguous) return { content: [{ type: "text", text: JSON.stringify({ ambiguous: true, msg: r.msg, candidates: r.candidates, note: "후보가 여럿이라 어느 작품인지 되물어라." }) }] };
            return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: r.msg }) }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ applied: true, work: r.workName, note, msg: "이미 시트에 반영됨(확인 불필요). 이 작품 납품일마다 자동으로 리마인드됨." }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      "query_sheet",
      `운영 시트를 뷰 단위로 조회한다(read-only). work를 주면 작품명으로 필터, 생략 시 전체(limit 적용).\n사용 가능한 뷰:\n${VIEW_CATALOG}`,
      {
        view: z.enum(Object.keys(VIEWS)).describe("조회할 뷰 키"),
        work: z.string().optional().describe("작품명(한/일) 또는 키워드. 생략 시 필터 없음"),
        limit: z.number().optional().describe("최대 행 수(기본 50). 응답의 matched가 returned보다 크면 더 올려 재조회"),
        filterField: z.string().optional().describe("상태 필터 컬럼명(뷰 필드명). 리테이크 완료여부=done (값은 '확인 중' 또는 '완료')"),
        filterOp: z.enum(["empty", "notEmpty", "eq", "neq", "contains"]).optional().describe("필터 연산. 리테이크 '미완료/미처리'는 done에 neq '완료'로 한 번에 조회. done은 비어있지 않으니(='확인 중') empty는 쓰지 말 것"),
        filterValue: z.string().optional().describe("eq/neq/contains에 쓸 값"),
        distinct: z.array(z.string()).optional().describe("중복 제거 기준 필드. '작품 회차' 질문이면 [\"work\",\"episode\"] — 코멘트가 여러 개여도 1개로"),
        dateField: z.string().optional().describe("기간/일자 필터에 쓸 날짜 컬럼(뷰 필드명). 예: in_date, delivery_date, launch_date, requested_at, transfer_date"),
        dateFrom: z.string().optional().describe("시작일 yyyy-mm-dd (이상). 단일 일자면 from=to"),
        dateTo: z.string().optional().describe("종료일 yyyy-mm-dd (이하)"),
      },
      async ({ view, work, limit, filterField, filterOp, filterValue, distinct, dateField, dateFrom, dateTo }) => {
        try {
          const where = filterField ? { field: filterField, op: filterOp ?? "empty", value: filterValue ?? "" } : null;
          const dateRange = dateField ? { field: dateField, from: dateFrom ?? null, to: dateTo ?? null } : null;
          const r = await queryView(view, { needle: work ?? null, limit: limit ?? 50, where, dateRange, distinct: distinct ?? null });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "register_translation_monitor",
      "번역검수 완료 모니터링 등록: 중일 작품 1~3화 번역검수(OTC0013) 완료를 감지해 DM으로 알린다. **pivoId만 있으면 즉시 호출**한다 — n8n이 TOTUS에서 마감일을 자동 조회하므로 ★마감일은 절대 사용자에게 묻지 말 것(deadline 비워서 호출). 사용자가 스스로 마감일을 준 경우에만 deadline에 넣는다. 등록되면 마감 D-1부터 폴링→3화 완료 시 AI 검수까지 자동. 보통 '번역 개시 요청' 발송(✅) 시 자동 등록되니 수동('○○ 번역검수 모니터 등록')에만 쓴다. pivoId는 PV- 접두 떼고 숫자만.",
      {
        pivoId:    z.string().describe("PIVO ID(숫자만, 'PV-' 접두 제거)"),
        workTitle: z.string().optional().describe("작품명(라벨용). 생략 시 pivoId"),
        episodes:  z.array(z.number()).optional().describe("모니터링할 화수 (기본 [1,2,3])"),
        deadline:  z.string().optional().describe("★사용자에게 묻지 말 것. n8n이 TOTUS에서 자동 조회. 사용자가 명시적으로 준 경우에만 넣음"),
      },
      async ({ pivoId, workTitle, episodes, deadline }) => {
        try {
          const base = process.env.N8N_WEBHOOK_BASE ?? "http://localhost:5678";
          const url  = `${base}/webhook/translation-monitor-register`;
          const num  = String(pivoId).match(/\d{4,}/)?.[0] || String(pivoId).trim();   // 'PV-201454' → '201454'
          const body = {
            pivoId:      num,
            workTitle:   workTitle ?? num,
            episodes:    episodes ?? [1, 2, 3],
            slackUserId: process.env.DISPATCHER_USER_ID ?? "U04463JR4HH",
            ...(deadline ? { deadline } : {}),   // 있으면 전달, 없으면 n8n이 자동 계산
          };
          const r = await fetch(url, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(body),
            signal:  AbortSignal.timeout(10000),
          });
          if (!r.ok) {
            const t = await r.text();
            throw new Error(`n8n 응답 ${r.status}: ${t.slice(0, 200)}`);
          }
          const resp = await r.json().catch(() => ({}));
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, registered: { pivoId: num, workTitle: workTitle ?? num, episodes: episodes ?? [1, 2, 3], deadline: deadline || "(n8n 자동)" }, result: resp }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      }
    ),
    tool(
      "propose_delivery_edit",
      "납품 시트 납품일(G열)을 변경/삭제한다. ★재상 님 요청으로 확인 버튼 없이 즉시 반영(2026-07-01) 후 결과를 한 번에 요약 보고. ★회차마다 날짜가 다르면 절대 여러 번 호출하지 말고 changes 배열에 전부 담아 **한 번에** 호출(같은 날짜 회차는 episode+new_date로도 됨). new_date에 날짜면 변경, '삭제'(또는 빈 문자열)면 납품일을 지운다(빈칸). episode는 단일('5')·범위('1-20')·목록('1,3,5')·혼합('1-5,9') 가능. 변경 후 '완료'로 보고(단정해도 됨).",
      {
        work: z.string().describe("작품명(한/일/중 무엇이든)"),
        episode: z.string().optional().describe("같은 날짜로 바꿀 회차. 단일('5'), 범위('1-20'), 목록('1,3,5'), 혼합('1-5,9'). changes를 쓸 땐 생략."),
        new_date: z.string().optional().describe("episode에 적용할 새 납품일 yyyy-mm-dd. '지우기/삭제'면 '삭제' 또는 빈 문자열. changes를 쓸 땐 생략."),
        changes: z.array(z.object({ episode: z.string(), new_date: z.string() })).optional().describe("회차별로 날짜가 다를 때 전부 한 번에. 예: [{episode:'15',new_date:'2026-07-06'},{episode:'23-24',new_date:'2026-07-20'}]. new_date에 '삭제'/'' 도 됨. 이걸 쓰면 episode/new_date는 무시. 회차 겹치면 뒤가 이김."),
        lang: z.enum(["zh-ja", "ko-ja"]).optional().describe("중일=zh-ja(기본), 한일=ko-ja"),
      },
      async ({ work, episode, new_date, changes, lang }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const tasks = (Array.isArray(changes) && changes.length) ? changes : (episode && new_date != null ? [{ episode, new_date }] : []);
          if (!tasks.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: "회차·날짜가 없음. episode+new_date 또는 changes 배열이 필요." }) }] };
          const CLEAR_RE = /^(삭제|지움|지워|지우기|비우기|비움|없음|빈칸|clear|none|empty)$/i;
          const epVal = new Map();   // episode → { value, shown } (뒤에 온 게 이김)
          for (const t of tasks) {
            const raw = String(t.new_date ?? "").trim();
            const clearing = !raw || CLEAR_RE.test(raw);
            const value = clearing ? "" : raw;
            const shown = clearing ? "(삭제·빈칸)" : raw;
            for (const ep of parseEpisodeSpec(t.episode)) epVal.set(ep, { value, shown });
          }
          const eps = [...epVal.keys()];
          if (!eps.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: "회차를 못 읽음. 예: 5 / 1-20 / 1,3,5" }) }] };
          const r = await resolveDeliveryCells({ work, episodes: eps, lang: lang ?? "zh-ja" });
          if (!r.found.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' ${compactRanges(eps.sort((a, b) => a - b))}화를 납품 시트에서 못 찾음. 작품명/회차 확인 필요.` }) }] };
          const updates = r.found.map((f) => ({ a1: f.cellA1, value: epVal.get(f.episode).value, episode: f.episode, old: f.currentDate }));
          await setCells(r.sheetId, updates.map((u) => ({ a1: u.a1, value: u.value })));
          for (const u of updates) appendFileSync("logs/edits.jsonl", JSON.stringify({ at: new Date().toISOString(), user: DISPATCHER_USER_ID, cell: u.a1, work: r.workName, episode: u.episode, from: u.old, to: u.value, clearing: u.value === "" }) + "\n");
          const groups = {};   // 표시값(날짜/삭제)별 회차 묶기(보고용)
          for (const f of r.found) { const s = epVal.get(f.episode).shown; (groups[s] ||= []).push(f.episode); }
          const changed = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([s, e]) => `${compactRanges(e.sort((x, y) => x - y))}화 → ${s}`);
          return { content: [{ type: "text", text: JSON.stringify({ applied: true, workName: r.workName, changed, count: r.found.length, missing: r.missing, note: "이미 시트에 반영됨(확인 불필요). changed를 한 번에 담백하게 완료 보고. 못 찾은 회차(missing)만 따로 짧게 알려라." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) + " (SA가 해당 시트 편집자인지 확인 필요)" }) }] };
        }
      },
    ),
    tool(
      "propose_totus_delivery_edit",
      "TOTUS 시스템(어드민/카카오픽코마)의 실제 납품예정일(deliveryDate)을 변경한다. 내부 납품관리시트 G열(propose_delivery_edit)과는 다른, 진짜 TOTUS 납품예정일이며 변경 시 PIVO에도 자동 반영된다. ★재상 님 요청으로 확인 버튼 없이 즉시 변경(2026-07-01) — 호출하면 바로 반영되고 결과를 한 번에 요약 보고한다. ★회차마다 날짜가 다르면 절대 여러 번 호출하지 말고 changes 배열에 전부 담아 **한 번에** 호출할 것(같은 날짜 회차는 episode+new_date로도 됨). episode는 단일('5')·범위('1-20')·목록('1,3,5') 가능. 변경 후 '완료'로 보고(단정해도 됨).",
      {
        work: z.string().describe("작품명(한/일/중) 또는 PIVO ID"),
        episode: z.string().optional().describe("같은 날짜로 바꿀 회차. 단일('5'), 범위('1-20'), 목록('1,3,5'). changes를 쓸 땐 생략."),
        new_date: z.string().optional().describe("episode에 적용할 새 납품예정일 YYYY-MM-DD. changes를 쓸 땐 생략."),
        changes: z.array(z.object({ episode: z.string(), new_date: z.string() })).optional().describe("회차별로 날짜가 다를 때 전부 한 번에. 예: [{episode:'15',new_date:'2026-07-06'},{episode:'22',new_date:'2026-07-13'},{episode:'23-24',new_date:'2026-07-20'}]. 이걸 쓰면 episode/new_date는 무시. 회차가 겹치면 뒤에 온 날짜가 이긴다."),
        reason: z.enum(["RETAKE", "CUSTOMER_REQUEST", "INTERNAL_REQUEST", "ETC"]).optional().describe("변경 사유(기본 CUSTOMER_REQUEST)"),
      },
      async ({ work, episode, new_date, changes, reason }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const tasks = (Array.isArray(changes) && changes.length) ? changes : (episode && new_date ? [{ episode, new_date }] : []);
          if (!tasks.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: "회차·날짜가 없음. episode+new_date 또는 changes 배열이 필요." }) }] };
          const bad = tasks.find((t) => !/^\d{4}-\d{2}-\d{2}$/.test(String(t.new_date || "").trim()));
          if (bad) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `날짜 형식 오류: '${bad.new_date}'. YYYY-MM-DD 필요.` }) }] };
          const fp = await findProject(work);
          const proj = (fp?.data || [])[0];
          if (!proj?.uuid) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음. 작품명 표기 확인 필요.` }) }] };
          const jp = await jobProcesses(proj.uuid);
          const all = (jp?.data || []).flatMap((o) => o.JOB목록 || []);
          const projName = String(proj.프로젝트 || work).replace(/\[[^\]]*\]\s*/g, "").trim();
          const items = new Map();  // episode → {jobProcessUuid, episode, currentDate, deliveryDate} (뒤에 온 게 이김)
          const missing = new Set(), ambiguous = new Set();
          for (const t of tasks) {
            const date = String(t.new_date).trim();
            for (const ep of parseEpisodeSpec(t.episode)) {
              const m = all.filter((x) => Number(x.작업단위번호) === ep);
              if (!m.length) missing.add(ep);
              else if (m.length > 1) ambiguous.add(ep);
              else items.set(ep, { jobProcessUuid: m[0].jobProcessUuid, episode: ep, currentDate: m[0].납품예정일 ? new Date(new Date(m[0].납품예정일).getTime() - 1000).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }) : null, deliveryDate: date });
            }
          }
          const list = [...items.values()].sort((a, b) => a.episode - b.episode);
          const miss = [...missing].sort((a, b) => a - b), amb = [...ambiguous].sort((a, b) => a - b);
          if (!list.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `${projName}에서 변경 가능한 회차를 못 찾음(못 찾음 ${compactRanges(miss) || "-"}, 복수후보 ${compactRanges(amb) || "-"}). 회차 확인 필요.`, missing: miss, ambiguous: amb }) }] };
          const rsn = reason || "CUSTOMER_REQUEST";
          const res = await setDeliveryDate(list.map((it) => ({ jobProcessUuid: it.jobProcessUuid, deliveryDate: it.deliveryDate, modificationReason: rsn })), false);
          appendFileSync("logs/totus-dates.jsonl", JSON.stringify({ at: new Date().toISOString(), user: DISPATCHER_USER_ID, work: projName, items: list.map((it) => ({ episode: it.episode, to: it.deliveryDate })), reason: rsn, ok: res?.success, resp: res?.data }) + "\n");
          const groups = {};  // 날짜별 회차 묶기(보고용)
          for (const it of list) (groups[it.deliveryDate] ||= []).push(it.episode);
          const changed = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([d, eps]) => `${compactRanges(eps.sort((x, y) => x - y))}화 → ${d}`);
          const failed = res?.data?.failedJobProcessUuids || [];
          if (!res?.success || failed.length) {
            return { content: [{ type: "text", text: JSON.stringify({ applied: false, work: projName, changed, count: list.length, failedCount: failed.length || undefined, missing: miss, ambiguous: amb, note: "변경 실패 또는 일부 실패. 실패/못 찾은 회차를 사용자에게 알려라." }) }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ applied: true, work: projName, changed, count: list.length, missing: miss, ambiguous: amb, note: "이미 변경 완료됨(확인 불필요, PIVO 자동 반영). changed를 한 번에 담백하게 '변경 완료'로 보고. missing/ambiguous 있으면 그 회차만 따로 짧게 알려라." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
    ),
    tool(
      "totus_delivery_date",
      "TOTUS 시스템의 실제 납품예정일(JobProcess deliveryDate)을 조회한다. 작품·회차로 job-processes의 '납품예정일' 필드(jobProcessUuid 단위)를 읽음 — 변경(propose_totus_delivery_edit)과 같은 값. 'TOTUS 납품예정일'·'실제 시스템 납품일' 물으면 이걸 써라. 내부 시트 납품일은 get_delivery_date, 오퍼레이션(PIVO검수) 마감일은 totus_jobs로 별개.",
      { work: z.string().describe("작품명(한/일/중) 또는 PIVO ID"), episode: z.string().optional().describe("회차 숫자. 생략 시 납품예정일 set된 회차 전체") },
      async ({ work, episode }) => {
        try {
          const fp = await findProject(work);
          const proj = (fp?.data || [])[0];
          if (!proj?.uuid) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음.` }) }] };
          const jp = await jobProcesses(proj.uuid);
          const items = (jp?.data || []).flatMap((o) => o.JOB목록 || []);
          // 납품예정일 = "M/D 23:59:59 KST" 관례 → −1초 후 KST 날짜로 정규화(자정 00:00 저장분을 전날 마감으로). raw UTC slice는 오전 시각서 깨짐.
          const fmt = (iso) => (iso ? new Date(new Date(iso).getTime() - 1000).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }) : null);
          const projName = String(proj.프로젝트 || work).replace(/\[[^\]]*\]\s*/g, "").trim();
          if (episode != null && episode !== "") {
            const ep = Number(episode);
            const m = items.filter((x) => Number(x.작업단위번호) === ep);
            if (!m.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, work: projName, msg: `${episode}화를 못 찾음.` }) }] };
            return { content: [{ type: "text", text: JSON.stringify({ work: projName, episode, 납품예정일: fmt(m[0].납품예정일) ?? "미설정", jobProcessUuid: m[0].jobProcessUuid }) }] };
          }
          const setOnes = items.filter((x) => x.납품예정일).map((x) => ({ episode: x.작업단위번호, 납품예정일: fmt(x.납품예정일) })).sort((a, b) => a.episode - b.episode);
          return { content: [{ type: "text", text: capJson({ work: projName, 납품예정일있는회차: setOnes.length, items: setOnes }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool("totus_quotation", "TOTUS 견적 조회: PIVO ID로 projectUuid·납품목표일·총작업량·견적특이사항·작업특이사항. 작품 진행/일정 조회의 출발점(여기서 projectUuid 확보).",
      { pivoId: z.string().describe("PIVO ID 숫자") },
      totusTool((a) => quotationByPivo(a.pivoId)), { annotations: { readOnlyHint: true } }),
    tool("totus_find_project", "TOTUS 프로젝트 검색: 작품명 키워드로 projectUuid·고객사·담당PM. PIVO ID 없을 때 uuid 확보용.",
      { name: z.string().describe("작품명 키워드(한/일/중)") },
      totusTool((a) => findProject(a.name)), { annotations: { readOnlyHint: true } }),
    tool("totus_schedule_summary", "TOTUS 프로젝트 일정 요약: 공정(오퍼레이션)별 전체/완료/진행/대기/지연/임박 집계. '이 작품 일정 지연·임박' 류.",
      { projectUuid: z.string().describe("프로젝트 UUID (totus_quotation/find_project로 확보)") },
      totusTool((a) => scheduleSummary(a.projectUuid)), { annotations: { readOnlyHint: true } }),
    tool("totus_jobs", "TOTUS JOB→Operation→Task 구조: 회차별 작업·작업자·상태. episode로 특정 회차만. ★식자검수까지만 보여주고 후공정(납품검수·PIVO 납품검수·고객검수·최종검수)은 제외함.",
      { projectUuid: z.string(), episode: z.string().optional().describe("회차 숫자(생략 시 전체)") },
      totusTool((a) => projectJobs(a.projectUuid, a.episode).then(trimJobsAtSikja)), { annotations: { readOnlyHint: true } }),
    tool("totus_tasks", "TOTUS Task 목록(필터): 상태/오퍼레이션유형/JOB 등으로 조회. 결과 많으면 size로 제한.",
      { projectUuid: z.string().optional(), jobUuids: z.string().optional().describe("JOB UUID(쉼표구분)"), state: z.string().optional().describe("READY/PROCESSING/COMPLETED/CONFIRMED/DROP 등"), operationTypeCode: z.string().optional().describe("OTC0012 번역·OTC0014 식자 등"), size: z.number().optional() },
      totusTool((a) => taskList(a)), { annotations: { readOnlyHint: true } }),
    tool("totus_task", "TOTUS Task 단건 상세: 상태/일정/작업자/단가/납품 등.",
      { taskUuid: z.string() },
      totusTool((a) => taskDetail(a.taskUuid)), { annotations: { readOnlyHint: true } }),
    tool("totus_translation_text", "TOTUS 원문↔번역문 텍스트 쌍(Task 기준). 양이 많으니 필요한 Task에만.",
      { taskUuid: z.string() },
      totusTool((a) => translationText(a.taskUuid)), { annotations: { readOnlyHint: true } }),
    tool(
      "get_editor_url",
      "회차+오퍼레이션명으로 TOTUS 에디터 URL을 준다(태스크 상태 무관, 가장 최신 task 기준 — 리테이크 있으면 최신본). 오퍼레이션명=번역·번역검수·식자·식자검수·식자번역검수·납품검수 등. 작품·회차로 JOB을 찾아 해당 오퍼레이션 태스크의 에디터 링크(main.totus.pro/ko/editor?uuid=) 반환.",
      { work: z.string().describe("작품명(한/일/중) 또는 PIVO ID"), episode: z.string().describe("회차 숫자"), operation: z.string().describe("오퍼레이션명(번역·식자·식자검수 등) 또는 OTC코드") },
      async ({ work, episode, operation }) => {
        try {
          const fp = await findProject(work);
          const candidates = fp?.data || [];
          if (!candidates.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음.` }) }] };
          const proj = pickPivoTagged(candidates);
          if (!proj) return { content: [{ type: "text", text: JSON.stringify({ ambiguous: true, msg: `'${work}'로 동일/유사 이름 프로젝트가 ${candidates.length}건 검색되고 [PV-정식표기]로도 하나로 안 좁혀짐. 후보 중 골라달라고 하라.`, candidates: candidates.map((p) => ({ name: p.프로젝트, uuid: p.uuid })) }) }] };
          const projName = String(proj.프로젝트 || work).replace(/\[[^\]]*\]\s*/g, "").trim();
          let jobs = (await projectJobs(proj.uuid, episode))?.data || [];
          if (!jobs.length) {   // episode 필터 0건(구작) → JOB명 회차 매칭 폴백 (review.js와 동일)
            const n = parseInt(episode, 10); const re = new RegExp(`(?:第|-)0*${n}(?:\\D|$)`);
            jobs = ((await projectJobs(proj.uuid))?.data || []).filter((x) => re.test((x.JOB명 || "").trim()));
          }
          const tasks = jobs.flatMap((j) => (j.오퍼레이션 || []).flatMap((op) => op.태스크 || []));
          const qn = String(operation).replace(/\s/g, ""); const qc = qn.toUpperCase();
          const nmOf = (t) => String(t.오퍼레이션유형명 || "").replace(/\s/g, "");
          const cdOf = (t) => String(t.오퍼레이션유형 || "").toUpperCase();
          let match = tasks.filter((t) => nmOf(t) === qn || cdOf(t) === qc);   // 정확 일치 우선('번역'이 번역검수/식자번역검수에 안 걸리게)
          if (!match.length) match = tasks.filter((t) => { const nm = nmOf(t); return (nm && (nm.includes(qn) || qn.includes(nm))) || cdOf(t).includes(qc); });   // 폴백: 부분 일치
          if (!match.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, work: projName, msg: `${episode}화에 '${operation}' 오퍼레이션 task 없음.`, 가능한오퍼레이션: [...new Set(tasks.map((t) => t.오퍼레이션유형명).filter(Boolean))] }) }] };
          match.sort((a, b) => String(b.시작일원본 || b.마감일원본 || "").localeCompare(String(a.시작일원본 || a.마감일원본 || "")));   // 최신 우선(시작일 desc)
          const t = match[0];
          return { content: [{ type: "text", text: JSON.stringify({ work: projName, episode, operation: t.오퍼레이션유형명, 상태: t.상태명 || t.상태, taskUuid: t.uuid, url: `https://main.totus.pro/ko/editor?uuid=${t.uuid}`, task수: match.length }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "propose_task_retake",
      "TOTUS에서 회차(들)의 특정 오퍼레이션 태스크를 '리테이크'(연결 태스크 생성)하도록 제안한다(게이트형: 미리보기+✅버튼). 대상 태스크는 COMPLETED 상태여야 하며, 실행하면 그 태스크+하위(다음 단계) 오퍼레이션 태스크가 전부 새로 생성되고(작업자·타입은 원본 승계) 기존 READY/PROCESSING 하위 태스크는 닫힌다(COMPLETED 하위는 유지). 새로 생성된 태스크들에는 일정(시작일~마감일)도 같이 입력된다 — 지정 안 하면 기본값은 오늘 시작·오늘 마감(당일), 사용자가 날짜를 말하면 그 기간으로. '○○ 1-20화 [오퍼레이션] task 열어줘/리테이크해줘' 류. 여러 회차는 episode에 범위/목록으로 한 번에 담아라(회차마다 도구를 나눠 부르지 말 것). COMPLETED가 아닌 회차는 자동으로 제외되고 미리보기에 표시된다. 절대 '열었다/리테이크했다'고 단정하지 말 것(버튼 눌러야 실행).",
      {
        work: z.string().describe("작품명(한/일/중) 또는 PIVO ID"),
        episode: z.string().describe("회차. 단일('5'), 범위('1-20'), 목록('1,3,5') 가능 — 여러 회차는 반드시 이렇게 한 번에 담는다"),
        operation: z.string().describe("오퍼레이션명(번역·번역검수·식자·식자검수·식자번역검수·납품검수 등) 또는 OTC코드"),
        startDate: z.string().optional().describe("새로 생성될 태스크들의 시작일(YYYY-MM-DD). 생략하면 오늘(KST)"),
        endDate: z.string().optional().describe("새로 생성될 태스크들의 마감일(YYYY-MM-DD). 생략하면 오늘(KST, startDate만 준 경우도 동일)"),
      },
      async ({ work, episode, operation, startDate, endDate }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const ctx = currentCtx;
          const fp = await findProject(work);
          const candidates = fp?.data || [];
          if (!candidates.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음.` }) }] };
          const proj = pickPivoTagged(candidates);
          if (!proj) return { content: [{ type: "text", text: JSON.stringify({ ambiguous: true, msg: `'${work}'로 동일/유사 이름 프로젝트가 여럿 검색됨. PIVO ID로 다시 확인하라.`, candidates: candidates.map((p) => ({ name: p.프로젝트, uuid: p.uuid })) }) }] };
          const projName = String(proj.프로젝트 || work).replace(/\[[^\]]*\]\s*/g, "").trim();
          const episodes = parseEpisodeSpec(episode);
          if (!episodes.length) return { content: [{ type: "text", text: JSON.stringify({ error: `회차 해석 실패: '${episode}'` }) }] };

          const qn = String(operation).replace(/\s/g, ""); const qc = qn.toUpperCase();
          const nmOf = (t) => String(t.오퍼레이션유형명 || "").replace(/\s/g, "");
          const cdOf = (t) => String(t.오퍼레이션유형 || "").toUpperCase();

          const items = [];
          const notFound = [];
          for (const ep of episodes) {
            let jobs = (await projectJobs(proj.uuid, ep))?.data || [];
            if (!jobs.length) {
              const re = new RegExp(`(?:第|-)0*${ep}(?:\\D|$)`);
              jobs = ((await projectJobs(proj.uuid))?.data || []).filter((x) => re.test((x.JOB명 || "").trim()));
            }
            const tasks = jobs.flatMap((j) => (j.오퍼레이션 || []).flatMap((op) => op.태스크 || []));
            let match = tasks.filter((t) => nmOf(t) === qn || cdOf(t) === qc);
            if (!match.length) match = tasks.filter((t) => { const nm = nmOf(t); return (nm && (nm.includes(qn) || qn.includes(nm))) || cdOf(t).includes(qc); });
            if (!match.length) { notFound.push(ep); continue; }
            match.sort((a, b) => String(b.시작일원본 || b.마감일원본 || "").localeCompare(String(a.시작일원본 || a.마감일원본 || "")));
            const t = match[0];
            items.push({ episode: ep, taskUuid: t.uuid, status: t.상태, statusName: t.상태명 || t.상태, operationName: t.오퍼레이션유형명 });
          }
          if (!items.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, work: projName, msg: `지정 회차 전부 '${operation}' 태스크를 못 찾음.`, notFound }) }] };

          const ready = items.filter((it) => it.status === "COMPLETED");
          const notCompleted = items.filter((it) => it.status !== "COMPLETED");
          if (!ready.length) return { content: [{ type: "text", text: JSON.stringify({ found: true, work: projName, msg: "매칭된 태스크가 있지만 전부 COMPLETED가 아니라 리테이크 불가.", notCompleted, notFound }) }] };

          const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
          const sDate = (startDate || "").trim() || todayKST;
          const eDate = (endDate || "").trim() || sDate || todayKST;

          const trId = `tr_${++taskRetakeSeq}`;
          const p = { work: projName, operation: ready[0]?.operationName || operation, items: ready, startDate: sDate, endDate: eDate, createdAt: Date.now() };
          pendingTaskRetake.set(trId, p);
          if (ctx?.client && ctx?.channel) {
            const lines = [
              `🔁 *TOTUS 태스크 리테이크 제안* — ${projName} (${p.operation})`,
              `대상 ${ready.length}건(회차: ${compactRanges(ready.map((r) => r.episode))})`,
              `새 태스크 일정: ${sDate}${eDate !== sDate ? `~${eDate}` : "(당일)"}`,
              notCompleted.length ? `⚠️ COMPLETED 아니라 제외됨(${notCompleted.length}건): ${notCompleted.map((n) => `${n.episode}화(${n.statusName})`).join(", ")}` : "",
              notFound.length ? `⚠️ 태스크 자체를 못 찾음: ${notFound.join(", ")}화` : "",
              "실행하면 각 태스크+하위 오퍼레이션이 새로 생성되고, 기존 진행중 하위 태스크는 닫힙니다(완료된 건 유지).",
            ].filter(Boolean).join("\n");
            const posted = await ctx.client.chat.postMessage({
              channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: `태스크 리테이크 확인: ${projName} ${p.operation}`,
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: lines } },
                { type: "actions", elements: [
                  { type: "button", style: "primary", text: { type: "plain_text", text: `🔁 ${ready.length}건 리테이크` }, value: trId, action_id: "task_retake_confirm" },
                  { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: trId, action_id: "task_retake_cancel" },
                ] },
              ],
            });
            p.previewChannel = posted.channel; p.previewTs = posted.ts; pendingTaskRetake.save();
          }
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, work: projName, operation: p.operation, targetCount: ready.length, schedule: { startDate: sDate, endDate: eDate }, notCompleted, notFound, note: "확인 버튼을 보냈음. 재상 님이 버튼을 눌러야 실제 리테이크 실행됨. '열었다'고 단정하지 말 것." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      "get_project_url",
      "작품의 TOTUS 작업진행관리 프로젝트 링크(admin.totus.pro/ko/workProgressManagementDetail/?id={projectUuid})를 준다. 작품 단위 페이지(회차 전체 포함)라 회차 불필요. '프로젝트 링크/작업진행 페이지/TOTUS 작품 링크' 요청에 쓴다.",
      { work: z.string().describe("작품명(한/일/중) 또는 PIVO ID") },
      async ({ work }) => {
        try {
          const fp = await findProject(work);
          const candidates = fp?.data || [];
          if (!candidates.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음.` }) }] };
          const proj = pickPivoTagged(candidates);
          if (!proj) return { content: [{ type: "text", text: JSON.stringify({ ambiguous: true, msg: `'${work}'로 동일/유사 이름 프로젝트가 ${candidates.length}건 검색되고 [PV-정식표기]로도 하나로 안 좁혀짐. 후보 중 골라달라고 하라.`, candidates: candidates.map((p) => ({ name: p.프로젝트, uuid: p.uuid })) }) }] };
          const projName = String(proj.프로젝트 || work).replace(/\[[^\]]*\]\s*/g, "").trim();
          return { content: [{ type: "text", text: JSON.stringify({ work: projName, projectUuid: proj.uuid, url: `https://admin.totus.pro/ko/workProgressManagementDetail/?id=${proj.uuid}` }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "get_source_files",
      "작품·회차의 원본(소스) 파일 목록 + 직접 다운로드 링크를 준다. TOTUS 소스그룹(delivery-source-groups)에서 가져오며, 출판사 외부 드라이브가 아니라 cf.totus.pro 서명 URL이라 로그인 없이 바로 다운로드된다. '원본 파일/다운로드/원고 파일' 요청에 쓴다. page를 주면 특정 페이지(파일명 끝 번호, 예 48-2.psd=2)만 거른다('2페이지만', '3,4페이지'). (출판사 드라이브 링크는 별개 — get_work_info)",
      { work: z.string().describe("작품명(한/일/중) 또는 PIVO ID"), episode: z.string().describe("회차 숫자(콤마로 복수 가능: 1,2,3)"), page: z.string().optional().describe("특정 페이지만(파일명 끝 번호). 콤마 복수 가능 '2' 또는 '3,4'. 생략 시 회차 전체 파일") },
      async ({ work, episode, page }) => {
        try {
          const r = await sourceFilesFor(work, episode, page);
          if (!r.found) return { content: [{ type: "text", text: JSON.stringify(r) }] };
          return { content: [{ type: "text", text: capJson({ ...r, note: "★출력은 slackLinks 문자열을 그대로 한 줄로 붙여라(각 파일이 파일명 라벨의 클릭 링크). raw url을 파일마다 나열하지 말 것. 다운로드URL은 서명 직접 링크(로그인 불필요·일정 시간 후 만료)." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool("review_episode",
      "웹툰 번역 검수: 작품명+회차(또는 PIVO ID+회차)로 식자번역검수(없으면 번역검수/번역) 텍스트를 추출해 돌려준다. ★PIVO ID를 알면(맥락에 'NNNNNN | ...' 또는 재상 님이 PIVO를 준 경우) work 대신 pivo에 넣어라 — 그러면 납품시트를 안 거치고 TOTUS로 바로 해석해 납품시트 미등록 작품도 검수된다. 작품명만 있으면 납품탭에서 PIVO를 찾는다(한일 lang 'ko-ja' 기본, 중일 'zh-ja'; pivo를 주면 lang 무관). 돌려받은 [검수 기준]대로 pairs를 2패스 검수해 문제 있는 항목만 [출력 템플릿]으로 작성한다. 결과에 error가 있으면 그 메시지를 그대로 전한다.",
      {
        work: z.string().optional().describe("작품명(한국어, [출판사] 접두사 없어도 됨). pivo를 주면 생략 가능"),
        pivo: z.string().optional().describe("PIVO ID(예 196833). 주면 납품시트 안 거치고 TOTUS로 바로 검수 — 맥락에 PIVO가 있으면 이걸 우선 사용"),
        episode: z.string().describe("회차 숫자"),
        lang: z.enum(["ko-ja", "zh-ja"]).optional().describe("ko-ja=한일(기본), zh-ja=중일. pivo 지정 시 무관"),
        stage: z.enum(["식자번역검수", "번역검수", "번역"]).optional().describe("검수 대상 단계. 생략 시 텍스트 있는 마지막 단계 자동(식자번역검수>번역검수>번역)"),
      },
      async (a) => {
        console.log(`[review] 추출 시작: ${a.pivo ? "PIVO " + a.pivo : a.work} ${a.episode}화 (lang=${a.lang ?? "ko-ja"}${a.stage ? ", " + a.stage : ""})`);
        try {
          const r = await extractEpisode({ work: a.work, episode: a.episode, lang: a.lang ?? "ko-ja", stage: a.stage ?? null, pivo: a.pivo ?? null });
          if (r.error) {
            console.log(`[review] 추출 실패: ${a.work} ${a.episode}화 — ${r.error}`);
            return { content: [{ type: "text", text: JSON.stringify(r) }] };
          }
          console.log(`[review] 추출 완료: ${r.work} ${r.episode}화 ${r.stage} ${r.count}건`);
          // 진행 표시: 추출 끝나면 부른 자리(스레드/DM)에 즉시 알림(검수는 시간이 걸리니 살아있다는 신호)
          await notifyHere(`🔎 ${r.work} ${r.episode}화 — ${r.stage} ${r.count}건 추출 완료, 검수 중…`).catch(() => {});
          return { content: [{ type: "text", text: QA_INSTRUCTIONS + "\n\n[추출 결과]\n" + JSON.stringify(r) }] };
        } catch (e) {
          console.log(`[review] 오류: ${a.work} ${a.episode}화 — ${e?.message ?? e}`);
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }),
    tool("review_queue",
      "번역 검수 요청을 **검수 워커 풀**에 넘긴다(1작품이든 여러 작품이든 검수는 전부 이걸로). 워커 여러 개가 **병렬**로 검수해 끝나는 대로 각 결과를 이 스레드/DM에 직접 올린다 — 등록만 하고 즉시 반환하므로 메인 대화가 안 막힌다(무거운 검수를 브레인 밖으로 분리). works=검수할 [{work 또는 pivo, episode, lang?}] 목록(사용자/스레드에서 순서대로 파싱). 절대 직접 review_episode를 호출해 검수하지 말고 이걸로 큐잉하라.",
      {
        works: z.array(z.object({
          work: z.string().optional().describe("작품명(한국어). pivo를 주면 생략 가능"),
          pivo: z.string().optional().describe("PIVO ID(예 196833). 맥락에 PIVO가 있으면 이걸 넣어라 — 납품시트 안 거치고 TOTUS로 바로 검수"),
          episode: z.string().describe("회차 숫자"),
          lang: z.enum(["ko-ja", "zh-ja"]).optional().describe("ko-ja=한일, zh-ja=중일. pivo 지정 시 무관"),
        })).describe("검수할 작품·회차 목록(처리 순서대로)"),
      },
      async ({ works }) => {
        try {
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "맥락을 못 잡음." }) }] };
          const list = (works || []).filter((w) => (w?.work || w?.pivo) && String(w.episode ?? "").trim());
          if (!list.length) return { content: [{ type: "text", text: JSON.stringify({ error: "검수할 작품 목록(works)이 비었음. 작품명(또는 PIVO)·회차를 파싱해 넘겨라." }) }] };
          ensureWorkers();
          // 검수는 워커 풀(동시 WORKER_COUNT개)이 처리 — 메인 브레인은 안 막힘. ctx는 잡에 캡처해 그 스레드로 결과 게시.
          const jobCtx = { client: ctx.client, channel: ctx.channel, threadTs: ctx.threadTs, ts: ctx.ts };
          list.forEach((w) => enqueueJob(makeReviewJob({
            work: w.work || null, pivo: w.pivo ? String(w.pivo).trim() : null,
            episode: String(w.episode).trim(), lang: w.lang || "ko-ja", label: w.work || `PV-${w.pivo}`, ctx: jobCtx,
          })));
          return { content: [{ type: "text", text: JSON.stringify({ queued: list.length, workers: WORKER_COUNT, order: list.map((w) => `${w.work || "PV-" + w.pivo} ${w.episode}`), note: `${list.length}작품을 검수 워커 풀(${WORKER_COUNT}개 동시)에 넘겼음 — 병렬로 검수해 끝나는 대로 각 결과를 이 스레드에 워커가 직접 올린다(메인 대화는 안 막힘). 사용자에겐 '${list.length}작품 검수 시작 — 병렬로 돌려서 끝나는 대로 결과 올릴게요'라고만 알리고, 절대 직접 review_episode를 호출하거나 검수하려 들지 말 것.` }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("delegate_analysis",
      "무거운 데이터 분석/분류/요약을 **워커 풀에 넘겨 백그라운드로** 처리한다(메인 대화 안 막힘). 수백~수천 행 분류·요약·인사이트 도출처럼 LLM 판단이 길어지는 작업에 써라. ★쓰는 법: 먼저 read_tab/query_sheet/compute/첨부로 **분석할 데이터를 모아 data에 통째로 넣고**(집계·산수·카운트는 compute로 먼저 끝내 결과만 넣어도 됨), task에 무엇을 도출·어떤 형식으로 낼지 명확히 적는다. 워커가 끝나면 결과를 이 스레드에 직접 올린다 — 등록만 하고 즉시 반환하니 너는 '분석 시작' 한 줄만 알리고 **직접 분석 결과를 만들지 마라**. 짧고 가벼운 조회·집계(즉답 가능)는 이걸 쓰지 말고 그냥 답해라.",
      {
        task: z.string().describe("수행할 분석 지시(무엇을·어떤 형식으로 도출할지 명확히)"),
        data: z.string().optional().describe("분석 대상 데이터(행/CSV/집계결과 등)를 문자열로. 크면 클수록 워커로 미루는 게 이득"),
        title: z.string().optional().describe("작업 라벨(결과 헤더·오류표시용, 예 '리테이크 유형 분류 6월')"),
      },
      async (a) => {
        try {
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "맥락을 못 잡음." }) }] };
          if (!a.task || !a.task.trim()) return { content: [{ type: "text", text: JSON.stringify({ error: "task(분석 지시)가 비었음." }) }] };
          ensureWorkers();
          const jobCtx = { client: ctx.client, channel: ctx.channel, threadTs: ctx.threadTs, ts: ctx.ts };
          const label = (a.title && a.title.trim()) || "데이터 분석";
          enqueueJob({ label, ctx: jobCtx, run: async () => {
            const prompt = `[백그라운드 분석 작업: ${label}]\n${a.task}`
              + (a.data ? `\n\n[분석 대상 데이터]\n${a.data}` : "")
              + `\n\n위 작업을 수행해 **결과만 간결히** 작성하라(이 텍스트가 슬랙에 그대로 올라간다 — 군더더기·과한 서론 금지).`;
            return (await toollessQuery(prompt, { label: `분석 ${label}`, channel: jobCtx.channel })) || `${label}: (결과 없음)`;
          } });
          return { content: [{ type: "text", text: JSON.stringify({ queued: true, label, workers: WORKER_COUNT, note: `'${label}'을 분석 워커 풀에 넘겼음 — 끝나는 대로 워커가 이 스레드에 결과를 직접 올린다(메인 대화 안 막힘). 사용자에겐 '${label} 분석 시작 — 끝나면 결과 올릴게요' 한 줄만 알리고, 직접 분석 결과를 만들지 말 것.` }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("export_csv",
      "정제한 데이터를 CSV로 내보낸다 — 대용량 DB(시트·TOTUS) 데이터를 **클로드 앱에 붙여넣기/드래그**해서 심층 분석하기 좋게 준다. ★쓰는 법: read_tab/query_sheet/totus_*로 데이터를 확보하고 compute로 **필요한 열만·집계·중복제거**해 CSV 문자열을 만든 뒤 csv에 넣어라. 작으면 복붙용 코드블록, 크면 .csv 파일로 자동 업로드한다. comment에 눈에 띄는 패턴·이상치를 한두 줄 덧붙여도 됨. ★대용량 심층 분석 요청은 무거운 반복 분석을 봇이 직접 붙들지 말고, 이걸로 정제 데이터를 내주고 '깊은 분석은 클로드 앱에서' 안내하라(툰식이=추출·정제, 앱=심층분석).",
      {
        title: z.string().describe("파일명/제목 (예 '6월_중일_리테이크')"),
        csv: z.string().describe("CSV 내용(헤더 포함). read_tab/compute로 만들어 넣어라"),
        comment: z.string().optional().describe("함께 올릴 간단 소견/안내 한두 줄(선택)"),
      },
      async (a) => {
        try {
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "맥락을 못 잡음." }) }] };
          const csv = String(a.csv || "");
          if (!csv.trim()) return { content: [{ type: "text", text: JSON.stringify({ error: "csv 내용이 비었음." }) }] };
          const title = (a.title || "export").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
          const note = a.comment ? String(a.comment).trim() : "";
          const rows = csv.split(/\r?\n/).filter((l) => l.trim()).length;
          const thread_ts = ctx.threadTs || ctx.ts;
          if (csv.length <= 6000) {
            const text = `${note ? note + "\n\n" : ""}📄 *${title}* (${rows}행) — 복사해서 클로드 앱에 붙여 분석하세요\n\`\`\`\n${csv}\n\`\`\``;
            await ctx.client.chat.postMessage({ channel: ctx.channel, thread_ts, text, ...SENDER });
            return { content: [{ type: "text", text: JSON.stringify({ delivered: "codeblock", rows, chars: csv.length, note: "코드블록으로 게시함. 사용자에겐 '정제 CSV 올렸어요 — 클로드 앱에 붙여 분석하세요' 정도만 알리고 결과를 재작성하지 말 것." }) }] };
          }
          const initial = `📄 ${title}.csv (${rows}행) — 다운로드해 클로드 앱에 드래그하면 심층 분석할 수 있어요${note ? "\n\n" + note : ""}`;
          await ctx.client.files.uploadV2({ channel_id: ctx.channel, thread_ts, initial_comment: initial, file_uploads: [{ file: Buffer.from(csv, "utf8"), filename: `${title}.csv` }] });
          return { content: [{ type: "text", text: JSON.stringify({ delivered: "file", rows, chars: csv.length, note: "CSV 파일로 업로드함. 사용자에겐 '정제 CSV 파일 올렸어요 — 클로드 앱에 드래그해 분석하세요' 정도만 알리고 결과를 재작성하지 말 것." }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("export_translation_text_range",
      "회차 범위(예 1~20화)의 번역 텍스트(원문↔번역)를 QA 판단 없이 그대로 CSV로 뽑아 파일 업로드한다('텍스트 뽑아줘/추출해줘' 류. 검수·판단이 필요하면 이게 아니라 review_episode/review_queue). ★작품 식별은 PIVO ID(권장, 가장 확실) 또는 TOTUS 프로젝트명과 완전일치하는 표기만 쓴다 — 납품시트 fuzzy(부분일치) 매칭 안 함. 완전일치 안 되면 error+candidates로 후보를 돌려주니 그대로 사용자에게 보여주고 되물어라(임의로 하나 고르지 말 것). 회차별로 텍스트 있는 마지막 단계(식자번역검수>번역검수>번역)를 자동 선택하며, stage로 특정 단계 고정 가능(그 단계 텍스트 없는 회차는 누락 처리). 무거운 작업이라 워커 풀에 넘기고 즉시 반환 — 완료되면 CSV 파일이 이 스레드에 직접 올라간다. 최대 100화.",
      {
        pivo: z.string().optional().describe("PIVO ID(예 185738). 있으면 이걸 우선 사용 — 가장 확실하고 빠름"),
        projectName: z.string().optional().describe("TOTUS 프로젝트명과 완전일치하는 표기(대괄호 태그 포함 원문 또는 태그 제거한 정제 제목 둘 다 가능). 부분일치/유사매칭은 안 됨. pivo 있으면 생략 가능"),
        from: z.string().describe("시작 회차(숫자)"),
        to: z.string().describe("끝 회차(숫자). 1화만 필요하면 from과 동일하게"),
        stage: z.enum(["식자번역검수", "번역검수", "번역"]).optional().describe("고정할 단계. 생략 시 회차별 자동(텍스트 있는 마지막 단계)"),
      },
      async (a) => {
        try {
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "맥락을 못 잡음." }) }] };
          if (!a.pivo && !a.projectName) return { content: [{ type: "text", text: JSON.stringify({ error: "pivo 또는 projectName 중 하나는 필요함." }) }] };
          ensureWorkers();
          const jobCtx = { client: ctx.client, channel: ctx.channel, threadTs: ctx.threadTs, ts: ctx.ts };
          const label = a.projectName || `PV-${a.pivo}`;
          enqueueJob(makeTextExportJob({ pivo: a.pivo || null, projectName: a.projectName || null, from: a.from, to: a.to, stage: a.stage || null, label, ctx: jobCtx }));
          return { content: [{ type: "text", text: JSON.stringify({ queued: true, label, from: a.from, to: a.to, note: `'${label}' ${a.from}~${a.to}화 텍스트 추출을 워커 풀에 넘겼음 — 끝나면 CSV 파일이 이 스레드에 직접 올라간다. 사용자에겐 '추출 시작' 한 줄만 알리고 직접 텍스트를 재작성하거나 pairs를 나열하지 말 것.` }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("find_thread",
      "등록된 주요 업무 채널들에서 작품명/키워드로 스레드를 찾아 내용을 가져온다('A작품 최종 리뷰 스레드 찾아줘', '○○ 관련 스레드' 류). query에 작품명+키워드를 자연어 그대로. 채널을 특정하고 싶으면 channel(이름 일부나 ID). 결과가 1개로 분명하면 그 스레드 내용(topContent)까지 같이 와서 바로 요약·답하면 되고, 여러 개면 후보를 사용자에게 보여주고 어느 건지 고르게 하거나 키워드를 더 좁혀라. 못 찾으면 기간(days)·키워드 조정 안내. (등록 채널·봇 멤버 범위 안에서만 — 전역 슬랙 검색 아님)",
      {
        query: z.string().describe("작품명+키워드(예 '아비스 최종 리뷰', '돈의여신 납품 지연')"),
        channel: z.string().optional().describe("특정 채널만(이름 일부/ID). 생략 시 등록 채널 전체"),
        days: z.number().optional().describe("최근 며칠 내 검색(기본 60). 오래된 스레드면 늘려라"),
      },
      async ({ query, channel, days }) => {
        try {
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "맥락 없음." }) }] };
          if (!SEARCH_CHANNELS.length) return { content: [{ type: "text", text: JSON.stringify({ error: "검색 채널 미등록(.env SEARCH_CHANNELS)." }) }] };
          const matches = await findThreads(ctx.client, query, { channel, days: days || 60 });
          if (!matches.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `등록 채널에서 '${query}' 관련 스레드를 못 찾음. 키워드를 바꾸거나 days를 늘리거나 channel을 지정해봐.`, channels: SEARCH_CHANNELS.map((c) => c.name) }) }] };
          for (const m of matches) { try { const pl = await ctx.client.chat.getPermalink({ channel: m.channelId, message_ts: m.ts }); m.link = pl.permalink; } catch { } }
          let topContent = null;
          const clear = matches.length === 1 || (matches[0].score >= 0.99 && (matches[1]?.score ?? 0) < 0.6);
          if (clear) { const tc = await fetchThreadContext(ctx.client, matches[0].channelId, matches[0].ts); topContent = (tc.text || "").slice(0, 4000); }
          return { content: [{ type: "text", text: JSON.stringify({
            found: true,
            matches: matches.map((m) => ({ channel: m.channelName, link: m.link || "", snippet: m.snippet, replies: m.replyCount, score: +m.score.toFixed(2) })),
            topContent,
            note: topContent ? "최상위 스레드가 분명해 내용(topContent)을 같이 가져옴 — 요약해 답하고 링크 제시. 그 스레드 전체가 더 필요하면 read_thread(link)." : "후보가 여러 개 — 사용자에게 목록(작품/스니펫/링크) 보여주고 어느 스레드인지 고르게 하거나 키워드를 좁혀라. 임의로 단정 금지.",
          }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("read_thread",
      "특정 스레드의 전체 내용을 읽어온다. find_thread가 준 link(또는 슬랙 메시지 permalink/thread_ts)를 넘기면 그 스레드의 루트+댓글을 다 가져와 요약·인용에 쓴다. 사용자가 후보 중 하나를 고르거나 링크를 직접 줄 때.",
      { thread: z.string().describe("스레드 슬랙 링크(permalink) 또는 thread_ts"), channel: z.string().optional().describe("thread_ts만 줄 때의 채널 ID(C…)") },
      async ({ thread, channel }) => {
        try {
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "맥락 없음." }) }] };
          const pl = parseSlackLink(thread);
          const chan = pl?.channel || channel;
          const ts = pl?.ts || thread;
          if (!chan || !ts) return { content: [{ type: "text", text: JSON.stringify({ error: "스레드 링크에서 채널/ts를 못 읽음. permalink를 주거나 channel을 함께 줘." }) }] };
          const tc = await fetchThreadContext(ctx.client, chan, ts);
          if (!tc.text) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: "그 스레드를 못 읽음(봇이 채널 멤버인지 확인)." }) }] };
          return { content: [{ type: "text", text: JSON.stringify({ found: true, content: tc.text.slice(0, 6000) }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("find_unresolved_inquiry",
      "고객사→문의봇 하향 릴레이용: 작품(+회차)로 문의봇/재수급봇 시트의 '완료 미체크(미해결)' 건을 찾아 원 스레드 링크를 되짚는다. 재상 님이 고객사 답장을 붙이며 '문의봇에 전달/릴레이해줘'류로 요청할 때, 그 답이 어느 작업자 문의·재수급 스레드에 대한 것인지 찾는 용도. 결과의 link(스레드 URL)를 send_message의 thread 인자로 그대로 넘기면 그 스레드에 답글로 달린다. 1건이면 바로 relay, 2건 이상이면 후보를 보여주고 어느 스레드인지 되묻기, 0건이면 '미해결 문의/재수급 못 찾음'이라 답하고 지어내지 말 것.",
      { work: z.string().describe("작품명(한/일/중 중 아무거나, 부분 가능)"), episode: z.string().optional().describe("회차(있으면 좁혀서 매칭). 문의봇 탭은 회차 전용 컬럼이 없어 요약 텍스트로 확인하니 안 좁혀질 수 있음") },
      async ({ work, episode }) => {
        try {
          const hits = await findUnresolved(work, episode);
          if (!hits.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}'${episode ? ` ${episode}화` : ""} 관련 미해결 문의/재수급을 못 찾음.` }) }] };
          return { content: [{ type: "text", text: JSON.stringify({ found: true, count: hits.length, candidates: hits }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("propose_setjip_request",
      "설정집 작성 요청을 만들어 작업요청 채널에 게시하도록 '제안'한다(미리보기+✅). 견적요청 스레드에서 수주확정된 작품의 PIVO로 호출 — 작품명·원제·설정집 제출 희망일(자동 계산)·초도 납품일/회차·국가설정·기대치·특이사항·링크를 **견적+내부시트에서 자동**으로 채우고, **번역 작업자·식자 작업자·담당 APM만** 인자로 받는다(번역/식자는 기본값 있어 생략 가능, APM은 필수). 스레드에 여러 작품(PIVO)이 있으면 각 PIVO마다 한 번씩 호출. 절대 '게시했다'고 단정하지 말 것(버튼 눌러야 게시).",
      {
        pivo: z.string().describe("작품 PIVO ID(견적요청 스레드 본문의 [PV-xxxxxx])"),
        apm: z.string().describe("담당 APM 이름(서주원/정태영/박재상) 또는 Slack ID(U…)"),
        translator: z.string().optional().describe("번역 작업자(생략 시 '프리랜서 배정')"),
        typesetter: z.string().optional().describe("식자 작업자(생략 시 '강연재 우선 배정/안되면 프리랜서')"),
      },
      async ({ pivo, apm, translator, typesetter }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const ctx = currentCtx;
          if (!ctx?.client || !ctx?.channel) return { content: [{ type: "text", text: JSON.stringify({ error: "맥락 없음." }) }] };
          const e = await enrichSetjip(pivo);
          if (e.error) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: e.error }) }] };
          const apmId = /^[UW][A-Z0-9]+$/.test(String(apm || "").trim()) ? String(apm).trim() : (Object.entries(USER_NAMES).find(([, nm]) => nm === String(apm || "").trim())?.[0] || null);
          const id = `sj_${++setjipSeq}`;
          const p = { channel: SETJIP_CHANNEL, e, translator: translator || "", typesetter: typesetter || "", apmId, work: e.work_title, createdAt: Date.now() };
          pendingSetjip.set(id, p);
          const warn = [];
          if (!apmId) warn.push(`APM '${apm}' Slack ID 못 찾음 — 멘션 없이 나감(이름 확인)`);
          if (!e.sheetOk) warn.push("내부시트 미접근(견적값만) — 오리지널/원작링크/드라이브 누락 가능, 기대치/국가는 견적특이사항 기준");
          const posted = await ctx.client.chat.postMessage({ channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: `설정집 작성 요청 확인 — ${e.work_title}`, blocks: setjipBlocks(id, p) });
          if (posted?.ts) { p.previewChannel = ctx.channel; p.previewTs = posted.ts; pendingSetjip.save(); }
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, work: e.work_title, pivo: e.pivo, apm: apmId, warnings: warn, note: "미리보기+버튼 보냈음. ✅를 눌러야 작업요청 채널에 게시됨. 게시했다고 말하지 말 것. 검수 버튼/트리거는 이번 범위 밖(추후)." }) }] };
        } catch (e2) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e2?.message ?? e2) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("run_setjip_review",
      "설정집 검수를 n8n '중일 설정집 자동 검수 V2'로 직접 실행 요청한다('이 설정집 검수 실행해줘/검수 돌려줘/검수 트리거해줘'). setjip_run_review 버튼(🔍 설정집 검수)을 누른 것과 완전히 동일하게 n8n webhook(seoljeongjip-run)을 직접 호출 — 버튼이 없는 옛 설정집 작성 요청 스레드(신규 검수버튼 붙기 전에 만들어진 것)에서도 자연어로 트리거할 수 있게 하는 경로. 검수 대상 스레드 안에서 부르면 thread 생략 가능(지금 이 스레드를 그대로 씀). ★결과는 이 도구가 주지 않는다 — n8n이 잠시 후 개인채널에 직접 올림. '검수했다/결과 나왔다'고 단정 금지, '검수를 요청했다'까지만.",
      { thread: z.string().optional().describe("설정집 작성 요청 메시지의 슬랙 링크(permalink). 생략하면 지금 대화 중인 스레드를 그대로 쓴다.") },
      async ({ thread }) => {
        try {
          const ctx = currentCtx;
          let channel = ctx?.channel, ts = ctx?.ts;
          if (thread) {
            const p = parseSlackLink(thread);
            if (!p) return { content: [{ type: "text", text: JSON.stringify({ error: `스레드 링크를 못 읽음: ${thread}` }) }] };
            if (p.channel) channel = p.channel;
            ts = p.ts;
          }
          if (!channel || !ts) return { content: [{ type: "text", text: JSON.stringify({ error: "채널/스레드를 특정 못 함 — 설정집 작성 요청 스레드 안에서 부르거나 thread 링크를 줘라." }) }] };
          await n8nPost("seoljeongjip-run", { channel, thread_ts: ts, user: currentUser || "" });
          return { content: [{ type: "text", text: JSON.stringify({ triggered: true, channel, thread_ts: ts, note: "n8n에 검수를 요청했다. 결과는 잠시 후 개인채널에 n8n이 올린다. '검수 완료/결과' 등으로 단정하지 말고 '검수를 요청했다'고만 답하라." }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: false } }),
    tool("send_message",
      "슬랙으로 메시지를 보낸다. 받는이가 재상 님 본인(U04463JR4HH)이면 바로 발송, 그 외(다른 사람/채널)면 프리뷰+확인 버튼 후 발송. target=채널ID(C…) 또는 사용자ID(U…). 사람 이름만 알면 먼저 query_sheet(worker_db)로 slack_id를 조회해 ID로 넘겨라. 특정 스레드에 댓글로 달려면 thread에 그 메시지 링크(permalink)를 넘겨라(그러면 그 스레드 답글로 발송). 여러 명/채널에 같은 종류의 공지를 한 번에 보낼 땐 target/text 대신 items 배열을 써라 — 확인 버튼이 대상마다 따로 생기지 않고 1개로 묶여서 한 번에 전체 발송/취소된다(대량 발송 시 버튼 난립 방지). 임의로 '보냈다'고 말하지 말 것(확인 대기일 수 있음).",
      {
        target: z.string().optional().describe("받는 곳: 채널 ID(C…) 또는 사용자 ID(U…). thread(링크)를 주면 채널은 링크에서 자동 추출되므로 생략 가능. items를 쓸 땐 생략"),
        text: z.string().optional().describe("보낼 메시지 내용. items를 쓸 땐 생략"),
        thread: z.string().optional().describe("스레드 답글로 달 대상 메시지의 슬랙 링크(permalink) 또는 thread_ts. 주면 그 스레드 안에 댓글로 발송"),
        items: z.array(z.object({
          target: z.string().describe("채널 ID(C…) 또는 사용자 ID(U…)"),
          text: z.string().describe("이 대상에게 보낼 메시지(대상별로 멘션 등 다르게 넣어도 됨)"),
        })).optional().describe("여러 대상에 한 번에 보낼 목록. 2명 이상 발송 시 target/text 단일 호출 대신 이걸 써서 확인 버튼을 1개로 묶어라."),
      },
      async ({ target, text, thread, items }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "발송 컨텍스트 없음" }) }] };

          if (items && items.length) {
            const cleaned = items.map((it) => ({ target: String(it.target || "").trim(), text: it.text })).filter((it) => it.target && it.text);
            if (!cleaned.length) return { content: [{ type: "text", text: JSON.stringify({ error: "items가 비어있음" }) }] };
            const sendId = `send_${++sendSeq}`;
            pendingSends.set(sendId, { items: cleaned, createdAt: Date.now() });
            const lines = cleaned.map((it, i) => `${i + 1}. ${it.target.startsWith("C") ? `<#${it.target}>` : `<@${it.target}>`}`).join("\n");
            await ctx.client.chat.postMessage({
              channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: `일괄 발송 확인: ${cleaned.length}건`,
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `✉️ *일괄 발송 확인 (${cleaned.length}건)*\n${lines}` } },
                { type: "actions", elements: [
                  { type: "button", style: "primary", text: { type: "plain_text", text: `✉️ 전체 발송 (${cleaned.length}건)` }, value: sendId, action_id: "send_confirm" },
                  { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: sendId, action_id: "send_cancel" },
                ] },
              ],
            });
            return { content: [{ type: "text", text: JSON.stringify({ proposed: true, count: cleaned.length, note: "확인 버튼 1개(일괄)를 보냈음. 사용자가 버튼을 눌러야 전체 발송됨. 보냈다고 말하지 말 것." }) }] };
          }

          // 스레드 링크 파싱 → thread_ts(+채널). target 없으면 링크 채널 사용.
          let threadTs = null;
          if (thread) { const p = parseSlackLink(thread); if (!p) return { content: [{ type: "text", text: JSON.stringify({ error: `스레드 링크/ts를 못 읽음: ${thread} (슬랙 메시지 '링크 복사' 값 또는 1719300000.123456 형식)` }) }] }; threadTs = p.ts; if (!target && p.channel) target = p.channel; }
          if (!target) return { content: [{ type: "text", text: JSON.stringify({ error: "받는 곳(target) 또는 스레드 링크가 필요해요." }) }] };
          if (target === DISPATCHER_USER_ID && !threadTs) {
            await ctx.client.chat.postMessage({ channel: target, text, ...SENDER });
            return { content: [{ type: "text", text: JSON.stringify({ sent: true, to: "본인 DM" }) }] };
          }
          const sendId = `send_${++sendSeq}`;
          pendingSends.set(sendId, { target, text, threadTs, createdAt: Date.now() });
          await ctx.client.chat.postMessage({
            channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: `발송 확인: ${target}`,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `✉️ *발송 확인*\n• 받는 곳: ${target.startsWith("C") ? `<#${target}>` : `<@${target}>`}${threadTs ? ` (스레드 답글)` : ""}\n• 내용:\n>${String(text).replace(/\n/g, "\n>")}` } },
              { type: "actions", elements: [
                { type: "button", style: "primary", text: { type: "plain_text", text: "✉️ 보내기" }, value: sendId, action_id: "send_confirm" },
                { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: sendId, action_id: "send_cancel" },
              ] },
            ],
          });
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, to: target, note: "확인 버튼을 보냈음. 사용자가 버튼을 눌러야 발송됨. 보냈다고 말하지 말 것." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: false } }),
    tool("share_feedback",
      "번역 검수 피드백을 고객 공유용으로 정리해 지정 채널에 '발송 제안'한다('[작품] [회차] 피드백 공유해줘'). 퀄리티(KP평가) 작업기록 시트에서 총평·번역가·LG 코멘트와 등급(시트값 그대로)을 뽑아 양식 메시지를 만들고, APM을 받는이로(@APM CC @박재상) 확인 버튼과 함께 보낸다 — 재상 님이 버튼을 눌러야 실제 발송된다. 등급은 시트값을 그대로 쓰고 임의로 바꾸지 말 것. 발송 후 시트의 '피드백 공유' 열이 자동 체크된다. 절대 '보냈다'고 단정하지 말 것(확인 대기).",
      {
        work: z.string().describe("작품명(한/일/중) 또는 PIVO ID"),
        episode: z.string().describe("회차 표기(메시지에 '<작품> {episode}화'로 들어감). 예 '1-3', '4'. 사용자가 말한 그대로."),
        batch: z.string().optional().describe("검수 배치: 초회(1-3화 등)=생략 또는 '初回' / 재제출·추가분(4화+ 등)='再提出追話'(또는 '재제출'·'추가'). 시트 F열(追話備考)로 그 배치 등급·코멘트를 고른다."),
        channel: z.string().optional().describe("보낼 채널 ID(C…). 생략 시 기본 피드백 채널"),
      },
      async ({ work, episode, batch, channel }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const ctx = currentCtx;
          const fb = await buildFeedback({ work, episode, batch });
          if (!fb.found) {
            if (fb.ambiguous) return { content: [{ type: "text", text: JSON.stringify({ ambiguous: true, msg: "작품 후보가 여러 개. 어느 작품인지 되물어라.", candidates: fb.candidates }) }] };
            return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: fb.msg || `'${work}'를 못 찾음.` }) }] };
          }
          const chan = channel || FEEDBACK_CHANNEL;
          const warn = [];
          if (fb.missing.apm) warn.push(`APM(${fb.apmName || "?"}) Slack ID 미등록 — 멘션이 텍스트로 나갑니다`);
          if (fb.missing.translator) warn.push("번역가 코멘트 없음");
          if (fb.missing.lg) warn.push("LG 코멘트 없음");
          if (fb.missing.qa) warn.push("정성품질검수자(2번째 체커) 없음");
          const fbId = `fb_${++feedbackSeq}`;
          const p = { channel: chan, mentionReal: fb.mentionReal, mentionPreview: fb.mentionPreview, body: fb.body, koTitle: fb.koTitle, episode: fb.episode, batchType: fb.batchType, batchDate: fb.batchDate, rowsToMark: fb.rowsToMark, warn, createdAt: Date.now() };
          pendingFeedback.set(fbId, p);
          if (ctx?.client && ctx?.channel) {
            const posted = await ctx.client.chat.postMessage({ channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: `피드백 공유 확인: ${fb.koTitle} ${fb.episode}화 → <#${chan}>`, blocks: feedbackBlocks(fbId, p) });
            if (posted?.ts) { p.previewChannel = ctx.channel; p.previewTs = posted.ts; pendingFeedback.save(); }
          }
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, work: fb.koTitle, episode: fb.episode, batch: fb.batchType, to: chan, warnings: warn, note: "확인 버튼을 보냈음(✏️수정으로 본문 손볼 수 있음). 재상 님이 버튼을 눌러야 발송됨. 미리보기 그대로 보여주기만 하고, 보냈다고 말하지 말 것. 등급/코멘트를 임의로 바꾸지 말 것." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }),
    tool("propose_retake",
      "리테이크(수정 요청) 피드백을 번역가에게 보낼 '발송 제안'을 한다('이 리테이크 번역가에게 공유/보내줘'). 작품·회차·수정내용으로 일본어 메시지(고정 템플릿)를 만들어 확인 버튼과 함께 보낸다 — 재상 님이 버튼을 눌러야 실제 발송. 작품명은 FIX 일본어 타이틀, 받는이는 번역가(작업자 DB의 채널), cc는 작품 APM, 참고 에디터는 식자검수 URL을 자동으로 채운다. 수정내용(fix)은 리테이크 메시지 그대로 옮기되 '오류→수정'(예 買ってきてね -> 勝ってきてね) 형태가 있으면 그대로 넣어라. ★같은 리테이크 알림에 화수가 여럿(예 '121, 123')이면, 화수별로 나눠 이 도구를 여러 번 호출하지 말고 **episode에 전부 콤마로 합쳐 단 한 번만 호출**하라(fix도 화수별 내용을 한 문자열에 줄바꿈으로 담아 '121話：...\\n123話：...' 식으로 구분) — 그래야 참고 에디터가 화수별로 전부 나열되고 번역가에게도 한 메시지로 간다. 절대 '보냈다'고 단정하지 말 것(확인 대기).",
      {
        work: z.string().describe("작품명(한/일/중) 또는 PIVO ID"),
        episode: z.string().describe("리테이크 화수. 단일('121'), 범위('121-123'), 목록('121,123') 가능. 한 리테이크에 화수가 여럿이면 반드시 이렇게 콤마로 합쳐 한 번에 넣어라(화수별로 도구를 나눠 호출하지 말 것) — 여러 회차면 회차별 식자검수 링크가 전부 들어간다."),
        fix: z.string().describe("수정 내용. 반드시 일본어로만 작성(한국어 사유·설명은 일본어로 번역, 예 '「楽」が旧字体になっていたため新字体に修正'). 가능하면 '오류원문 -> 수정문' 형태(예 '買ってきてね -> 勝ってきてね'). 화수마다 내용이 다르면 '121話：...\\n123話：...'처럼 화수 표시 후 줄바꿈으로 구분해 한 문자열에 전부 담는다."),
        channel: z.string().optional().describe("보낼 채널 ID(C…). 생략 시 번역가 채널(작업자 DB) 자동. 한일 등 MASTER 미매핑 작품은 번역가가 안 잡히니 channel을 지정하라."),
      },
      async ({ work, episode, fix, channel }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const ctx = currentCtx;
          const rk = await buildRetake({ work, episode, fix, channel });
          if (!rk.found) {
            if (rk.ambiguous) return { content: [{ type: "text", text: JSON.stringify({ ambiguous: true, msg: "작품 후보가 여러 개. 어느 작품인지 되물어라.", candidates: rk.candidates }) }] };
            return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}'를 못 찾음.` }) }] };
          }
          if (!rk.target) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `번역가/채널을 못 찾음(${rk.mapped ? `번역가 ${rk.translator || "?"} 미등록` : "MASTER 미매핑 작품 — 번역가 자동조회 불가"}). channel 인자로 보낼 채널을 지정해 다시 시도하라.` }) }] };
          const warn = [];
          if (rk.missing.mapped) warn.push("한일/미매핑 — 제목·번역가를 TOTUS에서 보강함(작업자 DB에 없는 번역가면 멘션 누락 가능)");
          if (rk.missing.apm) warn.push("APM 미해석 — cc 생략(한일 등). 필요시 APM_SLACK 맵에 추가");
          if (rk.missing.editor) warn.push("식자검수 에디터 URL 못 찾음");
          const rkId = `rk_${++retakeSeq}`;
          const p = { target: rk.target, targetKind: rk.targetKind, headerReal: rk.headerReal, headerPreview: rk.headerPreview, body: rk.body, koTitle: rk.koTitle, epText: rk.epText, translator: rk.translator, trId: rk.trId, apmId: rk.apmId, editorKind: rk.editorKind, warn, createdAt: Date.now() };
          pendingRetakes.set(rkId, p);
          if (ctx?.client && ctx?.channel) {
            const posted = await ctx.client.chat.postMessage({ channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: `리테이크 발송 확인: ${rk.jpTitle} ${rk.epText} → ${rk.translator || "?"}`, blocks: retakeBlocks(rkId, p) });
            p.previewChannel = posted.channel; p.previewTs = posted.ts;
            pendingRetakes.save();   // previewTs 등 인플레이스 변경 영속화
          }
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, work: rk.koTitle, jpTitle: rk.jpTitle, episodes: rk.episodes, editor: rk.editorKind, translator: rk.translator, to: rk.target, warnings: warn, note: "확인 버튼을 보냈음. 재상 님이 버튼을 눌러야 발송됨. 미리보기 그대로만 보여주고, 보냈다고 단정하지 말 것." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }),
    tool("read_tab",
      "query_sheet 뷰에 없는 임의 탭을 탭 이름으로 직접 조회한다(read-only). 시트의 *실제 헤더*를 필드명으로 쓰므로 한글/일본어 헤더 그대로 필터·기간조회 가능. sheet 생략 시 알려진 시트들(delivery/ops/worker/retake/schedule/kp_eval)에서 탭명 자동검색. ★사용자가 시트 URL/ID를 주면 그걸 sheet에 그대로 넣어라(SA가 접근 가능한 시트면 등록 안 돼 있어도 읽는다). 탭명은 띄어쓰기 무시 매칭('원고 수급'='원고수급'). 못 찾으면 그 시트의 탭 목록을 에러로 돌려주니 사용자에게 보여주고 고르게 하라. 헤더가 1행이 아니면 headerRow 지정(예 作業記録=4). 같은 데이터를 query_sheet 뷰로 조회할 수 있으면 그걸 우선.",
      {
        tab: z.string().describe("탭 이름(부분일치·띄어쓰기 무시)"),
        sheet: z.string().optional().describe("별칭(delivery/ops/worker/retake/schedule/kp_eval) *또는* 스프레드시트 URL/ID 그대로. 생략 시 등록 시트 자동검색"),
        headerRow: z.number().optional().describe("헤더 행번호(기본 1). 표가 중간부터면 그 행 번호"),
        filterField: z.string().optional().describe("거를 헤더 이름 — 시트 실제 헤더 그대로"),
        filterOp: z.enum(["empty", "notEmpty", "eq", "neq", "contains"]).optional(),
        filterValue: z.string().optional(),
        dateField: z.string().optional().describe("기간필터 날짜 헤더 이름"), dateFrom: z.string().optional(), dateTo: z.string().optional(),
        distinct: z.array(z.string()).optional(),
        limit: z.number().optional(),
      },
      async (a) => {
        try {
          const where = a.filterField ? { field: a.filterField, op: a.filterOp ?? "eq", value: a.filterValue ?? "" } : null;
          const dateRange = a.dateField ? { field: a.dateField, from: a.dateFrom ?? null, to: a.dateTo ?? null } : null;
          const r = await readTab({ sheet: a.sheet ?? null, tab: a.tab, headerRow: a.headerRow ?? 1, where, dateRange, distinct: a.distinct ?? null, limit: a.limit ?? 50 });
          return { content: [{ type: "text", text: capJson(r) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }),
    tool("translation_guide",
      "중일(중국어→일본어) 웹툰 번역·표기 방침 가이드 원문을 읽어온다. 작업자 문의나 재상 님 질문이 '번역 방침·표기 규칙·용어·후리가나·기호(가운데점 등)·식자 표기' 등 가이드로 판정할 내용이면 이 도구로 가이드를 읽고 **해당 조항을 인용**해 답하라(임의 규칙 지어내기 금지). kind='translation'(기본)=번역 가이드 2종(WEBマンガ 翻訳ガイドライン 中国語→日本語 + Piccoma 中日クライアント ガ이드). kind='setjip'=설정집 작성 가이드 — ★이건 재상 님이 '설정집'을 명시적으로 언급할 때만 조회(작업자 번역 방침 문의엔 쓰지 마라).",
      { kind: z.enum(["translation", "setjip"]).optional().describe("translation=번역 가이드 2종(기본), setjip=설정집 작성 가이드(재상 님이 설정집 언급 시만)") },
      async ({ kind }) => {
        try {
          const read = (f) => { try { return readFileSync(`guides/${f}`, "utf8"); } catch { return ""; } };
          if (kind === "setjip") {
            const t = read("setjip-creation.md");
            return { content: [{ type: "text", text: t ? `[설정집 작성 가이드 — 해당 조항 인용해 답, 임의 규칙 금지]\n\n${t}` : JSON.stringify({ error: "설정집 가이드 파일(guides/setjip-creation.md) 없음" }) }] };
          }
          const a = read("translation-webmanga.md"), b = read("translation-piccoma-client.md");
          if (!a && !b) return { content: [{ type: "text", text: JSON.stringify({ error: "번역 가이드 파일(guides/translation-*.md) 없음" }) }] };
          return { content: [{ type: "text", text: `[중일 번역 가이드 2종 — 해당 조항 인용해 답, 임의 규칙 금지]\n\n=== [가이드1] WEBマンガ 翻訳ガイドライン（中国語→日本語） ===\n${a}\n\n=== [가이드2] Piccoma 中日クライアント ガイド ===\n${b}` }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("notion_search", "노션에서 페이지/DB를 키워드로 검색(읽기). 통합에 공유된 것만 보임. 결과의 id로 notion_read_page 호출.",
      { query: z.string().describe("검색 키워드") },
      async (a) => { try { return { content: [{ type: "text", text: capJson(await notionSearch(a.query)) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: true } }),
    tool("notion_read_page", "노션 페이지 본문을 텍스트로 읽는다. notion_search 결과의 id를 넣는다.",
      { pageId: z.string().describe("노션 페이지 ID") },
      async (a) => { try { return { content: [{ type: "text", text: capJson(await notionReadPage(a.pageId)) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: true } }),
    tool("outline_search", "Outline 위키(voithru.getoutline.com)에서 문서를 키워드로 검색(읽기). 결과의 id/url로 outline_read 호출. 스크럼 회의록 등 Outline 문서 찾을 때. (Notion과 별개 — Outline 문서는 이 도구로)",
      { query: z.string().describe("검색 키워드") },
      async (a) => {
        try {
          const j = await outlineApi("documents.search", { query: a.query, limit: 10 });
          if (!j) return { content: [{ type: "text", text: JSON.stringify({ error: "Outline 토큰 미설정(OUTLINE_API_TOKEN)" }) }] };
          const hits = (j.data || []).map((h) => ({ id: h.document?.id, title: h.document?.title, url: h.document?.url, context: h.context }));
          return { content: [{ type: "text", text: capJson(hits) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("outline_read", "Outline 위키 문서 본문을 마크다운 텍스트로 읽는다. 문서 ID(UUID)·urlId·문서 URL(voithru.getoutline.com/doc/...) 무엇이든 넣으면 됨. 스크럼 회의록 등 Outline 문서 분석·비교(지난주 vs 이번주 등)에 사용.",
      { doc: z.string().describe("문서 ID(UUID) / urlId / 문서 URL") },
      async (a) => {
        try {
          const info = await outlineApi("documents.info", { id: outlineDocId(a.doc) });
          if (!info) return { content: [{ type: "text", text: JSON.stringify({ error: "Outline 토큰 미설정(OUTLINE_API_TOKEN)" }) }] };
          const d = info.data;
          if (!d) return { content: [{ type: "text", text: JSON.stringify({ error: "문서를 못 찾음 — ID/URL 또는 접근 권한 확인", raw: JSON.stringify(info).slice(0, 200) }) }] };
          return { content: [{ type: "text", text: capJson({ title: d.title, url: d.url, updatedAt: d.updatedAt, text: d.text }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("outline_children",
      "Outline에서 특정 부모 문서의 하위 문서 목록(제목·생성일·url·id)을 반환한다. doc 생략 시 *자동화 정기 스크럼 부모 문서* 하위 = 주차별 회의록 목록. ★스크럼 주차 비교(지난주 vs 이번주)는 검색이 부정확하니 이걸 먼저 써서 목록을 받고, 원하는 주차(예 07-01·2026-07-08)를 골라 outline_read로 본문을 읽어라. 제목 날짜 형식은 '(MM-DD)' 또는 '(YYYY-MM-DD)'.",
      { doc: z.string().optional().describe("부모 문서 ID/urlId/URL. 생략 시 스크럼 부모(OUTLINE_PARENT_DOC_ID)") },
      async (a) => {
        try {
          const parent = a.doc ? outlineDocId(a.doc) : process.env.OUTLINE_PARENT_DOC_ID;
          if (!parent) return { content: [{ type: "text", text: JSON.stringify({ error: "부모 문서 미지정(doc 인자 또는 OUTLINE_PARENT_DOC_ID 필요)" }) }] };
          const j = await outlineApi("documents.list", { parentDocumentId: parent, limit: 30 });
          if (!j) return { content: [{ type: "text", text: JSON.stringify({ error: "Outline 토큰 미설정(OUTLINE_API_TOKEN)" }) }] };
          const list = (j.data || []).sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt)).map((d) => ({ id: d.id, title: d.title, createdAt: (d.createdAt || "").slice(0, 10), url: d.url }));
          return { content: [{ type: "text", text: capJson(list) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("query_schedule",
      "중일 '고객사 스케줄 시트'(내부 납품 시트와 다름) 조회. 블록 구조라 일반 query_sheet/read_tab으로는 안 되고 이 도구로만. mode: 'launch'(특정 회차의 런칭일=주차별 リリース日 + 그 주차 납품예정일. 회차 매칭 기준=話数(런칭 회차). work나 pivo + episode) · 'delivery_check'(★특정 회차가 '납품'으로 스케줄 시트에 기재됐는지 검증 — 기준=納品話数(납품 회차)+納品予定日. 납품 리스트가 시트에 반영됐는지 확인할 때 이걸 써라. work나 pivo + episode. 반환 listedForDelivery=true면 기재됨) · 'delivery_on'(특정 날짜에 납품 예정인 회차 집계, date 필수 예 '6/19') · 'missing'(런칭 임박인데 原本 미수급 회차, monthsAhead 기본1) · 'work'(작품별 주차 스케줄 전체, work 필수). ★블록 제목(正式+仮)으로 직접 매칭하니 일본어 제목만으로도 잘 잡힌다. ★'납품(회차)이 스케줄 시트에 들어갔나/기재됐나' = **반드시 delivery_check**(話数 기준 launch로 판단하면 오답). '○○ N화 런칭일' = launch.",
      { mode: z.enum(["launch", "delivery_check", "delivery_on", "missing", "work"]).describe("조회 종류"), date: z.string().optional().describe("delivery_on용 날짜 M/D (예 6/19)"), work: z.string().optional().describe("work/launch/delivery_check용 작품명(한/일/중 무엇이든)"), pivo: z.string().optional().describe("PIVO ID(있으면 병행). 작품명 대신/병행 사용"), episode: z.string().optional().describe("launch/delivery_check용 회차 번호(예 '289'). 생략 시 주차 전체 반환"), monthsAhead: z.number().optional().describe("missing용 런칭 임박 개월(기본 1)") },
      async ({ mode, date, work, pivo, episode, monthsAhead }) => {
        try {
          let r;
          if (mode === "launch") r = await episodeLaunch({ work, pivo, episode });
          else if (mode === "delivery_check") r = await episodeDelivery({ work, pivo, episode });
          else if (mode === "delivery_on") r = await deliveryOnDate(date);
          else if (mode === "missing") r = await missingOriginals({ monthsAhead: monthsAhead ?? 1 });
          else if (mode === "work") r = await workSchedule(work);
          else r = { error: "mode는 launch|delivery_check|delivery_on|missing|work 중 하나" };
          return { content: [{ type: "text", text: capJson(r) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("propose_translation_start",
      "설정집 검수가 끝난 작품의 '번역 개시 요청' 메시지를 고정 템플릿으로 만들어, 그 작품의 '설정집 작성 요청' 스레드(채널 검색으로 자동 탐색)에 답글로 발송하도록 '제안'한다(미리보기+✏️수정+버튼). DM에서 호출해도 됨. work(작품명 한/일/중 또는 PIVO)로 설정집 작성 요청 채널을 검색→그 메시지에서 담당 APM 멘션과 PIVO를 추출하고, PIVO로 TOTUS 견적을 조회해 초도 납품일·초도 회차를 자동으로 채운다. 한국어 타이틀은 (보통 이 대화에서 함께 정한) 합의된 제목을 ko_title로 준다(생략 시 견적의 한국어 제목). 검수 시작일은 자동(요청일+11일, 주말 포함). 후보가 여러 건이면 되묻는다. 절대 '보냈다'고 단정하지 말 것(버튼 눌러야 발송).",
      {
        work: z.string().optional().describe("작품명(한/일/중) 또는 PIVO ID — 설정집 작성 요청 채널을 검색할 키. thread를 주면 생략 가능"),
        thread: z.string().optional().describe("설정집 작성 요청 메시지의 슬랙 링크(검색이 안 잡힐 때 폴백). 주면 검색 대신 그 스레드에 바로 발송"),
        ko_title: z.string().optional().describe("한국어 타이틀(이 대화에서 정한 합의 제목). 생략 시 견적의 한국어 제목 사용"),
        revision_note: z.string().optional().describe("수정 사항 문구. 생략 시 '위에서 언급해드린 수정 사항 외에는 변동 없습니다.' (✏️수정 모달로도 입력 가능)"),
        first_delivery_date: z.string().optional().describe("초도 납품일 수동 지정(생략 시 견적에서 자동, 예 '8/24(월)')"),
        first_episode: z.string().optional().describe("초도 회차 수동 지정(생략 시 견적에서 자동, 예 '20')"),
        apm_user_id: z.string().optional().describe("담당 APM Slack ID 수동 지정(생략 시 설정집 메시지에서 자동)"),
        review_start_date: z.string().optional().describe("검수 시작일 M/D 수동 지정(생략 시 자동, 요청일+11일)"),
      },
      async ({ work, thread, ko_title, revision_note, first_delivery_date, first_episode, apm_user_id, review_start_date }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const ctx = currentCtx;
          if (!ctx?.client || !ctx?.channel) return { content: [{ type: "text", text: JSON.stringify({ error: "맥락을 못 잡음. 다시 불러줘." }) }] };
          let hit;
          if (thread && thread.trim()) {                       // 링크 폴백: 검색 건너뛰고 그 메시지 직접 사용
            const pl = parseSlackLink(thread);
            if (!pl?.ts) return { content: [{ type: "text", text: JSON.stringify({ error: `스레드 링크를 못 읽음: ${thread} (메시지 '링크 복사' 값 필요)` }) }] };
            const chan = pl.channel || SETJIP_CHANNEL;
            const rr = await ctx.client.conversations.replies({ channel: chan, ts: pl.ts, limit: 1 }).catch(() => null);
            const m = rr?.messages?.[0];
            if (!m) return { content: [{ type: "text", text: JSON.stringify({ error: "그 링크의 메시지를 못 읽었어(봇이 그 채널 멤버인지 확인 필요)." }) }] };
            hit = { ts: pl.ts, channel: chan, text: m.text || "", apmId: (String(m.text).match(/<@([UW][A-Z0-9]+)>/) || [])[1] || null, pivoId: (String(m.text).match(/PV-?(\d+)/) || [])[1] || null };
          } else {
            // 검색 키: LLM work + 업로드 파일명에서 뽑은 일/중 제목 런(한국어로 잘못 검색하는 것 보완 — 채널엔 일/중만 있음)
            const fileKeys = (currentFileRefs || []).flatMap((f) => filenameKeys(f.name));
            const keys = [...new Set([work, ...fileKeys].map((k) => String(k || "").trim()).filter(Boolean))];
            if (!keys.length) return { content: [{ type: "text", text: JSON.stringify({ error: "work(작품명/PIVO) 또는 thread(설정집 메시지 링크), 아니면 설정집 파일 첨부 중 하나는 필요해." }) }] };
            let hits = [];
            for (const k of keys) { hits = await findSetjipRequest(ctx.client, k); if (hits.length) break; }
            if (!hits.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, triedKeys: keys, msg: `설정집 작성 요청을 <#${SETJIP_CHANNEL}>에서 못 찾음(시도 키: ${keys.join(", ")}). 채널엔 일본어 가제/중국어 원제로 등록되니 한국어로는 안 잡혀. 그 메시지 '링크 복사' 값을 thread로 주면 거기 바로 달아줌.` }) }] };
            if (hits.length > 1) return { content: [{ type: "text", text: JSON.stringify({ found: true, multiple: true, msg: "설정집 작성 요청이 여러 건 잡혔어. 어느 건지 확인 필요.", candidates: hits.slice(0, 5).map((h) => ({ ts: h.ts, pivoId: h.pivoId, preview: String(h.text).replace(/\n/g, " ").slice(0, 80) })) }) }] };
            hit = hits[0];
          }
          const pivo = hit.pivoId;
          let firstDelivery = first_delivery_date?.trim() || "", firstEpisode = first_episode?.trim() || "", koFromQuote = "", firstDeliveryRaw = "";
          if (pivo) {
            try {
              const q = await quotationByPivo(pivo);
              const d = Array.isArray(q?.data) ? q.data[0] : null;
              if (d) {
                firstDeliveryRaw = d["초도작업_납품목표일"] || "";   // 납품 시트 G열(YMD)용 원시 날짜
                if (!firstDelivery) firstDelivery = fmtKDate(d["초도작업_납품목표일"]);
                if (!firstEpisode) firstEpisode = String(d["초도작업_총작업량표시"] || d["초도작업_총작업량"] || "").replace(/화$/, "").trim();
                koFromQuote = d["pivoOriginalTitle"] || "";
              }
            } catch (e) { /* 견적 실패해도 진행(수동값/모달로 보완) */ }
          }
          // 인라인 포맷([중일 설정집 작성 요청], PIVO 링크 없음) 폴백 — 메시지에서 초도 정보 직접 파싱
          if (!firstDelivery || !firstEpisode) {
            const inl = parseSetjipInline(hit.text);
            if (!firstDelivery) firstDelivery = inl.firstDelivery;
            if (!firstEpisode) firstEpisode = inl.firstEpisode;
          }
          const p = {
            channel: hit.channel || SETJIP_CHANNEL, threadTs: hit.ts, pivo,
            apmId: apm_user_id?.trim() || hit.apmId || null,
            koTitle: ko_title?.trim() || koFromQuote || "(미정 — 수정에서 입력)",
            firstDelivery: firstDelivery || "(미확인 — 수정에서 입력)",
            firstDeliveryRaw,
            firstEpisode: firstEpisode || "(미확인)",
            revisionNote: revision_note?.trim() || "",
            reviewStart: review_start_date?.trim() || reviewStartMD(11),
            files: (currentFileRefs || []).filter((f) => f?.url).map((f) => ({ url: f.url, name: f.name || "file", mimetype: f.mimetype || "" })),
            createdAt: Date.now(),
          };
          const tsId = `ts_${++transStartSeq}`;
          pendingTransStart.set(tsId, p);
          const posted = await ctx.client.chat.postMessage({ channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: "번역 개시 요청 확인", blocks: transStartBlocks(tsId, p) });
          if (posted?.ts) { p.previewChannel = ctx.channel; p.previewTs = posted.ts; pendingTransStart.save(); }
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, pivo, apmFound: !!p.apmId, firstDelivery: p.firstDelivery, firstEpisode: p.firstEpisode, reviewStart: p.reviewStart, koTitle: p.koTitle, note: "설정집 스레드를 찾아 미리보기+버튼을 보냈음(견적에서 초도 납품일·회차 자동). ✅를 눌러야 그 스레드에 실제 발송됨. 발송했다고 말하지 말 것. 한국어 타이틀·수정사항은 ✏️수정으로 채울 수 있음. 설정집 파일은 사용자가 직접 첨부함." }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("run_wongo_update",
      "원고수급(납품·이관) 시트의 '미발송' 건(발송 여부 N열 미체크 & 담당 APM 매칭 & 작품명 있음)을 GAS 웹앱으로 일괄 전송한다. ★재상 님이 버튼 없이 바로 실행하기로 함 — 이 도구는 확인 버튼 없이 즉시 슬랙 리포트 전송 + N열 체크 + n8n 반영을 수행하고 결과만 보고한다. '원고수급 미발송 전송/돌려줘', '이관 시트 업데이트 돌려줘', '원본수급 알림 안 보낸 거 보내줘' 류에 사용. 사용자가 명시적으로 전송을 요청했을 때만 호출(임의 실행 금지). 빈 행·담당자 미매칭은 GAS가 제외. 전송 전에 비고란을 자동 기재한다: 납품일 14일 미만 남으면 '일정 타이트', 아니면 그 작품의 납품 배치 주기(같은 납품일로 묶이는 연속 회차 크기의 최빈값)가 3 이상일 때만 '주{N}화 납품'(1·2화는 기본값 취급, 라벨 없음. 기존 비고 있으면 안 건드림). 성공 시 간단히, 실패/일부실패/타임아웃이면 분명히 보고.",
      {},
      async () => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          let noteStats = { total: 0, tightCount: 0, groupCount: 0 };
          try { noteStats = await annotateWongoNotes(); } catch (e) { console.error("[wongo] 비고 자동기재 실패:", e?.message ?? e); }
          const noteSummary = noteStats.total ? `, 비고 기재 ${noteStats.total}건(일정타이트 ${noteStats.tightCount}·회차그룹 ${noteStats.groupCount})` : "";
          const r = await wongoPost(false);                 // 버튼 없이 즉시 실제 전송
          const sent = r.managers ?? 0, failed = r.failedManagers ?? 0, rows = r.rows ?? 0;
          if (sent === 0 && failed === 0) return { content: [{ type: "text", text: JSON.stringify({ ok: true, pending: 0, noteStats, note: "보낼 미발송 건이 없었음(전부 발송됨/담당자 미매칭). 사용자에게 '보낼 거 없었어요'만 간단히." }) }] };
          if (failed > 0) return { content: [{ type: "text", text: JSON.stringify({ ok: false, sent, failed, rows, noteStats, codes: r.codes, note: `일부/전부 전송 실패(웹훅 응답코드 확인). 성공 ${sent}명/${rows}건만 체크됨, 실패분은 N 그대로. 사용자에게 실패 사실과 코드를 분명히 알릴 것.` }) }] };
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, sent, rows, noteStats, note: `전송 완료(APM ${sent}명/${rows}건)${noteSummary}. 사용자에게 간단히 '○건 전송했어요'${noteStats.total ? "(+비고 기재 건수)" : ""}.` }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e?.message ?? e), note: "전송 중 오류/타임아웃. 사용자에게 문제를 알리고 잠시 후 재시도 안내." }) }] }; }
      },
      { annotations: { readOnlyHint: false } }),
    tool("propose_totus_project",
      "TOTUS 프로젝트의 이름(name) 또는 상태(action)를 변경하도록 '제안'한다(게이트형: 미리보기+✅버튼, 누르면 실제 변경). 작품(work) 또는 PIVO로 프로젝트를 찾고, action(상태) 또는 name(새 프로젝트명) 중 하나를 바꾼다(한 번에 하나). action: hold(홀드)·unhold(홀드해제)·process(진행)·pause(일시정지)·complete(완료)·cancel(취소). '○○ 홀드해줘/완료처리/취소', '○○ 프로젝트명 △△로 바꿔줘' 류. 프로젝트명 변경은 검수 후 가제→FIX 적용의 TOTUS 부분(시트는 별도). 절대 '바꿨다'고 단정하지 말 것(버튼 눌러야 반영).",
      {
        work: z.string().optional().describe("작품명(한/일/중). pivo가 있으면 생략 가능"),
        pivo: z.string().optional().describe("PIVO ID(있으면 가장 정확)"),
        action: z.enum(["hold", "unhold", "process", "pause", "complete", "cancel"]).optional().describe("상태 변경 액션. name과 동시 지정 시 action 우선"),
        name: z.string().optional().describe("새 프로젝트명(이름 변경 시) 전체 문자열. ★형식=[PV-id] [Piccoma중일] {일본어FIX}({한국어}). （仮）·(O)·중국어 원제는 제거, 태그는 카카오픽코마가 아니라 Piccoma중일. 예: [PV-210009] [Piccoma중일] 究極の選ばれし者(최강 선인의 고교생 환생기)"),
      },
      async ({ work, pivo, action, name }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const ctx = currentCtx;
          if (!action && !(name && name.trim())) return { content: [{ type: "text", text: JSON.stringify({ error: "action(상태) 또는 name(새 이름) 중 하나는 필요해." }) }] };
          const rp = await resolveTotusProject({ work, pivo });   // 출판사 시트 비의존 — TOTUS에서 직접 찾음
          if (rp.ambiguous) return { content: [{ type: "text", text: JSON.stringify({ ambiguous: true, candidates: rp.candidates, msg: "TOTUS에 같은 이름 후보가 여러 개 — 사용자에게 보여주고 PIVO로 특정받아라(임의 선택 금지)." }) }] };
          if (rp.notFound) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: rp.msg }) }] };
          const d = { projectUuid: rp.projectUuid, projectName: rp.projectName };
          const change = action ? { action } : { name: name.trim() };
          const label = action ? `상태 → *${TOTUS_ACTION_KO[action] || action}*${rp.status ? ` (현재 ${rp.status})` : ""}` : `이름 → *${name.trim()}*`;
          const id = `proj_${++totusProjSeq}`;
          const p = { projectUuid: d.projectUuid, projectName: d.projectName || "", steps: [change], label, createdAt: Date.now() };
          pendingTotusProj.set(id, p);
          if (ctx?.client && ctx?.channel) {
            await ctx.client.chat.postMessage({
              channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: "TOTUS 프로젝트 변경 확인",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `🛠 *TOTUS 프로젝트 변경 확인*\n• 프로젝트: ${d.projectName || d.projectUuid}\n• ${label}\n진행할까요? (실제 TOTUS 반영)` } },
                { type: "actions", elements: [
                  { type: "button", style: action === "cancel" ? "danger" : "primary", text: { type: "plain_text", text: "✅ 변경" }, value: id, action_id: "proj_confirm" },
                  { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: id, action_id: "proj_cancel" },
                ] },
              ],
            });
          }
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, projectName: d.projectName, change, note: "확인 버튼을 보냈음. ✅를 눌러야 실제 TOTUS 반영. 바꿨다고 말하지 말 것." }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("propose_totus_complete",
      "완결 작품 처리 — TOTUS 프로젝트명 맨 뒤에 '(완)'을 붙이고 상태를 '완료(complete)'로 한 번에 바꾸도록 '제안'한다(게이트형: 미리보기+✅). '○○ 완결 작품 처리해줘/완결처리' 류에 사용. work나 pivo로 프로젝트를 찾고, 확인 시 이름 변경 + 상태 완료를 순차 반영(API가 한 번에 하나라 PATCH 2번). 이미 '(완)'이 붙어있으면 상태만 완료로. 절대 '처리했다'고 단정하지 말 것(버튼 눌러야 반영).",
      {
        work: z.string().optional().describe("작품명(한/일/중). pivo 있으면 생략 가능"),
        pivo: z.string().optional().describe("PIVO ID(있으면 가장 정확)"),
      },
      async ({ work, pivo }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const ctx = currentCtx;
          const rp = await resolveTotusProject({ work, pivo });   // 출판사 시트 비의존 — TOTUS에서 직접 찾음
          if (rp.ambiguous) return { content: [{ type: "text", text: JSON.stringify({ ambiguous: true, candidates: rp.candidates, msg: "TOTUS에 같은 이름 후보가 여러 개 — 사용자에게 보여주고 PIVO로 특정받아라(임의 선택 금지)." }) }] };
          if (rp.notFound) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: rp.msg }) }] };
          const cur = String(rp.projectName || "").trim();
          const already = /\(완\)\s*$/.test(cur);
          const newName = already ? cur : `${cur} (완)`;
          const steps = already ? [{ action: "complete" }] : [{ name: newName }, { action: "complete" }];
          const statusLine = rp.status ? `\n• 현재 상태: ${rp.status}${/완료|complete|done/i.test(rp.status) ? " ⚠️(이미 완료 상태일 수 있음)" : ""}` : "";
          const label = already ? "상태 → *완료* (이름엔 이미 (완) 있음)" : `이름 → *${newName}* + 상태 → *완료*`;
          const id = `proj_${++totusProjSeq}`;
          pendingTotusProj.set(id, { projectUuid: rp.projectUuid, projectName: cur, steps, label, createdAt: Date.now() });
          if (ctx?.client && ctx?.channel) {
            await ctx.client.chat.postMessage({
              channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: "완결 처리 확인",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `🏁 *완결 작품 처리 확인*\n• 프로젝트: ${cur || rp.projectUuid}${statusLine}\n• ${label}\n진행할까요? (실제 TOTUS 반영)` } },
                { type: "actions", elements: [
                  { type: "button", style: "primary", text: { type: "plain_text", text: "✅ 완결 처리" }, value: id, action_id: "proj_confirm" },
                  { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: id, action_id: "proj_cancel" },
                ] },
              ],
            });
          }
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, projectName: cur, newName, already, status: rp.status, note: "확인 버튼을 보냈음. ✅를 눌러야 (완) 표기+완료 반영. 처리했다고 말하지 말 것. 현재 상태가 이미 완료면 사용자에게 알려라." }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("compute",
      "복잡한 계산은 암산하지 말고 이 도구로 JS 코드를 실행해 정확히 계산한다. 다행 합계·환율 변환·정산·통계·CSV 집계 등 숫자 계산은 반드시 이걸로. 첨부된 CSV/엑셀/텍스트 원문은 코드 안에서 `attachments`(배열 [{name,text}])로 바로 접근(전체 데이터, 다시 옮겨적지 말 것). 결과는 마지막 식이거나 `result` 변수에 담는다. 파일·네트워크 접근 없음(순수 계산), 5초 제한.",
      { code: z.string().describe("실행할 JS. attachments[i].text로 첨부 원문 접근. 예: const rows=attachments[0].text.trim().split('\\n').map(r=>r.split(',')); result = rows.slice(1).reduce((s,r)=>s+Number(r[2]||0),0);") },
      async ({ code }) => {
        try {
          const sandbox = { attachments: currentAttachments, Math, JSON, Number, String, Array, Object, Boolean, parseFloat, parseInt, isNaN, isFinite, result: undefined, console: { log() {} } };
          const val = vm.runInNewContext(code, sandbox, { timeout: 5000 });
          const out = sandbox.result !== undefined ? sandbox.result : val;
          return { content: [{ type: "text", text: capJson({ result: out }) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      },
      { annotations: { readOnlyHint: true } }),
    tool("add_reminder",
      "재상 님이 '나중에 챙길 일'을 기억해달라고 할 때 저장한다(재촉 리마인더). 시간 지정 불필요 — 끝내거나 '그만'할 때까지 하루 여러 번(기본 09·14·18시) 자동으로 재촉 DM이 간다. '이거 기억해둬'·'나중에 ~해야 해'·'~하는 거 잊지마' 류에 사용.",
      { text: z.string().describe("기억할 내용") },
      async (a) => { try { const _d = ownerOnly(); if (_d) return _d; const link = await ctxPermalink(); const r = addReminder(a.text, link); return { content: [{ type: "text", text: JSON.stringify({ saved: true, id: r.id, total: r.total, note: "하루 여러 번 재촉 예정(요청 스레드 링크 포함). 끝나거나 '그만'하면 지움." }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: false } }),
    tool("schedule_reminder",
      "특정 시각에 1회 리마인드. '월요일 오전 10시에 ~ 리마인드'처럼 시각이 주어질 때 사용. when은 ISO8601(예 2026-06-22T10:00:00+09:00) — 메시지 앞 [현재 시각(KST)] 기준으로 계산해서 넣어라. 시각 없이 '그냥 기억해둬'면 이게 아니라 add_reminder를 쓴다.",
      { text: z.string().describe("리마인드할 내용"), when: z.string().describe("발송 시각 ISO8601(KST 오프셋 +09:00 권장)") },
      async (a) => { try { const _d = ownerOnly(); if (_d) return _d; const link = await ctxPermalink(); const r = addScheduled(a.text, a.when, link); if (r.error) return { content: [{ type: "text", text: JSON.stringify(r) }] }; return { content: [{ type: "text", text: JSON.stringify({ scheduled: true, id: r.id, dueAt: r.dueAt }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: false } }),
    tool("list_reminders", "저장된 리마인더 목록(재촉형+시각지정형, dueAt 있으면 시각지정). '내 할일/리마인더 뭐 있어' 류.",
      {},
      async () => { try { const _d = ownerOnly(); if (_d) return _d; return { content: [{ type: "text", text: JSON.stringify({ items: listReminders() }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: true } }),
    tool("complete_reminder",
      "재촉 리마인더를 완료/중단 처리(삭제 = 리마인드 히스토리에서 제외)한다. '~했어'·'N번 완료'·'~끝냈어'·'해결됐어' 같은 완료 신호, 그리고 '그만'·'멈춰'·'이건 그만 리마인드해' 같은 중단 신호 모두에 사용. 번호(예 '2') 또는 내용 일부(부분 일치)로 지정.",
      { match: z.string().describe("완료할 리마인더의 번호 또는 내용 일부") },
      async (a) => { try { const _d = ownerOnly(); if (_d) return _d; const r = completeReminder(a.match); return { content: [{ type: "text", text: JSON.stringify({ done: r.done, removed: r.removed.map((x) => x.text), remaining: r.remaining }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: false } }),
    tool("remember",
      "재상 님이 '앞으로 ~로 기억해/외워둬/이건 이렇게 이해해' 하고 가르친 규칙·별칭·교정을 영구 저장한다(재기동에도 유지 — 다음 부팅부터 시스템 지침에 포함돼 항상 적용). 예: \"'○○'는 △△ 작품이야\", \"'완료'라고 하면 완결처리야\", \"이 채널 요청은 ~로 처리해\". 단순 '나중에 할 일'(리마인더)은 add_reminder를, 항구적 동작 규칙/이해 교정은 이걸 쓴다. 잘못 이해했던 걸 바로잡아 줄 때도 이걸로 저장하면 다시 안 틀린다.",
      { note: z.string().describe("기억할 규칙/별칭/교정 (한 문장으로 명확히)") },
      async (a) => { try { const _d = ownerOnly(); if (_d) return _d; const r = addLearned(a.note); if (r.error) return { content: [{ type: "text", text: JSON.stringify(r) }] }; return { content: [{ type: "text", text: JSON.stringify({ saved: true, dup: !!r.dup, total: r.total, note: "저장했고 지금 대화부터 반영. 재기동 후에도 계속 적용됨." }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: false } }),
    tool("forget",
      "remember로 저장했던 학습 규칙을 지운다('그건 잊어/그 규칙 빼'). 번호 또는 내용 일부로 지정. (지운 건 다음 재기동부터 시스템 지침에서 빠짐)",
      { match: z.string().describe("지울 학습 규칙의 번호 또는 내용 일부") },
      async (a) => { try { const _d = ownerOnly(); if (_d) return _d; const r = removeLearned(a.match); return { content: [{ type: "text", text: JSON.stringify({ removed: r.removed, remaining: r.remaining }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: false } }),
    tool("list_learned", "지금까지 가르쳐 저장된 학습 규칙(remember) 목록. '뭐 기억하고 있어/배운 거 보여줘' 류.",
      {},
      async () => { try { const _d = ownerOnly(); if (_d) return _d; return { content: [{ type: "text", text: JSON.stringify({ items: listLearned() }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: true } }),
    tool("check_totalk_mentions", "새 TOTUS ToTalk 멘션을 조회만 해서 초안으로 보여준다. ★절대 발송하지 않는다(작업자 채널로 안 나감, 시트 기록·커서 이동도 없음). '토톡 확인해줘/멘션 왔는지 봐줘/초안 띄워줘' 류에 사용. 반환된 items(작업자·채널등록여부·초안텍스트)를 재상 님께 초안으로 보기 좋게 정리해 보여줄 것. 실제 발송은 이 도구로 하지 말고, 재상 님이 명시적으로 '발송해'라고 할 때만 별도 처리.",
      {},
      async () => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const result = await pollOnce(app.client, { dryRun: true });   // 초안만, 발송 안 함
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; }
      }),
  ],
});

// ── 영속 브레인 세션 (콜드스타트 제거 + 대화 연속성) ──────────────────
// query()를 부팅 때 한 번만 띄우고(스트리밍 입력 모드), 메시지가 오면 살아있는
// 세션에 흘려넣는다. 엔진 subprocess가 재사용되어 매 메시지 ~9초 콜드스타트가 사라진다.
// 응답은 세션 루프가 받아 FIFO로 대응되는 Slack thread에 돌려준다.
// 한 번에 한 턴씩 직렬 처리 — 여러 스레드에서 동시에 물어도 응답이 엉뚱한 스레드로 가지 않게.
const queue = [];         // 처리 대기 턴: { content, ctx }
let wake = null;          // 새 턴 도착 시 generator 깨우기
let turnResolve = null;   // 현재 턴의 result 처리 완료 신호(다음 턴 진행 허용)
let currentTurn = null;   // 지금 브레인이 처리 중인 턴
let currentAttachments = [];   // 이 턴에 첨부된 텍스트/CSV/엑셀 원문 [{name,text}] — compute 도구용
let currentFileRefs = [];      // 이 턴에 업로드된 파일 refs [{url,name,mimetype,filetype}] — 번역개시 첨부 재발송용

// ── 모델: 봇 기능(조회·일정·리마인더·발송) 수행에 최적인 단일 Sonnet(DISPATCHER_MODEL)으로 통일.
//    턴별 전환(Haiku 티어링) 제거 — 모델 고정이 프롬프트 캐시를 유지해 지연↓ + 품질 일관.
//    무거운 판단(검수)은 외부 엔진으로 분리 예정이라 봇은 단일 모델로 충분.

// ── rate-limit(사용량 한도) 처리: 감지 시 친절 안내 + 지수 백오프 자동 재시도 ──
const RL_RE = /rate.?limit|\b429\b|overloaded|too many requests|usage limit|quota|exceeded/i;
const isRateLimit = (s) => RL_RE.test(String(s || ""));
const RL_BACKOFF = [8000, 20000];   // 재시도별 대기(ms). 배열 길이 = 최대 자동 재시도 횟수

const TURN_HARD_TIMEOUT_MS = 420_000;   // 한 턴이 이 시간 넘게 안 끝나면(행/과부하) 중단·재시작.
// ★210→420s(2026-06-28): 대량 집계·검수 턴이 정당하게 3~6분 걸리는데 210s가 너무 짧아 멀쩡한 작업을
//   중간에 죽이고 재시도 악순환을 냈음. 진짜 무거운 작업 여유 확보(stall 안내가 150s에 떠서 사용자도 인지).

async function* messageStream() {
  while (true) {
    if (queue.length === 0) await new Promise((r) => { wake = r; });
    while (queue.length) {
      const turn = queue.shift();
      currentTurn = turn;
      currentCtx = turn.ctx;   // 도구(발송·진행알림)가 '이 턴'의 자리로 답하도록 고정
      currentAttachments = turn.attachTexts || [];   // compute 도구가 이 턴 첨부 원문을 쓰도록
      currentFileRefs = turn.fileRefs || [];          // 번역개시 등에서 이 턴 업로드 파일을 재첨부하도록
      currentUser = turn.user || null;                // 재상 전용 가드용 요청자
      // 하드 타임아웃: 행/과부하로 영영 안 끝나는 턴이 큐를 막지 않게 — 알림 후 프로세스 종료(run.bat가 ~5초 후 재기동)
      const killer = setTimeout(async () => {
        console.error(`[brain] 턴 하드타임아웃(>${TURN_HARD_TIMEOUT_MS / 1000}s) — 중단·재시작`);
        try { await deliver(turn.ctx, "⚠️ 요청 처리가 너무 오래 걸려 중단했어요. 데이터가 많으면 범위를 줄이거나 더 작게 나눠서 다시 보내주세요."); } catch {}
        process.exit(1);
      }, TURN_HARD_TIMEOUT_MS);
      yield { type: "user", message: { role: "user", content: turn.content } };
      await new Promise((r) => { turnResolve = r; });   // 이 턴의 result가 처리될 때까지 대기(직렬화)
      clearTimeout(killer);
    }
  }
}

// "처리 중…" 자리표시자는 '삭제'하고, 답은 '새 메시지'로 단다 (편집됨 라벨 회피).
async function deliver(ctx, text) {
  ctx.done = true;   // watchdog 중복 처리 방지
  if (ctx.placeholderTs) {
    try { await ctx.client.chat.delete({ channel: ctx.channel, ts: ctx.placeholderTs }); }
    catch { /* 이미 없거나 삭제 실패 → 무시하고 새 메시지만 */ }
  }
  await ctx.client.chat.postMessage({ channel: ctx.channel, thread_ts: ctx.threadTs, text, ...SENDER });
}

// 진행 상황을 '사용자가 부른 그 자리(스레드/DM)'에 알린다 — 별도 DM으로 새지 않게.
async function notifyHere(text) {
  const ctx = currentCtx;
  if (!ctx?.client) return;
  await ctx.client.chat.postMessage({ channel: ctx.channel, thread_ts: ctx.ts, text, ...SENDER });
}

// 스레드 대화 맥락 + 이미지 파일 수집 (봇이 멤버인 채널의 스레드).
async function fetchThreadContext(client, channel, threadTs) {
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    const msgs = res.messages || [];
    const lines = msgs
      .filter((m) => (m.text || "").trim())
      .map((m) => `${m.bot_id ? "봇" : `<@${m.user}>`}: ${m.text.replace(/\s+/g, " ").slice(0, 500)}`);
    const attFiles = [];
    for (const m of msgs) for (const f of (m.files || []))
      attFiles.push({ url: f.url_private_download || f.url_private, mimetype: f.mimetype, filetype: f.filetype, name: f.name });
    return { text: lines.length ? lines.join("\n") : null, attFiles };
  } catch (e) {
    console.error("[thread] 맥락 조회 실패:", e?.message ?? e);
    return { text: null, attFiles: [] };
  }
}

// 등록 업무 채널(SEARCH_CHANNELS)에서 작품명/키워드로 스레드(루트 메시지) 검색. 토큰 커버리지로 점수.
const _tnorm = (s) => String(s ?? "").replace(/[\s~～〜〰（）()\[\]【】「」『』·・,.\-—–:：!?！？]/g, "").toLowerCase();
async function findThreads(client, query, { channel = "", days = 60, maxPages = 2 } = {}) {
  const toks = String(query ?? "").split(/\s+/).map(_tnorm).filter((t) => t.length >= 2);
  if (!toks.length || !SEARCH_CHANNELS.length) return [];
  const ch = String(channel || "").trim();
  const targets = ch ? SEARCH_CHANNELS.filter((c) => c.id === ch || c.name.includes(ch) || ch.includes(c.name) || ch.includes(c.id)) : SEARCH_CHANNELS;
  const oldest = String(Math.floor(Date.now() / 1000) - Math.abs(days) * 86400);
  const out = [];
  for (const c of (targets.length ? targets : SEARCH_CHANNELS)) {
    let cursor, pages = 0;
    while (pages++ < maxPages) {
      let r;
      try { r = await client.conversations.history({ channel: c.id, limit: 200, oldest, ...(cursor ? { cursor } : {}) }); }
      catch (e) { break; }
      for (const m of (r.messages || [])) {
        if (m.subtype && m.subtype !== "file_share") continue;
        const nt = _tnorm(m.text || "");
        if (!nt) continue;
        const matched = toks.filter((t) => nt.includes(t));
        if (!matched.length) continue;
        // 밀도: 매칭 토큰 글자수 / 메시지 길이 — 여러 작품 나열한 일일 묶음 스레드(긴 글)는 낮게, 집중 스레드는 높게.
        const density = matched.reduce((s, t) => s + t.length, 0) / Math.max(nt.length, 1);
        out.push({ channelId: c.id, channelName: c.name, ts: m.thread_ts || m.ts, score: matched.length / toks.length, density, snippet: String(m.text || "").replace(/\s+/g, " ").slice(0, 140), replyCount: m.reply_count || 0, tsNum: parseFloat(m.ts) || 0 });
      }
      cursor = r.response_metadata?.next_cursor; if (!cursor) break;
    }
  }
  const byTs = {};
  for (const o of out) { const k = o.channelId + "|" + o.ts; if (!byTs[k] || o.score > byTs[k].score) byTs[k] = o; }
  return Object.values(byTs).sort((a, b) => b.score - a.score || b.density - a.density || b.tsNum - a.tsNum).slice(0, 8);
}

// 슬랙 첨부(url_private)를 봇 토큰으로 받아 Claude content 블록으로 변환. (files:read 스코프 필요)
// 이미지=image블록, PDF=document블록, 엑셀=시트별 CSV 텍스트, csv/txt/md/json 등=텍스트.
async function toAttachmentBlocks(files, cap = 6) {
  const blocks = [], texts = [], seen = new Set();
  for (const f of files) {
    const url = f.url; if (!url || seen.has(url) || blocks.length >= cap) continue;
    seen.add(url);
    const mt = (f.mimetype || "").toLowerCase(), ft = (f.filetype || "").toLowerCase(), name = f.name || "file";
    try {
      // 설정집 xlsx·PSD 등은 수십 MB라 전역 30s로는 abort → 파일 다운로드는 60s×2회 재시도(과부하 순간 커넥션 멈춤 대비).
      let r = null, dlErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { r = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }, signal: AbortSignal.timeout(60000) }); break; }
        catch (e) { dlErr = e; console.error(`[file] ${name} 다운로드 시도 ${attempt} 실패: ${e?.message ?? e}`); }
      }
      if (!r) { console.error(`[file] ${name} 다운로드 최종 실패(재시도 소진): ${dlErr?.message ?? dlErr}`); continue; }
      if (!r.ok) { console.error(`[file] ${name} 다운로드 ${r.status} (files:read 스코프/멤버십 확인)`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (mt.startsWith("image/")) {                                   // 이미지
        if (buf.length > 4_800_000) { console.error(`[file] ${name} 이미지 5MB 초과 스킵`); continue; }
        blocks.push({ type: "image", source: { type: "base64", media_type: mt || "image/png", data: buf.toString("base64") } });
      } else if (mt === "application/pdf" || ft === "pdf") {           // PDF → 문서 블록
        if (buf.length > 30_000_000) { console.error(`[file] ${name} PDF 과대 스킵`); continue; }
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") }, title: name });
      } else if (/spreadsheet|excel/.test(mt) || ["xlsx", "xls"].includes(ft)) {  // 엑셀 → 시트별 CSV
        const wb = XLSX.read(buf, { type: "buffer" });
        let txt = "";
        for (const sn of wb.SheetNames) txt += `## ${sn}\n${XLSX.utils.sheet_to_csv(wb.Sheets[sn])}\n\n`;
        blocks.push({ type: "text", text: `[첨부 엑셀: ${name}]\n${txt.slice(0, 30000)}` });
        texts.push({ name, text: txt.slice(0, 500000) });   // compute용 전체(LLM 컨텍스트보다 넉넉히)
      } else if (mt.startsWith("text/") || /json|csv|markdown|xml|yaml/.test(mt) || ["csv", "tsv", "txt", "md", "markdown", "json", "log", "yaml", "yml", "xml"].includes(ft)) {  // 텍스트류
        const t = buf.toString("utf8");
        blocks.push({ type: "text", text: `[첨부 파일: ${name}]\n${t.slice(0, 30000)}` });
        texts.push({ name, text: t.slice(0, 500000) });
      } else {
        console.error(`[file] ${name} 미지원 타입 스킵 (mt=${mt}, ft=${ft})`);
      }
    } catch (e) { console.error(`[file] ${name} 처리 실패:`, e?.message ?? e); }
  }
  return { blocks, texts };
}

function startSession() {
  const learnedBlk = learnedPromptBlock();   // 재상 님이 가르친 규칙 — 부팅마다 시스템 프롬프트에 주입(재기동 유지)
  const sysPrompt = learnedBlk ? [...DISPATCHER_PROMPT, learnedBlk] : DISPATCHER_PROMPT;
  if (learnedBlk) console.log(`[learned] 학습 규칙 ${listLearned().length}개 주입`);
  const session = query({
    prompt: messageStream(),
    options: {
      model: DISPATCHER_MODEL,
      systemPrompt: sysPrompt,
      mcpServers: { apm: { type: "sdk", name: "apm", instance: apmTools.instance } },
      // 명시한 apm 서버만 사용하고, 계정/조직에 배포된 외부 커넥터는 전부 무시한다.
      // (claude.ai 조직 커넥터의 깨진 헤더 'Bearer 복사한_토큰'이 봇 세션에 실려
      //  매 응답을 깨뜨리던 문제 차단 — 툰식이는 외부 커넥터가 필요 없음)
      strictMcpConfig: true,
      allowedTools: ["mcp__apm__get_delivery_date", "mcp__apm__check_work_list", "mcp__apm__build_delivery_notice", "mcp__apm__check_undelivered_episodes", "mcp__apm__retake_query", "mcp__apm__delivery_on_date", "mcp__apm__get_work_info", "mcp__apm__propose_work_note", "mcp__apm__query_sheet", "mcp__apm__propose_delivery_edit", "mcp__apm__propose_totus_delivery_edit", "mcp__apm__totus_delivery_date",
        "mcp__apm__totus_quotation", "mcp__apm__totus_find_project", "mcp__apm__totus_schedule_summary", "mcp__apm__totus_jobs", "mcp__apm__totus_tasks", "mcp__apm__totus_task", "mcp__apm__totus_translation_text", "mcp__apm__get_editor_url", "mcp__apm__get_project_url", "mcp__apm__get_source_files",
        "mcp__apm__review_episode", "mcp__apm__review_queue", "mcp__apm__delegate_analysis", "mcp__apm__export_csv", "mcp__apm__export_translation_text_range", "mcp__apm__find_thread", "mcp__apm__read_thread", "mcp__apm__find_unresolved_inquiry",
        "mcp__apm__send_message", "mcp__apm__share_feedback", "mcp__apm__propose_retake", "mcp__apm__propose_translation_start", "mcp__apm__propose_setjip_request", "mcp__apm__run_setjip_review", "mcp__apm__register_translation_monitor", "mcp__apm__run_wongo_update", "mcp__apm__propose_totus_project", "mcp__apm__propose_totus_complete", "mcp__apm__propose_task_retake", "mcp__apm__read_tab", "mcp__apm__notion_search", "mcp__apm__notion_read_page", "mcp__apm__outline_search", "mcp__apm__outline_read", "mcp__apm__outline_children",
        "mcp__apm__query_schedule", "mcp__apm__compute", "mcp__apm__translation_guide",
        "mcp__apm__add_reminder", "mcp__apm__schedule_reminder", "mcp__apm__list_reminders", "mcp__apm__complete_reminder",
        "mcp__apm__remember", "mcp__apm__forget", "mcp__apm__list_learned",
        "mcp__apm__check_totalk_mentions",
        "WebSearch"],
    },
  });
  (async () => {
    let buf = "";
    for await (const m of session) {
      if (m.type === "assistant") {
        for (const b of m.message?.content || []) if (b.type === "text" && b.text) buf += b.text;
      } else if (m.type === "result") {
        const ctx = currentTurn?.ctx;            // 지금 처리 중인 그 턴의 자리 (도착순 FIFO 추측 아님)
        const text = (m.result || buf || "(브레인이 빈 응답을 반환했어)").trim();
        buf = "";
        const elapsed = ctx?.startedAt ? ((Date.now() - ctx.startedAt) / 1000).toFixed(1) : "?";
        console.log(`[brain] 응답 완료 (${elapsed}s, ${text.length}자${m.is_error ? ", is_error" : ""})`);
        logUsage({ kind: "main", user: currentTurn?.user || null, channel: ctx?.channel || null, ms: ctx?.startedAt ? Date.now() - ctx.startedAt : null, chars: text.length, isError: !!m.is_error, inTok: m.usage?.input_tokens ?? null, outTok: m.usage?.output_tokens ?? null, cacheRead: m.usage?.cache_read_input_tokens ?? null, cacheWrite: m.usage?.cache_creation_input_tokens ?? null });
        if (m.is_error) console.log(`[brain] 에러내용: ${text.slice(0, 200).replace(/\n/g, " ")}`);
        const rlTurn = currentTurn;   // rate-limit 재시도용 캡처
        currentTurn = null;
        if (m.is_error && isRateLimit(text) && rlTurn && (rlTurn._retry || 0) < RL_BACKOFF.length) {
          const n = (rlTurn._retry || 0) + 1;
          const delay = RL_BACKOFF[n - 1];
          console.log(`[brain] rate-limit — ${Math.round(delay / 1000)}s 후 자동 재시도 (${n}/${RL_BACKOFF.length})`);
          if (ctx?.placeholderTs) ctx.client.chat.update({ channel: ctx.channel, ts: ctx.placeholderTs, text: `⏳ 사용량 한도예요. ${Math.round(delay / 1000)}초 후 자동으로 다시 시도할게요… (${n}/${RL_BACKOFF.length})` }).catch(() => {});
          setTimeout(() => { queue.unshift({ content: rlTurn.content, ctx, _retry: n }); if (wake) { const w = wake; wake = null; w(); } }, delay);
        } else if (ctx?.client) {
          const out = (m.is_error && isRateLimit(text)) ? "지금 사용량 한도라 처리를 못 했어요 😢 잠시(1~2분) 뒤 다시 보내주세요." : text;
          deliver(ctx, out).catch((e) => console.error("[brain] 응답 전송 실패:", e?.message));
        }
        if (turnResolve) { const r = turnResolve; turnResolve = null; r(); }   // 다음 턴 진행 허용
      }
    }
    console.error("[brain] 세션 스트림 종료 — 재시작");
    startSession();
  })().catch((e) => {
    const msg = e?.message ?? String(e);
    const rl = isRateLimit(msg);
    console.error("[brain] 세션 루프 오류:", msg, rl ? "(rate-limit)" : "");
    const dead = [currentTurn, ...queue].filter(Boolean);
    currentTurn = null; queue.length = 0;
    const note = rl ? "⏳ 사용량 한도로 잠시 멈췄어요. 곧 자동 복구되니 1~2분 뒤 다시 보내주세요." : `⚠️ 브레인 오류: ${msg}`;
    for (const t of dead) deliver(t.ctx, note).catch(() => {});
    if (turnResolve) { const r = turnResolve; turnResolve = null; r(); }
    setTimeout(startSession, rl ? 30000 : 1000);
  });
}

// ── 핵심 처리: 본인 메시지 → ack → 세션에 투입 (응답은 세션 루프가 thread로) ──
async function handle({ text, channel, ts, threadTs, inThread, user, client, say, files }) {
  if (!ALLOWED_USERS.has(user)) return;               // 재상 + 허용 APM만 (그 외 무시)
  // 메시지에 붙은 이미지 파일
  const msgFiles = (files || []).map((f) => ({ url: f.url_private_download || f.url_private, mimetype: f.mimetype, filetype: f.filetype, name: f.name }));
  if ((!text || !text.trim()) && !msgFiles.length) return;   // 텍스트도 첨부도 없으면 무시
  if (processed.has(ts)) return;                       // 중복 차단 (메시지 ts 기준)
  processed.add(ts);
  const thread = threadTs || ts;                       // 답변·자리표시자를 달 스레드 루트

  // 스레드 안에서 소환되면 그 스레드 맥락(텍스트+이미지)을 읽어 함께 전달
  let llmText = text || "(첨부된 파일을 보고 답해줘)";
  let attFiles = msgFiles;
  if (inThread) {
    const tc = await fetchThreadContext(client, channel, thread);
    if (tc.text) llmText = `아래는 이 슬랙 스레드의 대화 맥락이야. 참고해서 마지막 [요청]에 답해줘.\n\n[스레드 맥락]\n${tc.text}\n\n[요청]\n${text || "(첨부된 파일 참고)"}`;
    attFiles = attFiles.concat(tc.attFiles);
  }
  // 현재 시각 주입 — '월요일 10시' 같은 상대 시각 리마인더를 브레인이 정확히 계산하도록
  const nowStr = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "full", timeStyle: "short" });
  llmText = `[현재 시각(KST): ${nowStr}] [요청자: ${USER_NAMES[user] || "사용자"}] [채널: ${channel}]\n${llmText}`;
  // 어시스턴트 패널: 재상 님이 '지금 보고 있는 채널/스레드' 맥락을 주입(패널 최근 열림·DM일 때만) — '이 스레드/이거' 지시 해석용
  const _av = assistantCtx.get(user);
  if (_av && channel.startsWith("D") && Date.now() - _av.at < 15 * 60 * 1000) {
    try {
      // 슬랙은 '보고 있는 채널'만 주고 '특정 스레드'는 안 준다 → 채널 최근 메시지 + 최근 스레드 답글까지 펼쳐 수집(best-effort)
      const hist = await client.conversations.history({ channel: _av.channel_id, limit: 15 });
      const msgs = (hist.messages || []).reverse();
      let vt = msgs.map((m) => m.text || "").join("\n");
      for (const pm of msgs.filter((m) => (m.reply_count || 0) > 0).slice(-2)) {
        try { const rr = await client.conversations.replies({ channel: _av.channel_id, ts: pm.ts, limit: 30 }); vt += `\n\n[스레드 답글]\n${(rr.messages || []).map((m) => m.text || "").join("\n")}`; } catch { /* 스레드 조회 실패 무시 */ }
      }
      if (vt.trim()) llmText = `[지금 재상 님이 보고 있는 채널(${_av.channel_id})의 최근 대화 — ★슬랙 한계로 '특정 스레드'는 못 집는다. 이 맥락으로 답하되, 정확한 스레드가 필요하면 '그 스레드 링크를 붙여주세요'라고 안내하라(그럼 read_thread로 정확히 읽음)]\n${vt.slice(0, 3500)}\n\n${llmText}`;
    } catch { /* 조회 실패 무시 */ }
  }
  const chPol = CHANNEL_POLICY[channel];   // 채널별 행동 지침(임시) — 있으면 최우선 규칙으로 주입
  if (chPol) llmText = `[이 채널 규칙(최우선): ${chPol}]\n${llmText}`;
  console.log(`[handle] 수신 (ch=${channel}, inThread=${inThread}, 첨부=${attFiles.length}): ${String(text || "").slice(0, 80).replace(/\n/g, " ")}`);

  // currentCtx는 messageStream이 '이 턴을 실제로 처리할 때' 설정한다 (도착 순간 아님 → 도구 오배달 방지)
  const ph = await say({ text: "처리 중…", thread_ts: thread, ...SENDER });   // 자리표시자(완료 시 삭제되고 새 메시지로 답함)

  if (!BRAIN_ON) {
    const echo = `🔌 에코 모드 (CLAUDE_CODE_OAUTH_TOKEN 미설정)\n> ${text || "(이미지)"}`;
    if (ph?.ts) await client.chat.update({ channel, ts: ph.ts, text: echo }).catch(() => {});
    else await say({ text: echo, thread_ts: thread });
    return;
  }
  // 이미지가 있으면 다운로드해 멀티모달 content 배열로, 없으면 텍스트 문자열로
  const att = attFiles.length ? await toAttachmentBlocks(attFiles) : { blocks: [], texts: [] };
  // 첨부가 있었는데 하나도 못 읽었으면(다운로드 타임아웃/미지원) 조용히 넘어가지 말고 브레인이 사용자에게 알리도록.
  if (attFiles.length && !att.blocks.length && !att.texts.length) {
    llmText += "\n\n[주의: 첨부 파일을 못 읽었어요(다운로드 실패/타임아웃/미지원 형식). 파일 내용이 필요한 작업은 진행하지 말고, '파일을 못 받았어요 — 용량이 크거나 형식이 안 맞을 수 있으니 다시 올려주세요'라고 사용자에게 안내하라.]";
  }
  const content = att.blocks.length ? [{ type: "text", text: llmText }, ...att.blocks] : llmText;

  // 턴을 큐에 넣고 한 번에 하나씩 처리 — 완료 시 deliver()가 '처리 중'을 지우고 새 메시지로 답한다
  const entry = { client, channel, threadTs: thread, ts: thread, placeholderTs: ph?.ts, startedAt: Date.now(), done: false };
  queue.push({ content, ctx: entry, attachTexts: att.texts, fileRefs: msgFiles, user });   // fileRefs=이 메시지에 올린 파일(번역개시 첨부 발송용)
  if (wake) { const w = wake; wake = null; w(); }

  // 멈춤 감시: 제한시간 내 응답 없으면 '처리 중'을 지연 안내로 갱신(영영 멈춘 듯 보이지 않게)
  if (ph?.ts) setTimeout(() => {
    if (entry.done) return;
    client.chat.update({ channel, ts: ph.ts, text: "⏳ 데이터가 많은 작업이라 처리 중이에요(집계·검수는 몇 분 걸릴 수 있어요). 끝나면 바로 답할게요 — 다시 보내지 말고 조금만 기다려 주세요." }).catch(() => {});
  }, STALL_NOTICE_MS);
}

// ── 워치 채널 자동 링크 ──────────────────────────────────────────
// 박재상/문의봇이 워치 채널에 남긴 메시지에 '한국어 타이틀 정확일치'가 있으면 프로젝트 링크를 자동 답글.
// 메시지에 '재수급' 언급이 있으면 원본 링크(driveLink)도 함께. 작품명 없으면 침묵. (읽기 전용·선제 액션)
const WORK_LINK_WATCH = new Set((process.env.WORK_LINK_WATCH_CHANNELS || "C09B8QHP7D4,C06SUD5AFE1").split(",").map((s) => s.trim()).filter(Boolean));
const INQUIRY_BOT_ID = process.env.INQUIRY_BOT_ID || "B0AL3E0RNCW";   // 문의봇(inquirybot)
const RESUPPLY_RE = /재수급|재\s*수급|원본\s*다시|원고\s*다시|다시\s*수급/;
// ★2026-07-13 고객사(Kuaikan/Shenzhen Yuerong 공동제작) 합의: 이 두 출판사 작품은 원본 관련 이슈(작화 실수·
// 스토리 모순 등)가 사소해서 내부에서 조용히 처리하고 넘어가더라도, 고객사가 版元(원 출판사)에 취합 보고해야
// 해서 개별로 알려줘야 함(재수급까지 안 가는 건도 포함). 재수급/원본 언급 있는 스레드에서 이 출판사 매칭되면 리마인드.
const REPORT_TO_CLIENT_PUBLISHERS = new Set(["Kuaikan Comics（直取引）_2", "Shenzhen Yuerong（共同制作）"]);
const ORIGIN_ISSUE_RE = /재수급|원본|작화\s*(실수|미스|오류)|스토리\s*모순/;
let SELF_BOT_USER = null;   // 툰식이 자신의 Slack user id(멘션 시 app_mention이 처리하도록 자동링크 스킵)
async function handleWorkLinkWatch({ text, channel, ts, threadTs, client }) {
  try {
    if (!text || processed.has("wl:" + ts)) return;
    if (SELF_BOT_USER && text.includes(`<@${SELF_BOT_USER}>`)) return;   // 툰식이 멘션이면 app_mention(브레인)이 처리
    processed.add("wl:" + ts);
    const idx = await koTitleIndex();
    const tn = norm(text);
    const hits = idx.filter((x) => x.koNorm && x.koNorm.length >= 2 && tn.includes(x.koNorm));
    if (!hits.length) return;                                 // 한국어 타이틀 정확일치 없으면 침묵
    hits.sort((a, b) => b.koNorm.length - a.koNorm.length);   // 가장 구체적인(긴) 제목
    const hit = hits[0];
    let urlLine = "🔗 프로젝트: (TOTUS에서 못 찾음)";
    try {
      const fp = await findProject(hit.pivoId || hit.koTitle);
      const proj = (fp?.data || [])[0];
      if (proj?.uuid) urlLine = `🔗 프로젝트: https://admin.totus.pro/ko/workProgressManagementDetail/?id=${proj.uuid}`;
    } catch { /* 조회 실패 시 안내 유지 */ }
    const wantSrc = RESUPPLY_RE.test(text);
    const lines = [`📁 *${hit.koTitle}*`, urlLine];
    if (wantSrc) lines.push(hit.driveLink ? `📦 원본: ${hit.driveLink}` : `📦 원본: 시트에 링크 없음 — ${hit.publisher || "출판사"}에서 원제 「${hit.zhTitle || "?"}」로 검색`);
    if (ORIGIN_ISSUE_RE.test(text) && REPORT_TO_CLIENT_PUBLISHERS.has(hit.publisher || "")) {
      lines.push(`⚠️ *${hit.publisher}* 소속 — 원본 관련 이슈는 내부에서 조용히 처리해도 고객사에 개별 보고 대상이에요(재수급까지 안 가는 사소한 작화/스토리 건도 포함). 잊지 말고 공유하세요.`);
    }
    await client.chat.postMessage({ channel, thread_ts: threadTs || ts, text: lines.join("\n"), ...SENDER, unfurl_links: false });
    console.log(`[worklink] ${hit.koTitle} → 프로젝트${wantSrc ? "+원본" : ""} (ch=${channel})`);
    // 문의봇 구조화 재수급 요청이면 → 고객사 보낼 일본어 재수급 초안(복붙용)도 자동 첨부
    if (/재수급\s*사유\s*[:：]/.test(text)) {
      try {
        const draft = await buildResupplyDraft(text);
        if (draft) { await client.chat.postMessage({ channel, thread_ts: threadTs || ts, text: draft, ...SENDER, unfurl_links: false }); console.log(`[resupply-draft] ${hit.koTitle} 고객사 초안 발송`); }
      } catch (e) { console.error("[resupply-draft] 실패:", e?.message ?? e); }
    }
  } catch (e) { console.error("[worklink] 실패:", e?.message ?? e); }
}

// 문의봇 재수급 요청 → 고객사(중국 출판사)에 복붙할 일본어 초안(필드 나열식). 발송 X, 텍스트만.
function fmtPages(s) {
  const nums = String(s || "").match(/\d+/g)?.map(Number) || [];
  if (nums.length >= 2 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)) return `${nums[0]}〜${nums[nums.length - 1]}`;
  return nums.length ? nums.join("・") : String(s || "").trim();
}
async function buildResupplyDraft(text) {
  // 필드는 ' - ' 또는 줄바꿈으로 구분됨 → 조각내고 '키 : 값'에서 값만 추출
  const parts = String(text || "").split(/\s-\s|\n/).map((s) => s.replace(/^[\s\-・•*]+/, "").trim()).filter(Boolean);
  const seg = (re) => { const p = parts.find((s) => re.test(s) && /[:：]/.test(s)); return p ? p.replace(/^[^:：]*[:：]\s*/, "").trim() : null; };
  const work = seg(/작품\s*명/);
  const episode = seg(/회\s*차/);
  const pages = seg(/페이지/);
  const reason = seg(/재수급\s*사유|수정\s*사유|사\s*유/);
  if (!work || !reason) return null;
  const w = await lookupWork(work);
  if (!w.found) return null;
  const jp = w.fixTitle || w.jaTitle || w.koTitle || work;
  const zh = w.zhTitle || "?";
  const prompt = [
    "다음 한국어 '재수급 사유'를, 중국 출판사(고객사)에 보낼 일본어 요청 문장 *한 줄*로 바꿔라.",
    "형식: '{상태 설명}のため、再手配いただければ幸いです。' — 정중체, 주어진 사유만(지어내기·과장 금지).",
    "예: '73화 1-3p 이미지가 초고와 같음' → '下書きのような画像のため、再手配いただければ幸いです。'",
    "일본어 문장 한 줄만 출력(따옴표·머리말 없이).",
    "", "[사유]", reason,
  ].join("\n");
  let ja = (await toollessQuery(prompt, { label: "재수급 사유 일역" }) || "").trim().replace(/^["'「]|["'」]$/g, "");
  if (!ja) ja = `${reason}（要確認）`;
  const epPage = [episode ? episode.replace(/\s*화\s*$/, "") + "話" : null, pages ? fmtPages(pages) + "p" : null].filter(Boolean).join(" ");
  return [
    "📝 *고객사 재수급 요청* (복붙용)",
    "```",
    `・日本語タイトル：${jp}`,
    `・中国語タイトル：${zh}`,
    `・話数／ページ：${epPage}`,
    `・理由：${ja}`,
    "```",
  ].join("\n");
}

// 작품·회차(+페이지)의 원본 소스 파일 → { slackLinks(마스킹 링크 한 줄), files, ... }. get_source_files 도구·문의 원문 해석 공용.
async function sourceFilesFor(work, episode, page) {
  const fp = await findProject(work);
  const proj = (fp?.data || [])[0];
  if (!proj?.uuid) return { found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음.` };
  const projName = String(proj.프로젝트 || work).replace(/\[[^\]]*\]\s*/g, "").trim();
  const r = await deliverySourceGroups(proj.uuid, String(episode));
  const groups = r?.data || [];
  if (!groups.length) return { found: false, work: projName, msg: `${episode}화 원본(소스) 파일을 못 찾음. 회차 표기 확인 필요.` };
  const pageOf = (name) => { const m = String(name).replace(/\.[^.]+$/, "").match(/\d+/g); return m ? parseInt(m[m.length - 1], 10) : null; };
  const all = groups.flatMap((g) => (g.파일목록 || []).map((f) => ({ episode: g.에피소드, page: pageOf(f.파일이름), file: f.파일이름, ext: f.확장자, url: f.다운로드URL })));
  let out = all;
  if (page != null && String(page).trim() !== "") {
    const want = String(page).split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    out = all.filter((f) => want.includes(f.page));
    if (!out.length) return { found: false, work: projName, episode, msg: `${episode}화에서 페이지 ${page} 파일을 못 찾음.`, 전체파일: all.map((f) => `${f.file}(p${f.page})`) };
  }
  // ★서명 URL에 개행/공백이 섞여 오면 <url|라벨> 마스킹이 깨진다(그 링크만 raw로 튐) → URL 공백 전부 제거.
  const clean = (u) => String(u || "").replace(/\s+/g, "");
  const slackLinks = out.map((f) => `<${clean(f.url)}|${f.file}>`).join(" · ");
  return { found: true, work: projName, episode, page: page || "전체", 파일수: out.length, slackLinks, files: out.map((f) => ({ ...f, url: clean(f.url) })) };
}

// ── 문의봇 '작업 관련 문의' 원문 자동 해석 ─────────────────────────
// 문의봇이 준 '원문 링크'(작업자 원본 스레드)를 읽어, 작업자가 올린 원문 이미지(중국어)를 비전으로 해석해
// 문의 스레드에 '핵심 1줄 + 접히는 코드블록'으로 답글. 이미지 있을 때만. (수정&리테이크=A는 스킵)
const INQUIRY_ORIG_LINK_RE = /https?:\/\/[a-z0-9.-]*slack\.com\/archives\/[^\s|>）)]+/i;
async function handleInquiryInterpret({ message, client }) {
  try {
    const ts = message.ts;
    if (processed.has("iq:" + ts)) return;
    const text = blockText(message);
    const linkM = text.match(/원문\s*링크[\s\S]{0,40}?(https?:\/\/[a-z0-9.-]*slack\.com\/archives\/[^\s|>）)]+)/i) || text.match(INQUIRY_ORIG_LINK_RE);
    if (!linkM) return;                                   // 원문 링크 없는 문의봇 메시지(부모·프로젝트 등)는 무시
    processed.add("iq:" + ts);
    const pl = parseSlackLink(linkM[1] || linkM[0]);
    if (!pl?.channel || !pl?.ts) return;
    // 부모(문의 원본)에서 문의 유형·작품·회차·내용
    const parentTs = message.thread_ts || ts;
    let parentText = "";
    try { const rr = await client.conversations.replies({ channel: message.channel, ts: parentTs, limit: 1 }); parentText = blockText((rr.messages || [])[0] || {}); } catch { /* 부모 못 읽으면 진행 */ }
    const inqType = (parentText.match(/\*문의 유형\*\s*\n?\s*([^\n*]+)/) || [])[1]?.trim() || "";
    if (/수정\s*&?(?:amp;)?\s*리테이크/.test(inqType)) return;   // A(승인만) 스킵
    if (inqType && !/작업\s*관련\s*문의/.test(inqType)) return;   // 지금은 '작업 관련 문의'만
    const work = (parentText.match(/\*작품명\*\s*\n?\s*([^\n*]+)/) || [])[1]?.trim() || "";
    const epRaw = (parentText.match(/\*회차\*\s*\n?\s*([^\n*]+)/) || [])[1]?.trim() || "";
    const inqContent = (parentText.match(/\*문의\s*내용\*\s*\n?\s*([\s\S]*?)(?::zap:|\n\s*:[a-z_]+:|$)/) || [])[1]?.trim() || "";
    // 원문 스레드 읽기 → 작업자가 올린 이미지 수집
    let rep;
    try { rep = await client.conversations.replies({ channel: pl.channel, ts: pl.ts, limit: 20 }); } catch { return; }
    let imgs = [];
    for (const m of (rep.messages || [])) {   // 첫 이미지 메시지(=작업자 원문 게시)만 — 뒤 back-and-forth 참고이미지 제외
      const mi = (m.files || []).filter((f) => (f.mimetype || "").startsWith("image/")).map((f) => ({ url: f.url_private_download || f.url_private, mimetype: f.mimetype, filetype: f.filetype, name: f.name }));
      if (mi.length) { imgs = mi.slice(0, 6); break; }
    }
    if (!imgs.length) return;                             // ★이미지 있을 때만(원문 OCR이 의미 있을 때)
    const att = await toAttachmentBlocks(imgs, 6);
    if (!att.blocks.length) return;
    const prompt = [
      "너는 중일(중국어 원작→일본어) 웹툰 로컬라이징 PM의 보조야. 아래 이미지는 작업자가 올린 '원문(중국어 웹툰 컷)'이고, 그에 대한 작업자 문의가 있어.",
      "이미지 속 중국어 원문을 **이미지마다** 빠짐없이 읽어 한국어로 옮기고, 문의(번역문)와의 수치·고유명사·대사 차이만 사실로 나열해라.",
      "★절대 판단·추론 금지: '모순이다/아니다', '설계 의도다', '이게 맞다', '수정하면 된다' 같은 결론이나 추측을 내지 마라. 원문이 실제로 뭐라 적혀 있는지와 번역문과의 차이(사실)만 제공한다 — 판정은 재상 님이 한다.",
      "인사말·군더더기 금지. 이미지가 여러 장이면 각 이미지를 [이미지1]/[이미지2]로 구분해 모두 옮겨라(누락 금지).",
      "출력 형식(엄수): 1줄차=핵심 한 줄(원문 사실 요약, 판단 아님). 그 뒤 줄들=이미지별 원문(중국어)→한국어 + 번역문과의 차이점.",
      "", `[작품] ${work} ${epRaw}`.trim(), "[문의 내용]", inqContent || "(별도 텍스트 없음 — 이미지 위주)",
    ].join("\n");
    const interp = await toollessVisionQuery([{ type: "text", text: prompt }, ...att.blocks], { label: `원문해석 ${work}`, channel: message.channel });
    if (!interp) return;
    // ④ 원본 PSD 링크 — 기본 OFF(env INQUIRY_ATTACH_PSD=1로 켬). 대부분 불필요 + 복수회차 표기 오파싱 위험이라 끔.
    // 필요하면 재상 님이 'N화 M페이지 원본 줘'로 즉시 요청(get_source_files, 마스킹 링크). 켤 땐 복수회차 파싱 보강 필요.
    // 회차 필드 '27-3,6p화'→ep27 p3,6 / '61-5화'→ep61 p5 / '145화'→페이지 없음(스킵).
    let psdLine = "";
    if (process.env.INQUIRY_ATTACH_PSD === "1") {
      try {
        const dash = String(epRaw).split("-");
        const ep1 = (dash[0].match(/\d+/) || [])[0];
        const pages = dash[1] ? (dash[1].match(/\d+/g) || []).join(",") : "";
        if (ep1 && pages) {
          const sf = await sourceFilesFor(work, ep1, pages);
          if (sf.found && sf.slackLinks) psdLine = `📦 *원본 ${ep1}화 ${pages}p* (${sf.파일수}): ${sf.slackLinks}`;
        }
      } catch { /* 원본 링크 실패는 무시 */ }
    }
    const lines = interp.split("\n");
    const head = (lines[0] || "").slice(0, 240);
    const detail = lines.slice(1).join("\n").trim();
    const out = [`🀄 *원문 해석* (자동)`, head]
      .concat(detail ? ["```", detail.slice(0, 2800), "```"] : [])
      .concat(psdLine ? [psdLine] : [])
      .join("\n");
    await client.chat.postMessage({ channel: message.channel, thread_ts: parentTs, text: out, ...SENDER, unfurl_links: false });
    console.log(`[inquiry-interpret] ${work} ${epRaw} 원문 해석 발송 (이미지 ${imgs.length}, PSD ${psdLine ? "O" : "X"})`);
  } catch (e) { console.error("[inquiry-interpret] 실패:", e?.message ?? e); }
}

// ── 리테이크 채널 자동 감지 → 중일 '번역 이슈'면 번역가 발송 초안을 박재상 DM으로(초안-우선/A모드) ──
// 자동 봇(n8n) 리테이크 메시지만 반응. 한일·식자 이슈는 스킵. 애매하면 박재상에게 질문. 발송은 항상 박재상 확인(버튼).
const RETAKE_WATCH_CHANNEL = process.env.RETAKE_WATCH_CHANNEL || "C09B8QBEC9L";
const RETAKE_BOT_ID = process.env.RETAKE_BOT_ID || "B0A2LM7NM6H";   // n8n 자동 리테이크 봇
const RETAKE_WF_ZH = "noEN9ahfD4Vbyj2V";   // 중일 리테이크 워크플로우
const RETAKE_WF_KO = "f1NgVwzUMeEb0CHf";   // 한일 리테이크 워크플로우

function parseRetakeMsg(text) {
  const t = text || "";
  const lang = (t.match(/(한일|중일)\s*리테이크\s*요청/) || [])[1] || null;
  const work = (t.match(/[•·]\s*작품명\s*[:：]\s*(.+)/) || [])[1]?.trim() || null;
  const ep = (t.match(/[•·]\s*리테이크\s*화수\s*[:：]\s*(.+)/) || [])[1]?.trim() || null;
  const fix = (t.match(/[•·]\s*수정\s*내용\s*[:：]\s*([\s\S]*?)(?=\n[•·]\s*제출\s*희망일|\n[•·]\s*프로젝트\s*URL|$)/) || [])[1]?.trim() || null;
  return { lang, work, ep, fix, zhWf: t.includes(RETAKE_WF_ZH), koWf: t.includes(RETAKE_WF_KO) };
}

function logRW(ts, p, decision) {
  try { appendFileSync("logs/retake-watch.jsonl", JSON.stringify({ at: new Date().toISOString(), ts, work: p.work, ep: p.ep, lang: p.lang, decision }) + "\n"); } catch { /* 무시 */ }
}

// 번역/식자 분류 (toolless LLM). {type:'번역'|'식자'|'애매', reason}
async function classifyRetake(fix) {
  if (!fix) return { type: "애매", reason: "수정내용 비어있음" };
  const prompt = [
    "다음은 웹툰 리테이크(수정 요청) 내용이다. '번역' 이슈인지 '식자' 이슈인지 분류하라.",
    "- 번역: 오역·직역·표현 부자연·대사/문구 수정·오탈자(문자 자체)·말투 등 *번역가*가 고칠 것.",
    "- 식자: 편집되지 않은 글자·세로/가로쓰기 방향·말풍선 꼬리·효과음 위치·클리핑·글자 편집 등 *식자(레터링)*가 고칠 것.",
    "둘 다 섞였거나 판단 곤란하면 '애매'. JSON만 출력: {\"type\":\"번역\"|\"식자\"|\"애매\",\"reason\":\"짧게\"}",
    "", "[리테이크 수정내용]", String(fix).slice(0, 1500),
  ].join("\n");
  const out = await toollessQuery(prompt, { label: "리테이크 분류" });
  try { const j = JSON.parse((out || "").match(/\{[\s\S]*\}/)?.[0] || "{}"); if (["번역", "식자", "애매"].includes(j.type)) return j; } catch { /* 파싱 실패 */ }
  return { type: "애매", reason: "분류 파싱 실패" };
}

// 리테이크 봇의 한국어(관리용) 수정내용 → 번역가(전원 일본인)에게 그대로 전달 가능한 일본어 문구로 변환.
// propose_retake 시스템프롬프트 규칙과 동일한 스타일('오류원문→수정문', 한국어 사유는 일역).
async function translateFixToJapanese(fix) {
  if (!fix) return "";
  const prompt = [
    "다음은 웹툰 리테이크(번역 수정 요청) 내용이다. 번역가(전원 일본인)에게 그대로 전달할 수 있도록 일본어 문장으로만 다시 작성하라.",
    "- 이미 일본어로 된 인용(원문/수정문)은 그대로 유지하고, 한국어 설명 부분만 자연스러운 일본어로 옮긴다.",
    "- 가능하면 건마다 '오류원문→수정문' 형태로 정리한다(예: 「楽」→「樂」 修正してください).",
    "- 여러 건이면 줄바꿈으로 구분한다.",
    "- 다른 설명 없이 일본어 문장만 출력하라(번호매기기·따옴표 등 부가 표시 불필요).",
    "", "[원본 수정내용]", String(fix).slice(0, 1500),
  ].join("\n");
  const out = await toollessQuery(prompt, { label: "리테이크 일역" });
  return (out || "").trim() || fix;
}

async function dmOwner(text) {
  try { const dm = await app.client.conversations.open({ users: DISPATCHER_USER_ID }); if (dm.channel?.id) return await app.client.chat.postMessage({ channel: dm.channel.id, text, ...SENDER }); } catch (e) { console.error("[retake-watch] DM 실패:", e?.message ?? e); }
}

async function handleRetakeWatch({ message, client }) {
  try {
    const ts = message.ts;
    if (processed.has("rw:" + ts)) return;
    processed.add("rw:" + ts);
    if (message.bot_id !== RETAKE_BOT_ID) return;              // 자동 봇 메시지만
    const p = parseRetakeMsg(message.text || "");
    // 1) 한일/중일 판별 — 본문 명시 or 워크플로우 ID. 한일이면 스킵.
    const isZh = p.lang === "중일" || (p.zhWf && !p.koWf);
    const isKo = p.lang === "한일" || (p.koWf && !p.zhWf);
    if (!p.work) { logRW(ts, p, "skip:작품명없음"); return; }
    if (isKo && !isZh) { logRW(ts, p, "skip:한일"); return; }
    // 2) 작품 매칭(중일 마스터) — 정확 1건이 이상적
    const idx = await koTitleIndex();
    const wn = norm(p.work);
    const exact = idx.filter((x) => x.koNorm === wn);
    const loose = idx.filter((x) => x.koNorm && x.koNorm.length >= 2 && (wn.includes(x.koNorm) || x.koNorm.includes(wn)));
    const cand = exact.length ? exact : loose;
    if (!isZh && cand.length === 0) { logRW(ts, p, "skip:한일추정(매칭0)"); return; }   // 중일 명시 없고 매칭도 0 → 한일로 보고 스킵
    // 3) 번역/식자 분류 — 식자면 스킵(번역가 대상 아님)
    const cls = await classifyRetake(p.fix || "");
    if (cls.type === "식자") { logRW(ts, p, "skip:식자"); return; }
    // 4) 애매(유형 애매 or 작품 매칭 1건 아님) → 박재상에게 질문(초안-우선이라 어차피 박재상에게 감)
    const jpFix = await translateFixToJapanese(p.fix);   // 번역가는 전원 일본인 — 전달용은 항상 일본어로 준비해둔다.
    if (cls.type === "애매" || cand.length !== 1) {
      const why = [cand.length !== 1 ? `작품 매칭 ${cand.length}건` : "", cls.type === "애매" ? `유형 애매(${cls.reason || ""})` : ""].filter(Boolean).join(" / ");
      await dmOwner(`🔁 *리테이크 확인 필요* (자동 감지)\n• 작품: *${p.work}* / 화수: ${p.ep || "?"}\n• 사유: ${why}\n• 번역가 전달용(일본어):\n${jpFix}\n→ 번역가에게 보낼 거면 \`propose_retake\`로 지시해줘 (작품·회차 그대로, 수정내용은 위 일본어 문구 그대로 사용).`);
      logRW(ts, p, `ask:${cls.type}/cand${cand.length}`);
      return;
    }
    // 5) 명확(중일 확정 + 번역 + 매칭 1건) → 번역가 발송 초안을 박재상 DM으로(발송은 버튼)
    const rk = await buildRetake({ work: p.work, episode: p.ep || "", fix: jpFix || p.fix || "" });
    if (!rk.found || !rk.target) {
      await dmOwner(`🔁 *리테이크 초안 실패* — *${p.work}* ${p.ep || ""}\n• ${!rk.found ? "작품 못 찾음" : "번역가/채널 못 찾음"} → 필요하면 propose_retake로 수동 처리.`);
      logRW(ts, p, "ask:buildfail");
      return;
    }
    const warn = [];
    if (rk.missing.editor) warn.push("식자검수 에디터 URL 못 찾음");
    if (rk.missing.apm) warn.push("APM cc 생략");
    if (rk.missing.trId) warn.push("번역가 Slack ID 미매핑(멘션 평문)");
    const rkId = `rk_${++retakeSeq}`;
    const pp = { target: rk.target, targetKind: rk.targetKind, headerReal: rk.headerReal, headerPreview: rk.headerPreview, body: rk.body, koTitle: rk.koTitle, epText: rk.epText, translator: rk.translator, trId: rk.trId, apmId: rk.apmId, editorKind: rk.editorKind, warn, createdAt: Date.now() };
    pendingRetakes.set(rkId, pp);
    try {
      const dm = await client.conversations.open({ users: DISPATCHER_USER_ID });
      const posted = await client.chat.postMessage({ channel: dm.channel.id, ...SENDER, text: `자동 감지 리테이크 초안: ${rk.jpTitle} ${rk.epText} → ${rk.translator || "?"}`,
        blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: `🤖 리테이크 채널에서 자동 감지 — *번역 이슈*로 판단(${cls.reason || ""}). 확인 후 발송하세요.` }] }, ...retakeBlocks(rkId, pp)] });
      pp.previewChannel = posted.channel; pp.previewTs = posted.ts;
      pendingRetakes.save();
    } catch (e) { console.error("[retake-watch] 초안 발송 실패:", e?.message ?? e); }
    logRW(ts, p, `draft:${rkId}`);
    console.log(`[retake-watch] 초안 → 박재상 DM: ${p.work} ${p.ep || ""} (${cls.type})`);
  } catch (e) { console.error("[retake-watch] 실패:", e?.message ?? e); }
}

// ── 수급 안내(설정집/타이틀 로고) 자동 감지 → 배정 작업자 + 채널 링크(+설정집이면 프로젝트 링크) 스레드 답글 ──
const SUPPLY_NOTICE_CHANNEL = process.env.SUPPLY_NOTICE_CHANNEL || "C09B8QLR5FG";
const SUPPLY_BOTS = { "B0B77NK250T": "FIX 설정집", "B0B103Z57T9": "타이틀 로고" };   // 도착 안내 봇 → 종류
const WORKER_DB_SHEET = "1lvHDrNCiBplWlfIdAgI2iYNPAFWGrHYlqxjjebnFpE8";              // 작업자 DB!A:F (A이름 C slack D channel)
const SUPPLY_ROLES = [["번역", "번역 skip"], ["번역검수", "번역검수 skip"], ["식자", "식자 skip"], ["식번검", "식번검 skip"], ["식자검수", "식자검수 skip"]];
// 타이틀 로고는 식자 작업 관련만(식자·식자검수), 설정집은 전 역할
const ROLES_BY_KIND = { "타이틀 로고": [["식자", "식자 skip"], ["식자검수", "식자검수 skip"]] };
function blockText(m) {
  const parts = []; const walk = (o) => { if (!o) return; if (Array.isArray(o)) return o.forEach(walk); if (typeof o === "object") { if (typeof o.text === "string") parts.push(o.text); else if (o.text) walk(o.text); for (const k in o) if (!["text", "type", "verbatim", "block_id", "emoji", "style"].includes(k)) walk(o[k]); } };
  walk(m.blocks); return (m.text ? m.text + "\n" : "") + parts.join("\n");
}
let _wdb = null, _wdbAt = 0;
async function workerChannelMap() {
  if (_wdb && Date.now() - _wdbAt < 600000) return _wdb;
  const rows = (await readRangeRO(WORKER_DB_SHEET, "작업자 DB!A:F")).slice(1);
  const map = new Map();
  for (const r of rows) { const nm = String(r[0] || "").trim(); if (nm) map.set(norm(nm), { name: nm, slackId: String(r[2] || "").trim(), channel: String(r[3] || "").trim() }); }
  _wdb = map; _wdbAt = Date.now(); return map;
}
async function handleSupplyNotice({ message, client }) {
  try {
    const ts = message.ts;
    if (processed.has("sn:" + ts)) return; processed.add("sn:" + ts);
    const text = blockText(message);
    const kind = SUPPLY_BOTS[message.bot_id] || (/설정집.{0,6}도착\s*안내/.test(text) ? "FIX 설정집" : /타이틀.{0,6}도착\s*안내/.test(text) ? "타이틀 로고" : null);
    if (!kind) return;
    const work = (text.match(/타이틀\s*[:：]\s*(.+)/) || [])[1]?.trim();
    if (!work) { console.log("[supply] 작품명 못 찾음"); return; }
    let row = null;
    for (const op of ["eq", "contains"]) {
      try { const t = await readTab({ sheet: "ops", tab: "배정 현황", where: { field: "한국어타이틀", op, value: work }, limit: 1 }); if (t.rows[0]) { row = t.rows[0]; break; } } catch { /* 무시 */ }
    }
    const lines = [];
    if (row) {
      const wmap = await workerChannelMap();
      for (const [role, skipF] of (ROLES_BY_KIND[kind] || SUPPLY_ROLES)) {
        const nm = String(row[role] || "").trim();
        if (!nm || String(row[skipF] || "").toUpperCase() === "TRUE") continue;
        const w = wmap.get(norm(nm));
        lines.push(`• ${role}: ${nm} ${w?.channel ? `<#${w.channel}>` : "_(채널 미등록)_"}`);
      }
    }
    let projLine = "";
    if (kind === "FIX 설정집") {
      try { const fp = await findProject(row?.pivo_id || work); const proj = (fp?.data || [])[0]; if (proj?.uuid) projLine = `\n🔗 프로젝트: https://admin.totus.pro/ko/workProgressManagementDetail/?id=${proj.uuid}`; } catch { /* 무시 */ }
    }
    const head = `📋 *${work}* — ${kind} 도착 · 배정 작업자`;
    const body = lines.length ? lines.join("\n") : "_배정 현황에서 작업자를 못 찾았어요 (한국어타이틀 표기 확인)_";
    await client.chat.postMessage({ channel: message.channel, thread_ts: ts, text: `${head}\n${body}${projLine}`, ...SENDER, unfurl_links: false });
    console.log(`[supply] ${kind} ${work} → 작업자 ${lines.length}명`);
  } catch (e) { console.error("[supply] 실패:", e?.message ?? e); }
}

// ── 부팅 ──────────────────────────────────────────────────────────
const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// DM (message.im) — 본인 DM만, 봇/수정 이벤트 제외
app.message(async ({ message, say, client }) => {
  // 수급 안내 채널 — 설정집/타이틀 로고 도착 안내면 배정 작업자+채널 링크 답글
  if (message.channel === SUPPLY_NOTICE_CHANNEL && (SUPPLY_BOTS[message.bot_id] || /도착\s*안내/.test(message.text || ""))) {
    await handleSupplyNotice({ message, client });
    return;
  }
  // 리테이크 채널 자동 감지 — 자동 봇 메시지에서 중일·번역 이슈면 번역가 발송 초안을 박재상 DM으로
  if (message.channel === RETAKE_WATCH_CHANNEL) {
    if (message.bot_id === RETAKE_BOT_ID && message.text) await handleRetakeWatch({ message, client });
    return;
  }
  // 워치 채널 자동 링크 — 박재상 or 문의봇 메시지에서 작품명 감지 → 프로젝트/원본 링크(선제)
  if (WORK_LINK_WATCH.has(message.channel)) {
    const edited = message.subtype && !["file_share", "bot_message"].includes(message.subtype);   // 편집·삭제 제외
    const fromOwner = message.user === OWNER_ID;
    const fromInquiry = message.bot_id === INQUIRY_BOT_ID;   // 문의봇만(툰식이 자신 제외)
    if (!edited && (fromOwner || fromInquiry) && message.text) {
      await handleWorkLinkWatch({ text: message.text, channel: message.channel, ts: message.ts, threadTs: message.thread_ts, client });
    }
    // 문의봇 '작업 관련 문의'의 원문 링크 메시지면 → 원문(이미지) 자동 해석 답글(내부에서 유형·이미지 게이트)
    if (!edited && fromInquiry) await handleInquiryInterpret({ message, client });
    return;   // 워치 채널은 여기서 종료(멘션은 app_mention이 별도 처리)
  }
  if (message.channel_type !== "im") return;           // DM만 (채널 노이즈 차단)
  // 파일 첨부 메시지는 subtype="file_share"라 통과시켜야 함(설정집 업로드 등). 편집·삭제·봇 메시지만 무시.
  if ((message.subtype && message.subtype !== "file_share") || message.bot_id) return;
  await handle({
    text: message.text, channel: message.channel, ts: message.ts,
    threadTs: message.thread_ts || message.ts, inThread: Boolean(message.thread_ts),
    user: message.user, client, say, files: message.files,
  });
});

// 멘션 (@봇) — 채널/스레드에서 소환
app.event("app_mention", async ({ event, say, client }) => {
  await handle({
    text: event.text, channel: event.channel, ts: event.ts,
    threadTs: event.thread_ts || event.ts, inThread: Boolean(event.thread_ts),
    user: event.user, client, say, files: event.files,
  });
});

// ── 어시스턴트(에이전트) 패널 — 지금 보는 스레드 맥락으로 추천 프롬프트 + 브레인 라우팅 ──
// 패널이 보고 있는 채널/스레드를 assistantCtx에 기록 → handle()이 '이 스레드' 지시를 해석. 메시지는 handle로(ts중복차단으로 이중응답 없음).
const assistantCtx = new Map();   // userId → { channel_id, thread_ts, at }  (보고 있는 곳)
const assistantPanel = new Map(); // userId → { channel_id, thread_ts, at }  (패널 자기 스레드 — 숏컷/응답을 여기로 모음)
async function assistantPrompts(client, c) {
  const prompts = [];
  try {
    let text = "";
    if (c?.thread_ts) { const r = await client.conversations.replies({ channel: c.channel_id, ts: c.thread_ts, limit: 20 }); text = (r.messages || []).map((m) => m.text || "").join("\n"); }
    else if (c?.channel_id) { const r = await client.conversations.history({ channel: c.channel_id, limit: 12 }); text = (r.messages || []).map((m) => m.text || "").join("\n"); }
    if (/재수급\s*사유\s*[:：]/.test(text)) prompts.push({ title: "고객사 재수급 초안 만들기", message: "지금 보고 있는 재수급 요청을 고객사용 일본어 초안으로 만들어줘" });
    if (/리테이크\s*화수|리테이크\s*요청|리테이크\s*내용/.test(text)) prompts.push({ title: "번역가에게 리테이크 전달", message: "지금 보고 있는 리테이크를 번역가에게 전달할 일본어 초안 만들어줘" });
    const idx = await koTitleIndex(); const tn = norm(text);
    const hit = idx.filter((x) => x.koNorm && x.koNorm.length >= 2 && tn.includes(x.koNorm)).sort((a, b) => b.koNorm.length - a.koNorm.length)[0];
    if (hit) prompts.push({ title: `${hit.koTitle} 프로젝트·납품일`, message: `${hit.koTitle} 프로젝트 링크랑 최신 납품일 알려줘` });
    prompts.push({ title: "이 채널 최근 상황 요약", message: "지금 보고 있는 채널의 최근 대화를 짧게 요약해줘 (특정 스레드가 필요하면 물어봐)" });
  } catch { /* 무시 */ }
  return prompts.slice(0, 4);
}
const assistant = new Assistant({
  threadStarted: async ({ event, say, setSuggestedPrompts, saveThreadContext, client }) => {
    try {
      const c = event.assistant_thread?.context || {};
      const uid = event.assistant_thread?.user_id;
      if (uid && !ALLOWED_USERS.has(uid)) return;   // 박재상+허용 APM만 인사말·추천버튼(그 외엔 조용)
      if (uid && c.channel_id) assistantCtx.set(uid, { channel_id: c.channel_id, thread_ts: c.thread_ts || null, at: Date.now() });
      if (uid && event.assistant_thread?.channel_id) assistantPanel.set(uid, { channel_id: event.assistant_thread.channel_id, thread_ts: event.assistant_thread.thread_ts, at: Date.now() });
      await say({ text: "안녕하세요 재상 님 🙌 지금 보고 있는 곳 기준으로 도와드릴게요. 아래 버튼을 쓰거나, 스레드 '...' → 툰식이 숏컷으로 시키면 답이 여기로 모여요.", ...SENDER }).catch(() => {});
      const prompts = await assistantPrompts(client, c);
      if (prompts.length) await setSuggestedPrompts({ title: "이런 걸 할 수 있어요", prompts }).catch(() => {});
      await saveThreadContext().catch(() => {});
    } catch (e) { console.error("[assistant] threadStarted:", e?.message ?? e); }
  },
  threadContextChanged: async ({ event, saveThreadContext }) => {
    try {
      const c = event.assistant_thread?.context || {};
      const uid = event.assistant_thread?.user_id;
      if (uid && c.channel_id) assistantCtx.set(uid, { channel_id: c.channel_id, thread_ts: c.thread_ts || null, at: Date.now() });
      if (uid && event.assistant_thread?.channel_id) assistantPanel.set(uid, { channel_id: event.assistant_thread.channel_id, thread_ts: event.assistant_thread.thread_ts, at: Date.now() });
      await saveThreadContext().catch(() => {});
    } catch (e) { console.error("[assistant] ctxChanged:", e?.message ?? e); }
  },
  userMessage: async ({ message, say, setStatus, client }) => {
    try {
      // 파일 업로드는 subtype="file_share"라 그냥 subtype 컷하면 설정집 첨부가 통째로 무시된다.
      // → file_share는 통과시키고 files를 handle로 넘긴다(텍스트도 첨부도 없을 때만 컷).
      const hasFiles = Array.isArray(message.files) && message.files.length > 0;
      if ((message.subtype && message.subtype !== "file_share") || message.bot_id) return;
      if ((!message.text || !message.text.trim()) && !hasFiles) return;
      if (!ALLOWED_USERS.has(message.user)) return;
      await setStatus("생각 중…").catch(() => {});
      await handle({ text: message.text, channel: message.channel, ts: message.ts, threadTs: message.thread_ts, inThread: false, user: message.user, client, say, files: message.files });
    } catch (e) { console.error("[assistant] userMessage:", e?.message ?? e); }
  },
});
if (process.env.ASSISTANT_UI === "1") { app.assistant(assistant); console.log("[assistant] 에이전트 패널 ON"); }

// ── 메시지 숏컷 — 보고 있는 스레드의 '...' 메뉴에서 툰식이 소환(thread_ts 정확 전달). 링크 불필요 ──
// 슬랙 앱 설정: Interactivity & Shortcuts → Create New Shortcut → On messages, callback_id = toonsik_thread
app.shortcut("toonsik_thread", async ({ shortcut, ack, client }) => {
  await ack();
  try {
    if (!ALLOWED_USERS.has(shortcut.user?.id)) return;
    const channel = shortcut.channel?.id;
    const threadTs = shortcut.message?.thread_ts || shortcut.message?.ts || shortcut.message_ts;
    const msgText = String(shortcut.message?.text || "").slice(0, 1800);   // 채널 못 읽을 때 폴백(슬랙이 payload로 줌)
    console.log(`[shortcut] toonsik_thread ch=${channel} thread=${threadTs} textLen=${msgText.length}`);
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: {
        type: "modal", callback_id: "toonsik_thread_modal",
        private_metadata: JSON.stringify({ channel, threadTs, msgText }),
        title: { type: "plain_text", text: "툰식이에게 시키기" },
        submit: { type: "plain_text", text: "실행" }, close: { type: "plain_text", text: "닫기" },
        blocks: [
          { type: "input", block_id: "cmd", optional: true,
            label: { type: "plain_text", text: "이 스레드로 뭘 할까요?" },
            element: { type: "plain_text_input", action_id: "v", multiline: true, placeholder: { type: "plain_text", text: "예: 요약해줘 / 필요한 액션 추천 / 이 재수급 고객사 초안 만들어줘" } } },
          { type: "context", elements: [{ type: "mrkdwn", text: "비워두면 요약+액션 추천. 답은 툰식이 DM으로 와요." }] },
        ],
      },
    });
  } catch (e) { console.error("[shortcut] toonsik_thread:", e?.message ?? e); }
});
app.view("toonsik_thread_modal", async ({ ack, body, view, client }) => {
  await ack();
  try {
    const user = body.user?.id;
    if (!ALLOWED_USERS.has(user)) return;
    const { channel, threadTs, msgText } = JSON.parse(view.private_metadata || "{}");
    const cmd = (view.state.values?.cmd?.v?.value || "").trim() || "이 스레드를 짧게 요약하고, 지금 필요한 액션이 있으면 추천해줘";
    // 응답은 어시스턴트 패널(하나의 대화)로 모은다 — 패널을 최근 열었으면 그 스레드로, 아니면 툰식이 DM 최상위로
    const panel = assistantPanel.get(user);
    let targetCh, targetThread;
    if (panel?.channel_id && Date.now() - panel.at < 6 * 3600 * 1000) { targetCh = panel.channel_id; targetThread = panel.thread_ts; }
    else { const dm = await client.conversations.open({ users: user }); targetCh = dm.channel?.id; targetThread = undefined; }
    if (!targetCh) return;
    // 스레드 읽기 시도 → 실패하면 공개채널 입장 후 재시도 → 그래도 안 되면 클릭한 메시지 텍스트(payload) 폴백
    let tc = await fetchThreadContext(client, channel, threadTs).catch(() => ({ text: "", attFiles: [] }));
    if (!tc.text) { try { await client.conversations.join({ channel }); tc = await fetchThreadContext(client, channel, threadTs); } catch { /* join 스코프 없거나 비공개 → 폴백 */ } }
    const ctxText = (tc.text && tc.text.trim()) ? tc.text : (msgText || "(스레드 내용을 못 읽음 — 봇이 그 채널 멤버가 아닐 수 있음)");
    const nowStr = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "full", timeStyle: "short" });
    const llmText = `[현재 시각(KST): ${nowStr}] [요청자: ${USER_NAMES[user] || "사용자"}] [메시지 숏컷 — 아래 스레드/메시지를 대상으로 명령. 이 맥락을 그 대상으로 삼아 처리하라. 링크/추가 조회 요구하지 말고 이걸로 처리]\n[대상 맥락 (${channel})]\n${ctxText.slice(0, 4000)}\n\n[요청]\n${cmd}`;
    const ph = await client.chat.postMessage({ channel: targetCh, thread_ts: targetThread, text: `🧵 숏컷 처리 중… (${cmd.slice(0, 30)})`, ...SENDER });
    if (!BRAIN_ON) { await client.chat.postMessage({ channel: targetCh, thread_ts: targetThread, text: `🔌 브레인 오프(에코):\n> ${cmd}`, ...SENDER }); return; }
    const entry = { client, channel: targetCh, threadTs: targetThread, ts: ph?.ts, placeholderTs: ph?.ts, startedAt: Date.now(), done: false };
    queue.push({ content: llmText, ctx: entry, attachTexts: [], fileRefs: [], user });
    if (wake) { const w = wake; wake = null; w(); }
  } catch (e) { console.error("[shortcut] modal submit:", e?.message ?? e); }
});

// ── 게이트형 쓰기: 확인/취소 버튼 (실제 쓰기는 LLM 밖, 여기서만) ──────
app.action("delivery_edit_confirm", async ({ ack, body, client }) => {
  await ack();
  const changeId = body.actions?.[0]?.value;
  const chan = body.channel?.id;
  const thread = body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel: chan, thread_ts: thread, text: t, ...SENDER }).catch(() => {});
  if (body.user?.id !== DISPATCHER_USER_ID) return reply("권한 없는 사용자예요.");
  const p = pendingEdits.get(changeId);
  if (!p) return reply("⌛ 만료됐거나 이미 처리된 변경이에요. 다시 요청해줘.");
  pendingEdits.delete(changeId);
  if (Date.now() - p.createdAt > EDIT_TTL_MS) return reply("⌛ 확인 시간이 지나 취소됐어요. 다시 요청해줘.");
  const verb = p.clearing ? "삭제" : "반영";
  try {
    const cells = p.items.map((it) => it.cellA1);
    const cur = await getCells(p.sheetId, cells);             // staleness 일괄 재확인
    const apply = [], stale = [];
    p.items.forEach((it, i) => {
      if (String(cur[i] ?? "").trim() !== String(it.oldValue ?? "").trim()) stale.push({ ...it, now: cur[i] });
      else apply.push(it);
    });
    if (apply.length) {
      await setCells(p.sheetId, apply.map((it) => ({ a1: it.cellA1, value: p.newValue })));
      for (const it of apply) appendFileSync("logs/edits.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, cell: it.cellA1, work: p.workName, episode: it.episode, from: it.oldValue, to: p.newValue, clearing: !!p.clearing }) + "\n");
    }
    const okEps = apply.map((it) => it.episode);
    let msg = apply.length
      ? `✅ ${verb} 완료 — ${p.workName} ${compactRanges(okEps)}화 (${apply.length}건) 납품일 → ${p.newValue || "(빈칸·삭제됨)"}`
      : `⚠️ 반영된 게 없어요.`;
    if (stale.length) msg += `\n⚠️ 그새 값이 바뀌어 건너뜀: ${stale.map((s) => `${s.episode}화('${s.now}')`).join(", ")} — 다시 확인하고 요청해줘.`;
    await reply(msg);
  } catch (e) {
    await reply(`❌ ${verb} 실패: ${e?.message ?? e}\n(SA가 '${p.tab}' 시트의 *편집자*인지 확인 필요)`);
  }
});

app.action("delivery_edit_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingEdits.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
});

// ── TOTUS 납품예정일 변경 확인/취소 (실제 MUTATION은 LLM 밖, 여기서만) ──────
app.action("totus_date_confirm", async ({ ack, body, client }) => {
  await ack();
  const changeId = body.actions?.[0]?.value;
  const chan = body.channel?.id;
  const thread = body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel: chan, thread_ts: thread, text: t, ...SENDER }).catch(() => {});
  if (body.user?.id !== DISPATCHER_USER_ID) return reply("권한 없는 사용자예요.");
  const p = pendingTotusDates.get(changeId);
  if (!p) return reply("⌛ 만료됐거나 이미 처리된 변경이에요. 다시 요청해줘.");
  pendingTotusDates.delete(changeId);
  if (Date.now() - p.createdAt > EDIT_TTL_MS) return reply("⌛ 확인 시간이 지나 취소됐어요. 다시 요청해줘.");
  const eps = p.items.map((it) => it.episode);
  try {
    const res = await setDeliveryDate(p.items.map((it) => ({ jobProcessUuid: it.jobProcessUuid, deliveryDate: p.deliveryDate, modificationReason: p.reason })), false);
    appendFileSync("logs/totus-dates.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, work: p.work, episodes: eps, jobProcessUuids: p.items.map((it) => it.jobProcessUuid), to: p.deliveryDate, reason: p.reason, ok: res?.success, resp: res?.data }) + "\n");
    if (res?.success) {
      const failed = res?.data?.failedJobProcessUuids || [];
      if (failed.length) await reply(`⚠️ 일부만 변경됨 — ${p.work}: 성공 ${res?.data?.성공 ?? (p.items.length - failed.length)}건 / 실패 ${failed.length}건. 실패 건 회차 확인 필요.`);
      else await reply(`✅ TOTUS 납품예정일 변경 완료 — ${p.work} ${compactRanges(eps)}화 (${p.items.length}건) → ${p.deliveryDate} (PIVO 자동 반영)`);
    } else await reply(`❌ 변경 실패 — 실패 ${res?.data?.실패 ?? "?"}건 (failed: ${JSON.stringify(res?.data?.failedJobProcessUuids || [])}). 회차/uuid 확인 필요.`);
  } catch (e) {
    await reply(`❌ 변경 실패: ${e?.message ?? e}`);
  }
});

app.action("totus_date_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingTotusDates.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
});

// ── TOTUS 프로젝트 이름/상태 변경 확인/취소 (실제 PATCH는 LLM 밖, 여기서만) ──
app.action("proj_confirm", async ({ ack, body, client }) => {
  await ack();
  const id = body.actions?.[0]?.value;
  const chan = body.channel?.id, thread = body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel: chan, thread_ts: thread, text: t, ...SENDER }).catch(() => {});
  if (body.user?.id !== DISPATCHER_USER_ID) return reply("권한 없는 사용자예요.");
  const p = pendingTotusProj.get(id);
  if (!p) return reply("⌛ 만료됐거나 이미 처리된 변경이에요.");
  pendingTotusProj.delete(id);
  if (Date.now() - p.createdAt > EDIT_TTL_MS) return reply("⌛ 확인 시간이 지나 취소됐어요. 다시 요청해줘.");
  const steps = p.steps || [p.change];   // 단일/복수 변경 공용(완결=이름+상태 2단계). API는 한 번에 하나라 순차 PATCH.
  try {
    const done = [], failed = [];
    for (const ch of steps) {
      try {
        const res = await setProjectSettings(p.projectUuid, ch);
        appendFileSync("logs/totus-proj.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, projectUuid: p.projectUuid, projectName: p.projectName, change: ch, ok: res?.success, resp: res?.data }) + "\n");
        if (res?.success) done.push(ch); else failed.push({ ch, resp: res });
      } catch (e) { failed.push({ ch, err: String(e?.message ?? e) }); }
    }
    const desc = (c) => c.action ? `상태 ${TOTUS_ACTION_KO[c.action] || c.action}` : `이름 변경`;
    let sheetMsg = "";
    if (p.sheet?.pivo) {   // 번역개시 체인: TOTUS 이름 변경 후 출판사 시트 A(APM)·C(한국어) 채움
      try {
        const sr = await updatePublisherSheet(p.sheet.pivo, p.sheet.apmName, p.sheet.koTitle);
        sheetMsg = sr.ok ? `\n📄 출판사 시트 ${sr.row}행 반영(한국어${p.sheet.apmName ? "·APM" : ""})` : `\n⚠️ 출판사 시트 미반영: ${sr.msg}`;
        appendFileSync("logs/totus-proj.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, kind: "publisher_sheet", pivo: p.sheet.pivo, apm: p.sheet.apmName, ko: p.sheet.koTitle, result: sr }) + "\n");
      } catch (e) { sheetMsg = `\n⚠️ 출판사 시트 반영 실패: ${e?.message ?? e}`; }
    }
    if (p.sheet?.delivery) {   // 번역개시 체인: 납품 시트에 초도 회차(1~N) 행 생성
      try {
        const dr = await appendDeliveryRows(p.sheet.delivery);
        sheetMsg += dr.ok ? `\n📦 납품 시트 ${dr.fromRow}행부터 1~${dr.count}화 ${dr.count}개 생성` : `\n⚠️ 납품 시트 미반영: ${dr.msg}`;
        appendFileSync("logs/totus-proj.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, kind: "delivery_rows", pivo: p.sheet.pivo, result: dr }) + "\n");
      } catch (e) { sheetMsg += `\n⚠️ 납품 시트 반영 실패: ${e?.message ?? e}`; }
    }
    if (!failed.length) await reply(`✅ TOTUS 변경 완료 — ${p.projectName || p.projectUuid}: ${done.map(desc).join(" + ")}${sheetMsg}`);
    else await reply(`⚠️ 일부 실패 — 성공: ${done.map(desc).join(", ") || "없음"} / 실패: ${failed.map((f) => desc(f.ch)).join(", ")}. 실패분만 다시 시도해줘.${sheetMsg}`);
  } catch (e) { await reply(`❌ 변경 실패: ${e?.message ?? e}`); }
});

app.action("proj_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingTotusProj.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
});

// ── TOTUS 태스크 리테이크 확인/취소 (연결 태스크 생성, 실제 호출은 여기서만) ──
app.action("task_retake_confirm", async ({ ack, body, client }) => {
  await ack();
  const id = body.actions?.[0]?.value;
  const chan = body.channel?.id, thread = body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel: chan, thread_ts: thread, text: t, ...SENDER }).catch(() => {});
  if (body.user?.id !== DISPATCHER_USER_ID) return reply("권한 없는 사용자예요.");
  const p = pendingTaskRetake.get(id);
  if (!p) return reply("⌛ 만료됐거나 이미 처리된 요청이에요.");
  pendingTaskRetake.delete(id);
  if (Date.now() - p.createdAt > EDIT_TTL_MS) return reply("⌛ 확인 시간이 지나 취소됐어요. 다시 요청해줘.");
  const done = [], failed = [];
  const createdUuids = [];
  for (const it of p.items) {
    try {
      const res = await retakeTask(it.taskUuid);
      appendFileSync("logs/totus-retake.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, work: p.work, operation: p.operation, episode: it.episode, taskUuid: it.taskUuid, ok: res?.success, created: res?.data?.createdTaskUuids }) + "\n");
      if (res?.success) { done.push(it.episode); createdUuids.push(...(res?.data?.createdTaskUuids || [])); }
      else failed.push({ episode: it.episode, resp: res });
    } catch (e) { failed.push({ episode: it.episode, err: String(e?.message ?? e) }); }
  }
  const lines = [`🔁 *${p.work}* (${p.operation}) 리테이크 결과`];
  if (done.length) lines.push(`✅ 성공 ${done.length}건: ${compactRanges(done)}화`);
  if (failed.length) lines.push(`❌ 실패 ${failed.length}건: ${failed.map((f) => `${f.episode}화(${f.err || f.resp?.error || "오류"})`).join(", ")}`);
  // 새로 생성된 태스크들에 일정(당일 기본값 또는 지정값) 일괄 입력.
  if (createdUuids.length) {
    try {
      const dr = await setTaskDates(createdUuids.map((taskUuid) => ({ taskUuid, startDate: p.startDate, endDate: p.endDate })));
      const ok = dr?.data?.성공 ?? 0, fail = dr?.data?.실패 ?? 0;
      appendFileSync("logs/totus-retake.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, work: p.work, kind: "setTaskDates", startDate: p.startDate, endDate: p.endDate, taskCount: createdUuids.length, ok, fail }) + "\n");
      lines.push(`📅 새 태스크 일정(${p.startDate}${p.endDate !== p.startDate ? `~${p.endDate}` : ""}) 입력: 성공 ${ok}건${fail ? `, 실패 ${fail}건` : ""}`);
    } catch (e) { lines.push(`📅 일정 입력 실패: ${e?.message ?? e}`); }
  }
  await reply(lines.join("\n"));
});
app.action("task_retake_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingTaskRetake.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
});

// ── 발송 확인/취소 (실제 발송은 LLM 밖, 여기서만) ──────────────────
app.action("send_confirm", async ({ ack, body, client }) => {
  await ack();
  const id = body.actions?.[0]?.value;
  const chan = body.channel?.id, thread = body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel: chan, thread_ts: thread, text: t, ...SENDER }).catch(() => {});
  if (body.user?.id !== DISPATCHER_USER_ID) return reply("권한 없는 사용자예요.");
  const p = pendingSends.get(id);
  if (!p) return reply("⌛ 만료됐거나 이미 처리된 발송이에요.");
  pendingSends.delete(id);
  if (Date.now() - p.createdAt > EDIT_TTL_MS) return reply("⌛ 확인 시간이 지나 취소됐어요. 다시 요청해줘.");

  if (p.items) {
    const results = [];
    for (const it of p.items) {
      try {
        await client.chat.postMessage({ channel: it.target, text: it.text, ...SENDER });
        appendFileSync("logs/sends.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, target: it.target, threadTs: null, text: it.text }) + "\n");
        results.push({ target: it.target, ok: true });
      } catch (e) {
        results.push({ target: it.target, ok: false, err: e?.message ?? String(e) });
      }
    }
    const okList = results.filter((r) => r.ok).map((r) => (r.target.startsWith("C") ? `<#${r.target}>` : `<@${r.target}>`));
    const failList = results.filter((r) => !r.ok);
    let msg = `✅ 발송 완료 ${okList.length}/${results.length}건`;
    if (failList.length) msg += `\n❌ 실패: ${failList.map((f) => `${f.target.startsWith("C") ? `<#${f.target}>` : `<@${f.target}>`}(${f.err})`).join(", ")}`;
    await reply(msg);
    return;
  }

  try {
    if (p.threadTs) { try { await client.conversations.join({ channel: p.target }); } catch {} }
    await client.chat.postMessage({ channel: p.target, text: p.text, thread_ts: p.threadTs || undefined, ...SENDER });
    appendFileSync("logs/sends.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, target: p.target, threadTs: p.threadTs || null, text: p.text }) + "\n");
    await reply(`✅ 발송 완료 → ${p.target.startsWith("C") ? `<#${p.target}>` : `<@${p.target}>`}${p.threadTs ? " (스레드 답글)" : ""}`);
  } catch (e) {
    await reply(`❌ 발송 실패: ${e?.message ?? e}\n(봇이 그 채널 멤버인지 / 대상 ID가 맞는지 확인)`);
  }
});

app.action("send_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingSends.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
});

// ── 설정집 작성 요청 게시 확인/취소 (실제 게시는 LLM 밖, 여기서만) ──
app.action("setjip_confirm", async ({ ack, body, client }) => {
  await ack();
  const id = body.actions?.[0]?.value;
  const chan = body.channel?.id, thread = body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel: chan, thread_ts: thread, text: t, ...SENDER }).catch(() => {});
  if (body.user?.id !== DISPATCHER_USER_ID) return reply("권한 없는 사용자예요.");
  const p = pendingSetjip.get(id);
  if (!p) return reply("⌛ 만료됐거나 이미 처리된 요청이에요.");
  pendingSetjip.delete(id);
  if (Date.now() - p.createdAt > EDIT_TTL_MS) return reply("⌛ 확인 시간이 지나 취소됐어요. 다시 요청해줘.");
  try {
    try { await client.conversations.join({ channel: p.channel }); } catch {}
    const text = buildSetjipText(p.e, { translator: p.translator, typesetter: p.typesetter, apmId: p.apmId, client_pm: "" }, false);
    const posted = await client.chat.postMessage({ channel: p.channel, text, ...SENDER });
    appendFileSync("logs/sends.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, kind: "setjip", channel: p.channel, work: p.work, pivo: p.e?.pivo }) + "\n");
    // n8n 인터랙션 디스패처가 하던 "검수 버튼 부착"을 여기서 직접 함 — 그쪽 워크플로우 없이도 자동 검수 V2(seoljeongjip-run)를 바로 트리거할 수 있게.
    await client.chat.postMessage({
      channel: p.channel, thread_ts: posted.ts, ...SENDER, text: "설정집 검수 버튼",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "✅ 완성되면 아래 버튼을 눌러주세요.\n수정 후 *재검수*도 버튼 재클릭." } },
        { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "🔍 설정집 검수" }, action_id: "setjip_run_review", value: posted.ts }] },
      ],
    }).catch((e) => console.error("[setjip_confirm] 검수 버튼 게시 실패:", e?.message ?? e));
    const permalink = await client.chat.getPermalink({ channel: p.channel, message_ts: posted.ts }).then((r) => stripPermalinkQuery(r?.permalink)).catch(() => null);
    logSetjipSchedule({ work: p.work, pivo: p.e?.pivo, apmId: p.apmId, submitDate: p.e?.submit_date, threadLink: permalink });
    await reply(`✅ 설정집 작성 요청 게시 완료 → <#${p.channel}> (${p.work})`);
  } catch (e) {
    await reply(`❌ 게시 실패: ${e?.message ?? e}\n(봇이 그 채널 멤버인지 확인)`);
  }
});

// 설정집 검수 버튼 클릭 → n8n "중일 설정집 자동 검수 V2"(seoljeongjip-run) 직접 트리거.
// 원래 n8n "설정집 인터랙션 디스패처"가 하던 역할(요청 생성)을 이 도구가 대체하면서, 검수 버튼 부착·클릭 처리까지 여기서 떠맡는다.
app.action("setjip_run_review", async ({ ack, body, client }) => {
  await ack();
  const channel = body.channel?.id;
  const thread_ts = body.actions?.[0]?.value || body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel, thread_ts, text: t, ...SENDER }).catch(() => {});
  // 원본(n8n) 설계도 이 버튼엔 사용자 제한이 없었음 — 요청 완성 후 첨부하는 사람(작업자/APM)이 누구든 누를 수 있어야 함.
  try {
    await n8nPost("seoljeongjip-run", { channel, thread_ts, user: body.user?.id });
    await reply("🔍 검수를 요청했어요. 결과는 곧 개인채널에 올라올 거예요.");
  } catch (e) {
    await reply(`❌ 검수 요청 실패: ${e?.message ?? e}`);
  }
});

app.action("setjip_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingSetjip.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
});

// 설정집 작성 요청 수정 — 모달(필드 직접 편집)
app.action("setjip_edit", async ({ ack, body, client }) => {
  await ack();
  if (body.user?.id !== DISPATCHER_USER_ID) return;
  const id = body.actions?.[0]?.value;
  const p = pendingSetjip.get(id);
  if (!p) { await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "⌛ 만료된 초안이라 수정 불가. 다시 요청해줘.", ...SENDER }).catch(() => {}); return; }
  const e = p.e || {};
  const inp = (b, label, init, ml = false) => ({ type: "input", block_id: b, optional: true, label: { type: "plain_text", text: label }, element: { type: "plain_text_input", action_id: "v", multiline: ml, initial_value: init || "" } });
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "setjip_edit_modal", private_metadata: id,
      title: { type: "plain_text", text: "설정집 요청 수정" }, submit: { type: "plain_text", text: "적용" }, close: { type: "plain_text", text: "닫기" },
      blocks: [
        inp("apm", "담당 APM(이름 또는 U…ID)", p.apmId ? (USER_NAMES[p.apmId] || p.apmId) : ""),
        inp("translator", "번역 작업자", p.translator || "프리랜서 배정"),
        inp("typesetter", "식자 작업자", p.typesetter || "강연재 우선 배정\n배정 안될 경우 프리랜서 배정", true),
        inp("expectation", "기대치", e.expectation),
        inp("episodes", "초도 화수", e.episodes),
        inp("submit_date", "설정집 제출 희망일", e.submit_date),
        inp("delivery_date", "초도 납품일", e.delivery_date),
        inp("country", "국가설정", e.country),
        inp("work_title", "작품명", e.work_title),
        inp("original_title", "원제", e.original_title),
        inp("notes", "특이사항", e.notes, true),
      ],
    },
  }).catch((er) => console.error("[setjip_edit] views.open 실패:", er?.data?.error || er?.message));
});

app.view("setjip_edit_modal", async ({ ack, view, client, body }) => {
  await ack();
  const id = view.private_metadata;
  const p = pendingSetjip.get(id);
  if (!p || body.user?.id !== DISPATCHER_USER_ID) return;
  const v = (b) => view.state.values?.[b]?.v?.value?.trim() ?? "";
  const apmRaw = v("apm");
  if (apmRaw) p.apmId = /^[UW][A-Z0-9]+$/.test(apmRaw) ? apmRaw : (Object.entries(USER_NAMES).find(([, nm]) => nm === apmRaw)?.[0] || p.apmId);
  p.translator = v("translator"); p.typesetter = v("typesetter");
  p.e = { ...p.e, expectation: v("expectation"), episodes: v("episodes"), submit_date: v("submit_date"), delivery_date: v("delivery_date"), country: v("country") || p.e.country, work_title: v("work_title") || p.e.work_title, original_title: v("original_title"), notes: v("notes") };
  pendingSetjip.save();
  if (p.previewChannel && p.previewTs) {
    await client.chat.update({ channel: p.previewChannel, ts: p.previewTs, text: "설정집 작성 요청 확인(수정됨)", blocks: setjipBlocks(id, p) }).catch((er) => console.error("[setjip_edit_modal] update 실패:", er?.data?.error || er?.message));
  }
});

// TOTUS 프로젝트 해석 — ①출판사 시트(lookupWork) 먼저 → ②못 찾으면 TOTUS(findProject) 폴백. 각 단계 완전→부분→후보.
// 이름의 [PRJ-…] 접두 제거. 반환: {projectUuid, projectName, pivoId, status?, source} / {ambiguous, candidates} / {notFound, msg, candidates?}
async function resolveTotusProject({ work, pivo }) {
  const stripPrj = (s) => String(s || "").replace(/^\s*\[PRJ-[^\]]*\]\s*/, "").trim();
  const viaQuote = async (pid) => {
    const num = String(pid).match(/\d{4,}/)?.[0] || String(pid).trim();   // 'PV-201454' → '201454'
    const q = await quotationByPivo(num).catch(() => null);
    const d = Array.isArray(q?.data) ? q.data[0] : null;
    return d?.projectUuid ? { projectUuid: d.projectUuid, projectName: stripPrj(d.projectName), pivoId: num } : null;
  };
  if (pivo && String(pivo).trim()) { const v = await viaQuote(pivo); return v || { notFound: true, msg: `PIVO ${pivo}의 TOTUS 프로젝트를 못 찾음.` }; }
  if (!work || !work.trim()) return { notFound: true, msg: "작품명(work) 또는 PIVO 필요." };
  // ① 출판사 시트 (완전→부분→후보)
  const w = await lookupWork(work);
  const wCand = (w.candidates || []).map((c) => ({ name: c.koTitle || c.jaTitle || c.fixTitle, pivo: c.pivoId }));
  if (w.ambiguous) return { ambiguous: true, candidates: wCand };
  if (w.found && w.pivoId) { const v = await viaQuote(w.pivoId); if (v) return { ...v, source: "출판사 시트" }; }
  // ② TOTUS 폴백 (시트에서 못 찾았거나 견적 없음)
  const r = await findProject(work).catch(() => null);
  const arr = Array.isArray(r?.data) ? r.data : [];
  if (!arr.length) return { notFound: true, msg: `'${work}'를 출판사 시트·TOTUS 모두에서 못 찾음. PIVO나 정확한 표기 확인.`, candidates: wCand };
  if (arr.length > 1) return { ambiguous: true, candidates: arr.slice(0, 6).map((p) => ({ name: stripPrj(p["프로젝트"]), pivo: p._detail?.pivoId || "", status: p._detail?.["진행상태"] || "" })) };
  const p = arr[0];
  return { projectUuid: p.uuid, projectName: stripPrj(p["프로젝트"]), pivoId: p._detail?.pivoId || "", status: p._detail?.["진행상태"] || "", hold: p._detail?.HOLD, source: "TOTUS" };
}

// 설정집 작성 요청 enrich — 견적 + 내부시트(Piccoma 중일ST_v2)에서 자동값 추출(n8n 모달빌드 로직 이식).
const SETJIP_ST_ID = "1mjUrj81QQ6pAdHFsHuCrh4m6oLcleTwO6phZVxs1bJ4";
async function enrichSetjip(pivo) {
  const raw = String(pivo).trim();
  const num = raw.match(/\d{4,}/)?.[0];                      // 'PV-201454' → '201454' (PV- 접두 제거)
  let q = num ? await quotationByPivo(num).catch(() => null) : null;
  let d = Array.isArray(q?.data) ? q.data[0] : null;
  if (!d) {   // PIVO로 못 찾으면 일본어 가제/중국어 원제로 이름검색 폴백(by-pivo가 이름검색도 함)
    const title = raw.replace(/\[?\s*PV-?\d+\s*\]?/i, "").replace(/\[[^\]]*\]/g, "").trim();
    if (title) { q = await quotationByPivo(title).catch(() => null); d = Array.isArray(q?.data) ? q.data[0] : null; }
  }
  if (!d) return { error: `'${pivo}' 견적을 못 찾음 — PIVO 번호(숫자만)나 일본어 가제/중국어 원제로 확인 필요.` };
  const WD = ["일", "월", "화", "수", "목", "금", "토"];
  const nowKST = () => new Date(Date.now() + 9 * 3600 * 1000);
  const fmt = (dt) => `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${WD[dt.getUTCDay()]})`;
  const addBiz = (start, n) => { const x = new Date(start.getTime()); let a = 0; while (a < n) { x.setUTCDate(x.getUTCDate() + 1); const w = x.getUTCDay(); if (w !== 0 && w !== 6) a++; } return x; };
  const parseDot = (s) => { const m = String(s || "").match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
  const submit_date = `${fmt(addBiz(nowKST(), 9))} 오전 중`;   // 실행일 + 9영업일
  let delivery_date = ""; const dd = parseDot(d["초도작업_납품목표일"]); if (dd) { const w = dd.getUTCDay(); if (w === 6) dd.setUTCDate(dd.getUTCDate() - 1); else if (w === 0) dd.setUTCDate(dd.getUTCDate() - 2); delivery_date = fmt(dd); }
  const episodes = String(d["초도작업_총작업량"] || "").trim();
  const lines = String(d["견적특이사항"] || "").split("\n");
  let country = "일본 설정"; const cLine = lines.find((l) => /(일본|중국|유럽|다국적)\s*설정/.test(l)); if (cLine) { if (cLine.includes("중국")) country = "중국 설정"; else if (cLine.includes("유럽")) country = "유럽 설정"; else if (cLine.includes("다국적")) country = "다국적 설정"; }
  // 견적페이지 기대치 표기가 통일돼 있지 않음(실측, 2026-07-10/13) — 최소 3가지 변형 확인됨:
  //   ①"[기대작S]"(대괄호+기대작+등급) ②"P작품입니다"/"오리지날 P+ 작품입니다"(등급+작품, 기대작/기대치 단어 자체가 없음).
  // ①을 먼저 찾고, 없으면 ②(등급 문자+선택적 '+'가 '작품'에 바로 붙는 패턴)로 폴백.
  let expectation = "";
  let eLine = lines.find((l) => /기대(?:치|작)/.test(l));
  if (eLine) {
    const em = eLine.match(/기대(?:치|작)\s*[:：]?\s*([^\]]*)/);
    expectation = em ? em[1].trim() : "";
  } else {
    eLine = lines.find((l) => /[A-Za-z]{1,3}\+?\s*작품/.test(l));
    if (eLine) { const em = eLine.match(/([A-Za-z]{1,3}\+?)\s*작품/); expectation = em ? em[1].trim() : ""; }
  }
  let notes = lines.filter((l) => !(cLine && l === cLine) && !(eLine && l === eLine)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  let isOriginal = false, originLink = "", driveLink = "", sheetOk = false;
  try {   // 내부시트 override(SA 권한 있을 때). 없으면 견적-only로 진행.
    const rows = (await readRangeRO(SETJIP_ST_ID, "Piccoma 중일ST_v2!A1:Z")) || [];
    const hdr = rows[0] || []; const col = (nm) => hdr.findIndex((h) => String(h).trim() === nm);
    const ci = { pivo: col("pivo_id"), exp: col("期待値"), country: col("설정"), orig: col("오리지널"), olink: col("원작링크"), drive: col("드라이브") };
    const srow = ci.pivo >= 0 ? rows.slice(1).find((r) => String(r[ci.pivo] ?? "").trim() === String(pivo).trim()) : null;
    if (srow) {
      sheetOk = true;
      const sval = (i) => i >= 0 ? String(srow[i] ?? "").trim() : "";
      if (sval(ci.exp)) expectation = sval(ci.exp);
      const sc = sval(ci.country); if (/중국/.test(sc)) country = "중국 설정"; else if (/유럽/.test(sc)) country = "유럽 설정"; else if (/다국적/.test(sc)) country = "다국적 설정"; else if (/일본/.test(sc)) country = "일본 설정";
      isOriginal = /^(true|1|y|yes|o|✓|✔|예|체크)$/i.test(sval(ci.orig));
      originLink = sval(ci.olink); driveLink = sval(ci.drive);
    }
  } catch (e) { /* 권한 없음 등 — 견적-only */ }
  return { pivo: String(pivo).trim(), work_title: d.pivoTitle || "", original_title: d.pivoOriginalTitle || "", submit_date, delivery_date, episodes, country, expectation, notes, isOriginal, originLink, driveLink, projectUuid: d.projectUuid || "", quotationId: d.quotationId || "", quotationProductId: (d["상품목록"]?.[0]?.quotationProductId) || "", sheetOk };
}
// 설정집 작성 요청 메시지(모달 제출 빌드와 동일 포맷). preview=true면 APM 멘션 코드표기.
function buildSetjipText(e, { translator, typesetter, apmId, client_pm }, preview = false) {
  const B = "•";
  const tr = (translator && translator.trim()) || "프리랜서 배정";
  const ts = (typesetter && typesetter.trim()) || "강연재 우선 배정\n배정 안될 경우 프리랜서 배정";
  const cp = (client_pm && client_pm.trim()) || "Hazel";
  const head = apmId ? (preview ? `\`@${apmId}\`` : `<@${apmId}>`) : null;
  const linkify = (u, label) => (u && u.indexOf("http") === 0) ? `🔗 <${u}|${label}>` : (u ? `${label} : ${u}` : null);
  return [
    head, "[중일 설정집 작성 요청]", "다음 작품 설정집 작성 요청 드립니다.", "",
    `${B}작품명 : ${e.work_title}`, `${B}원제 : ${e.original_title}`, "",
    `${B}고객사 담당자 : ${cp}`,
    `${B}설정집 제출 희망일 : ${e.submit_date}`,
    `${B}초도 납품일 : ${e.delivery_date}`,
    `${B}번역 작업자 : ${tr}`,
    `${B}기본 대사 폰트 : Ten mincho Antique`,
    `${B}식자 작업자 : ${ts}`, "",
    `${B}기대치 : ${e.expectation}`,
    `${B}${e.country}`,
    e.isOriginal ? `${B}오리지널 작품` : null,
    `${B}초도 ${e.episodes}화`, "",
    "특이사항", e.notes, "",
    linkify(e.originLink, "원작 링크"), linkify(e.driveLink, "드라이브"),
    e.projectUuid ? `🔗 <https://main.totus.pro/ko/setup?projectUuid=${e.projectUuid}&targetLanguageCode=LGC0003|설정집>` : null,
    (e.quotationId && e.quotationProductId) ? `🔗 <https://admin.totus.pro/ko/quotation/detail/?id=${e.quotationId}&quotationProductId=${e.quotationProductId}|견적>` : null,
  ].filter((x) => x !== null).join("\n");
}

// 설정집 작성 요청 미리보기 블록(✅게시/✏️수정/취소). p.e + translator/typesetter/apmId로 렌더.
function setjipBlocks(id, p) {
  const warn = [];
  if (!p.apmId) warn.push("APM 멘션 없음(수정에서 지정 가능)");
  if (p.e && !p.e.sheetOk) warn.push("내부시트 미접근(견적값만)");
  const preview = buildSetjipText(p.e, { translator: p.translator, typesetter: p.typesetter, apmId: p.apmId, client_pm: "" }, true);
  return [
    { type: "section", text: { type: "mrkdwn", text: `📝 *설정집 작성 요청 — <#${p.channel}>에 게시*${warn.length ? `\n• ⚠️ ${warn.join(" / ")}` : ""}\n아래 그대로 보낼게요. 틀린 데 있으면 ✏️수정.` } },
    { type: "section", text: { type: "mrkdwn", text: preview } },
    { type: "actions", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "✅ 게시" }, value: id, action_id: "setjip_confirm" },
      { type: "button", text: { type: "plain_text", text: "✏️ 수정" }, value: id, action_id: "setjip_edit" },
      { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: id, action_id: "setjip_cancel" },
    ] },
  ];
}

// 출판사 드라이브 링크 시트: PIVO(I열)로 행 찾아 A열=담당APM, C열=한국어타이틀만 채움(나머지 안 건드림).
async function updatePublisherSheet(pivo, apmName, koTitle) {
  const OPS = "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";
  const TAB = "출판사 드라이브 링크";
  const rows = (await readRangeRO(OPS, `${TAB}!A1:I3000`)) || [];
  let rowNum = -1;
  for (let i = 1; i < rows.length; i++) { if (String(rows[i]?.[8] ?? "").trim() === String(pivo).trim()) { rowNum = i + 1; break; } }
  if (rowNum < 0) return { ok: false, msg: `출판사 시트에 PIVO ${pivo} 행이 없음(작품 미등록)` };
  const updates = [];
  if (apmName) updates.push({ a1: `${TAB}!A${rowNum}`, value: apmName });
  if (koTitle) updates.push({ a1: `${TAB}!C${rowNum}`, value: koTitle });
  if (!updates.length) return { ok: false, msg: "채울 값(APM·한국어) 없음" };
  await setCells(OPS, updates);
  return { ok: true, row: rowNum };
}

// 납품관리시트_Japan(중일 V5)에 초도 회차만큼 행(1~N화) 추가. 공용 prod 시트라 게이트 통과 후에만 호출.
// 열: A 고객사 · B 프로젝트명 · C 담당PM · D 담당APM · E Job명(회차) · F 주문정보 · G jp_end_date(YMD).
// 마지막 데이터 행을 바닥에서부터 찾아 그 아래에 append(중간 빈 블록에 안 끼게).
async function appendDeliveryRows({ publisher, work, pm, apm, order, deliveryYMD, episodes }) {
  const DID = "1QWCtU1GnCT2BQZvuF_N-8MnpgiyqIDTcM0x6hdCi8mQ";
  const TAB = "납품관리시트_Japan(중일 V5)";
  const n = parseInt(String(episodes), 10);
  if (!Number.isFinite(n) || n < 1 || n > 200) return { ok: false, msg: `초도 회차 수가 이상함(${episodes})` };
  const rows = (await readRangeRO(DID, `${TAB}!A1:G5000`)) || [];
  let last = 0;
  for (let i = 0; i < rows.length; i++) { if ((rows[i] || []).some((c) => String(c ?? "").trim() !== "")) last = i + 1; }
  const start = last + 1;   // 마지막 데이터 행 다음
  const updates = [];
  for (let ep = 1; ep <= n; ep++) {
    const r = start + ep - 1;
    const cells = { A: publisher, B: work, C: pm, D: apm, E: String(ep), F: order, G: deliveryYMD };
    for (const [col, val] of Object.entries(cells)) if (val) updates.push({ a1: `${TAB}!${col}${r}`, value: val });
  }
  await setCells(DID, updates);
  return { ok: true, count: n, fromRow: start };
}

// ── 번역 개시 요청 확인/취소/수정 (스레드 답글 발송은 LLM 밖, 여기서만) ──
app.action("transstart_confirm", async ({ ack, body, client }) => {
  await ack();
  const id = body.actions?.[0]?.value;
  const chan = body.channel?.id, thread = body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel: chan, thread_ts: thread, text: t, ...SENDER }).catch(() => {});
  if (body.user?.id !== DISPATCHER_USER_ID) return reply("권한 없는 사용자예요.");
  const p = pendingTransStart.get(id);
  if (!p) return reply("⌛ 만료됐거나 이미 처리된 발송이에요.");
  pendingTransStart.delete(id);
  if (Date.now() - p.createdAt > EDIT_TTL_MS) return reply("⌛ 확인 시간이 지나 취소됐어요. 다시 요청해줘.");
  const text = buildTransStartText(p, false);   // 실제 발송 — APM 진짜 멘션
  try {
    try { await client.conversations.join({ channel: p.channel }); } catch {}
    let attached = 0;
    if (p.files?.length) {
      // 올린 파일(설정집·이미지)을 봇 토큰으로 받아 그 스레드에 같이 업로드(initial_comment=메시지). files:read/write 필요.
      const uploads = [];
      for (const f of p.files) {
        try {
          const res = await fetch(f.url, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
          if (!res.ok) continue;
          uploads.push({ file: Buffer.from(await res.arrayBuffer()), filename: f.name });
        } catch { /* 개별 파일 실패는 건너뜀 */ }
      }
      if (uploads.length) {
        await client.files.uploadV2({ channel_id: p.channel, thread_ts: p.threadTs, initial_comment: text, file_uploads: uploads });
        attached = uploads.length;
      }
    }
    if (!attached) await client.chat.postMessage({ channel: p.channel, thread_ts: p.threadTs, text, ...SENDER });
    appendFileSync("logs/sends.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, kind: "transstart", channel: p.channel, threadTs: p.threadTs, pivo: p.pivo, files: attached, text }) + "\n");
    await reply(`✅ 번역 개시 요청을 <#${p.channel}> 설정집 스레드에 발송했어요.${attached ? ` (첨부 ${attached}개 포함)` : " (첨부 파일은 직접 올려 주세요)"}`);
    // 후속: TOTUS 프로젝트명 가제→FIX 자동 제안(게이트). 규칙=[PV-id] [Piccoma중일] {일본어 가제(仮제거)}(한국어). PIVO 있을 때만.
    if (p.pivo) {
      try {
        const w = await lookupWork(p.pivo);
        const ja = String(w?.jaTitle || "").replace(/[（(]\s*仮\s*[）)]\s*$/, "").trim();
        const ko = String(p.koTitle || "").trim();
        const q = await quotationByPivo(p.pivo).catch(() => null);
        const d = Array.isArray(q?.data) ? q.data[0] : null;
        if (d?.projectUuid && ja && ko && !ko.startsWith("(미정")) {
          const newName = `[PV-${p.pivo}] [Piccoma중일] ${ja}(${ko})`;
          const apmName = USER_NAMES[p.apmId] || "";   // 출판사/납품 시트 APM 이름용
          const pjId = `proj_${++totusProjSeq}`;
          // 납품 시트(중일 V5) 초도 회차 행 생성용 — 회차 수·초도납품일(YMD)이 확인될 때만.
          const epN = parseInt(String(p.firstEpisode).replace(/[^\d]/g, ""), 10);
          const deliveryYMD = toYMD(p.firstDeliveryRaw || p.firstDelivery);
          const delivery = (Number.isFinite(epN) && epN >= 1 && epN <= 200 && deliveryYMD)
            ? { publisher: "카카오픽코마", work: ko, pm: "박재상", apm: apmName, order: "ZH-CN2JA", deliveryYMD, episodes: epN } : null;
          // sheet: 확정 시 TOTUS 이름 변경 → 출판사 시트 A(APM)·C(한국어) → 납품 시트 초도행까지.
          pendingTotusProj.set(pjId, { projectUuid: d.projectUuid, projectName: d.projectName || "", steps: [{ name: newName }], label: `이름 → *${newName}*`, sheet: { pivo: p.pivo, apmName, koTitle: ko, delivery }, createdAt: Date.now() });
          const delvLine = delivery
            ? `\n• 납품 시트: *1~${epN}화* ${epN}개 행 생성 (고객사 카카오픽코마 · PM 박재상${apmName ? ` · APM ${apmName}` : ""} · 납품일 ${deliveryYMD})`
            : "\n• 납품 시트: (초도 회차/납품일 미확인 — 행 생성 생략)";
          await client.chat.postMessage({
            channel: chan, thread_ts: thread, ...SENDER, text: "TOTUS 프로젝트명 + 시트 반영 제안",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `🛠 이어서 *TOTUS 프로젝트명* + *출판사 시트* + *납품 시트*도 FIX로 반영할까요?\n• 프로젝트명: \`${newName}\`\n• 출판사 시트: 한국어 *${ko}*${apmName ? ` · 담당 APM *${apmName}*` : " · (APM 미상 — A열 생략)"}${delvLine}` } },
              { type: "actions", elements: [
                { type: "button", style: "primary", text: { type: "plain_text", text: "✅ 프로젝트명+시트 반영" }, value: pjId, action_id: "proj_confirm" },
                { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: pjId, action_id: "proj_cancel" },
              ] },
            ],
          });
        }
      } catch (e) { console.error("[transstart→proj] 실패:", e?.message ?? e); }
    }
    // 후속2: 1-3화 번역검수 자동 모니터 등록(n8n). PIVO 있고 N8N_WEBHOOK_BASE 설정 시.
    if (p.pivo && process.env.N8N_WEBHOOK_BASE) {
      try {
        await n8nPost("translation-monitor-register", { pivoId: p.pivo, workTitle: p.koTitle || "" });
        await reply(`📡 1-3화 번역검수 자동 모니터 등록됨 (마감 D-1부터 추적 → 3화 완료 시 AI 검수)`);
      } catch (e) { await reply(`⚠️ 번역검수 모니터 등록 실패: ${e?.message ?? e} (n8n/웹훅 확인 — 수동 'register_translation_monitor' 가능)`); }
    }
  } catch (e) {
    const m = String(e?.data?.error || e?.message || e);
    await reply(`❌ 발송 실패: ${m}${m.includes("not_in_channel") ? "\n(봇이 그 채널 멤버가 아니에요. /invite 후 다시 시도)" : ""}`);
  }
});

app.action("transstart_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingTransStart.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
});

// (원고수급 전송은 run_wongo_update가 버튼 없이 직접 실행 — 별도 확인 핸들러 없음)

// 번역 개시 요청 수정 — 모달 열기(타이틀·수정사항·초도정보·검수시작일·APM)
app.action("transstart_edit", async ({ ack, body, client }) => {
  await ack();
  if (body.user?.id !== DISPATCHER_USER_ID) return;
  const id = body.actions?.[0]?.value;
  const p = pendingTransStart.get(id);
  if (!p) { await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "⌛ 만료된 초안이라 수정할 수 없어요. 다시 요청해줘.", ...SENDER }).catch(() => {}); return; }
  const inp = (block, label, init, opt = false, ml = false) => ({ type: "input", block_id: block, optional: opt, label: { type: "plain_text", text: label }, element: { type: "plain_text_input", action_id: "val", multiline: ml, initial_value: init || "" } });
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "transstart_edit_modal", private_metadata: id,
      title: { type: "plain_text", text: "번역 개시 요청 수정" },
      submit: { type: "plain_text", text: "적용" }, close: { type: "plain_text", text: "닫기" },
      blocks: [
        inp("ko", "한국어 타이틀", p.koTitle),
        inp("fd", "초도 납품일", p.firstDelivery),
        inp("fe", "초도 회차", p.firstEpisode),
        inp("rs", "고객 번역 검수 시작일", p.reviewStart),
        inp("rn", "수정 사항(비우면 '변동 없음' 문구)", p.revisionNote, true, true),
        inp("apm", "담당 APM Slack ID(선택)", p.apmId, true),
      ],
    },
  }).catch((e) => console.error("[transstart_edit] views.open 실패:", e?.data?.error || e?.message));
});

app.view("transstart_edit_modal", async ({ ack, view, client, body }) => {
  await ack();
  const id = view.private_metadata;
  const p = pendingTransStart.get(id);
  if (!p || body.user?.id !== DISPATCHER_USER_ID) return;
  const v = (b) => view.state.values?.[b]?.val?.value?.trim() ?? "";
  p.koTitle = v("ko") || p.koTitle;
  p.firstDelivery = v("fd") || p.firstDelivery;
  p.firstEpisode = v("fe") || p.firstEpisode;
  p.reviewStart = v("rs") || p.reviewStart;
  p.revisionNote = v("rn");                       // 비우면 기본 문구로
  p.apmId = v("apm") || null;
  pendingTransStart.save();
  if (p.previewChannel && p.previewTs) {
    await client.chat.update({ channel: p.previewChannel, ts: p.previewTs, text: "번역 개시 요청 확인(수정됨)", blocks: transStartBlocks(id, p) }).catch((e) => console.error("[transstart_edit_modal] update 실패:", e?.data?.error || e?.message));
  }
});

// ── 피드백 공유 확인/취소 (실제 발송 + 시트 표시는 LLM 밖, 여기서만) ──
app.action("feedback_confirm", async ({ ack, body, client }) => {
  await ack();
  const id = body.actions?.[0]?.value;
  const chan = body.channel?.id, thread = body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel: chan, thread_ts: thread, text: t, ...SENDER }).catch(() => {});
  if (body.user?.id !== DISPATCHER_USER_ID) return reply("권한 없는 사용자예요.");
  const p = pendingFeedback.get(id);
  if (!p) return reply("⌛ 만료됐거나 이미 처리된 공유예요.");
  pendingFeedback.delete(id);
  if (Date.now() - p.createdAt > EDIT_TTL_MS) return reply("⌛ 확인 시간이 지나 취소됐어요. 다시 요청해줘.");
  try {
    const outText = p.mentionReal ? `${p.mentionReal}\n${p.body}` : p.text;   // 수정본 반영(body 편집 시)
    await client.chat.postMessage({ channel: p.channel, text: outText, ...SENDER });
    appendFileSync("logs/feedback.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, channel: p.channel, work: p.koTitle, episode: p.episode, rows: p.rowsToMark }) + "\n");
    // 발송 성공 → 작업기록 '피드백 공유'(N열) TRUE 표시(베스트에포트: SA가 KP시트 편집자 아니면 실패해도 발송은 유지)
    let mark = "";
    try {
      if (p.rowsToMark?.length) await setCells(FEEDBACK_SHEET_ID, p.rowsToMark.map((r) => ({ a1: FEEDBACK_SHARE_RANGE(r), value: true })));
    } catch (e) { mark = `\n⚠️ 시트 '피드백 공유' 표시 실패: ${e?.message ?? e} (KP평가 시트에 SA 편집자 권한 필요)`; }
    await reply(`✅ 피드백 공유 완료 → <#${p.channel}> (${p.koTitle} ${p.episode}화)${mark}`);
  } catch (e) {
    await reply(`❌ 발송 실패: ${e?.message ?? e}\n(봇이 그 채널 멤버인지 확인)`);
  }
});

app.action("feedback_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingFeedback.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
});

// 피드백 초안 수정 — 모달(본문 편집, 멘션 줄은 자동 고정)
app.action("feedback_edit", async ({ ack, body, client }) => {
  await ack();
  if (body.user?.id !== DISPATCHER_USER_ID) return;
  const id = body.actions?.[0]?.value;
  const p = pendingFeedback.get(id);
  if (!p) { await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "⌛ 만료된 초안이라 수정할 수 없어요. 다시 요청해줘.", ...SENDER }).catch(() => {}); return; }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "feedback_edit_modal", private_metadata: id,
      title: { type: "plain_text", text: "피드백 초안 수정" },
      submit: { type: "plain_text", text: "적용" }, close: { type: "plain_text", text: "닫기" },
      blocks: [
        { type: "context", elements: [{ type: "mrkdwn", text: "받는이/CC 멘션 줄은 자동 고정이에요. 아래 본문(제목·문구·코멘트·등급)만 고치면 미리보기에 반영됩니다." }] },
        { type: "input", block_id: "body", label: { type: "plain_text", text: "본문" },
          element: { type: "plain_text_input", action_id: "val", multiline: true, initial_value: p.body } },
      ],
    },
  }).catch((e) => console.error("[feedback_edit] views.open 실패:", e?.data?.error || e?.message));
});

app.view("feedback_edit_modal", async ({ ack, view, client, body }) => {
  await ack();
  const id = view.private_metadata;
  const p = pendingFeedback.get(id);
  if (!p || body.user?.id !== DISPATCHER_USER_ID) return;
  const nb = view.state.values?.body?.val?.value;
  if (typeof nb === "string" && nb.trim()) { p.body = nb; pendingFeedback.save(); }
  if (p.previewChannel && p.previewTs) {
    await client.chat.update({ channel: p.previewChannel, ts: p.previewTs, text: "피드백 공유 확인(수정됨)", blocks: feedbackBlocks(id, p) }).catch((e) => console.error("[feedback_edit_modal] update 실패:", e?.data?.error || e?.message));
  }
});

// ── 리테이크 발송 확인/취소 (실제 발송은 LLM 밖, 여기서만) ──────────
app.action("retake_confirm", async ({ ack, body, client }) => {
  await ack();
  const id = body.actions?.[0]?.value;
  const chan = body.channel?.id, thread = body.message?.thread_ts || body.message?.ts;
  const reply = (t) => client.chat.postMessage({ channel: chan, thread_ts: thread, text: t, ...SENDER }).catch(() => {});
  if (body.user?.id !== DISPATCHER_USER_ID) return reply("권한 없는 사용자예요.");
  const p = pendingRetakes.get(id);
  if (!p) return reply("⌛ 만료됐거나 이미 처리된 발송이에요.");
  pendingRetakes.delete(id);
  if (Date.now() - p.createdAt > EDIT_TTL_MS) return reply("⌛ 확인 시간이 지나 취소됐어요. 다시 요청해줘.");
  try {
    // 공개 채널이면 자동 입장 시도(channels:join 스코프 필요, 비공개·스코프없음이면 실패해도 진행)
    try { await client.conversations.join({ channel: p.target }); } catch {}
    await client.chat.postMessage({ channel: p.target, text: `${p.headerReal}\n${p.body}`, ...SENDER });
    appendFileSync("logs/retakes.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, target: p.target, work: p.koTitle, episode: p.epText, translator: p.translator }) + "\n");
    await reply(`✅ 리테이크 발송 완료 → <#${p.target}> (${p.koTitle} ${p.epText}, ${p.translator || "?"})`);
  } catch (e) {
    const m = String(e?.data?.error || e?.message || e);
    const hint = m.includes("not_in_channel") || m.includes("channel_not_found") || m.includes("missing_scope")
      ? "\n(봇이 채널 멤버가 아니에요. 그 채널에서 `/invite @pmchatbot` 하거나, channels:join 스코프 추가 후 재설치하면 자동 입장됩니다.)" : "";
    await reply(`❌ 발송 실패: ${m}${hint}`);
  }
});

app.action("retake_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingRetakes.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
});

// 리테이크 초안 수정 — 모달 열기(본문만 편집, 멘션 헤더는 고정)
app.action("retake_edit", async ({ ack, body, client }) => {
  await ack();
  if (body.user?.id !== DISPATCHER_USER_ID) return;
  const rkId = body.actions?.[0]?.value;
  const p = pendingRetakes.get(rkId);
  if (!p) { await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "⌛ 만료된 초안이라 수정할 수 없어요. 다시 요청해줘.", ...SENDER }).catch(() => {}); return; }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "retake_edit_modal", private_metadata: rkId,
      title: { type: "plain_text", text: "리테이크 초안 수정" },
      submit: { type: "plain_text", text: "적용" }, close: { type: "plain_text", text: "닫기" },
      blocks: [
        { type: "context", elements: [{ type: "mrkdwn", text: `받는이/cc 멘션 줄은 자동 고정이에요. 아래 본문만 고치면 미리보기에 반영됩니다.` }] },
        { type: "input", block_id: "body", label: { type: "plain_text", text: "본문" },
          element: { type: "plain_text_input", action_id: "val", multiline: true, initial_value: p.body } },
      ],
    },
  }).catch((e) => console.error("[retake_edit] views.open 실패:", e?.data?.error || e?.message));
});

// 모달 제출 → 본문 갱신 + 미리보기 메시지 인플레이스 업데이트
app.view("retake_edit_modal", async ({ ack, view, client, body }) => {
  await ack();
  const rkId = view.private_metadata;
  const p = pendingRetakes.get(rkId);
  if (!p) return;
  if (body.user?.id !== DISPATCHER_USER_ID) return;
  const newBody = view.state.values?.body?.val?.value;
  if (typeof newBody === "string" && newBody.trim()) { p.body = newBody; pendingRetakes.save(); }
  if (p.previewChannel && p.previewTs) {
    await client.chat.update({ channel: p.previewChannel, ts: p.previewTs, text: `리테이크 발송 확인(수정됨): ${p.koTitle} ${p.epText}`, blocks: retakeBlocks(rkId, p) }).catch((e) => console.error("[retake_edit_modal] update 실패:", e?.data?.error || e?.message));
  }
});

// App Home — 홈 탭 열릴 때 즉시 화면을 발행해 로딩 스피너 방지 (텍스트는 자유롭게 수정)
app.event("app_home_opened", async ({ event, client }) => {
  if (event.tab !== "home") return;
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "안녕하세요 재상 님 👋 저는 *툰식이*예요.\n납품일·작품정보 같은 건 바로 찾아드릴게요. 편하게 물어봐 주세요!" } },
          { type: "context", elements: [{ type: "mrkdwn", text: "예: `야수의 왕 55화 납품일`  ·  `기묘한 서점 작품정보`" }] },
        ],
      },
    });
  } catch (e) {
    console.error("[home] views.publish 실패:", e?.message ?? e);
  }
});

// ── 리마인더 발송 (데일리 재촉 + 시각지정 1회 + 미해결 문의/재수급) ───────
// 전부 REMINDER_CHANNEL로 발송. 봇이 멤버 아니면 join 시도(스코프 없으면 실패 → 채널에 봇 초대 필요).
let _channelJoined = false;
async function postReminder(text) {
  if (!_channelJoined) { try { await app.client.conversations.join({ channel: REMINDER_CHANNEL }); } catch {} _channelJoined = true; }
  // 재상 님 멘션을 맨 앞에 붙여 실제 알림이 오게 한다(채널 발송만으론 알림 안 옴).
  const mention = DISPATCHER_USER_ID ? `<@${DISPATCHER_USER_ID}> ` : "";
  await app.client.chat.postMessage({ channel: REMINDER_CHANNEL, text: `${mention}${text}`, ...SENDER });
}

// 미해결 문의/재수급 → 한 섹션 텍스트(없으면 null)
function fmtInquiries(rows) {
  if (!rows.length) return null;
  const CAP = 15;
  const shown = rows.slice(0, CAP).map((q) => {
    const head = `• [${q.source}${q.type ? `·${q.type}` : ""}] ${q.work}`;
    const tail = [q.detail, `${q.daysOver}일째`, q.requester ? `요청:${q.requester}` : "", q.link ? `<${q.link}|🔗>` : ""].filter(Boolean).join(" · ");
    return tail ? `${head} — ${tail}` : head;
  });
  const more = rows.length > CAP ? `\n…외 ${rows.length - CAP}건` : "";
  return `📨 *미해결 문의/재수급* (인입 ${INQUIRY_OVERDUE_DAYS}일+ 완료 미체크 ${rows.length}건)\n${shown.join("\n")}${more}\n→ 처리 후 시트에서 완료 체크하면 자동으로 빠져요.`;
}

async function checkNag() {
  try {
    const hours = BOT_NAG_HOURS.split(",").map((s) => parseInt(s.trim(), 10)).filter((h) => !isNaN(h));
    if (!dueNagSlot(hours.length ? hours : [9])) return;   // 새 시각 슬롯 아니면 패스(슬롯당 1회)
    const reminders = listNagItems();
    let inquiries = [];
    try { inquiries = await overdueInquiries(parseInt(INQUIRY_OVERDUE_DAYS, 10) || 2); }
    catch (e) { console.error("[nag] 문의/재수급 스캔 실패:", e?.message ?? e); }
    let completions = [];
    try { completions = await dueCompletions(7); }   // 하루 1회 스캔(모듈 내부 게이트) + 7일 캐치업(봇 꺼짐 대비)
    catch (e) { console.error("[nag] 완결 스캔 실패:", e?.message ?? e); }
    const parts = [];
    if (reminders.length) {
      const lines = reminders.map((x) => `${x.id}. ${x.text}${x.link ? ` <${x.link}|🔗요청스레드>` : ""}`).join("\n");
      parts.push(`📌 *아직 안 끝난 일* (하루 ${hours.length || 1}번 챙겨드려요)\n${lines}\n끝났거나 그만 챙겨도 되면 "N번 완료"·"그만 리마인드해"라고 알려주세요.`);
    }
    const iq = fmtInquiries(inquiries);
    if (iq) parts.push(iq);
    const cp = fmtCompletions(completions);
    if (cp) parts.push(cp);
    if (!parts.length) return;
    await postReminder(parts.join("\n\n"));
    console.log(`[nag] 발송 — 재촉 ${reminders.length} · 문의/재수급 ${inquiries.length} · 완결 ${completions.length}`);
  } catch (e) { console.error("[nag] 실패:", e?.message ?? e); }
}
async function checkScheduled() {
  try {
    const fired = dueScheduled();
    for (const x of fired) await postReminder(`⏰ 리마인드: ${x.text}${x.link ? ` <${x.link}|🔗요청스레드>` : ""}`);
    if (fired.length) console.log(`[reminder] 예약 발송 ${fired.length}건`);
  } catch (e) { console.error("[reminder] 예약 실패:", e?.message ?? e); }
}
// ── Initiative Engine V3 슬라이스① (조언 모드) — 하루 1회, 도구 없는 판단 호출로 조언만 DM ──
const INITIATIVE_ENABLED = true;   // 끄려면 false
const INITIATIVE_HOUR = 10;        // 이 시각(로컬) 이후 그날 첫 tick에서 1회 판단
async function checkInitiative() {
  try {
    if (!INITIATIVE_ENABLED || !BRAIN_ON) return;
    if (!dueDailyInitiative(INITIATIVE_HOUR)) return;
    let overdue = [], completions = [];
    try { overdue = await overdueInquiries(parseInt(INQUIRY_OVERDUE_DAYS, 10) || 2); } catch (e) { console.error("[initiative] 문의 스캔 실패:", e?.message); }
    try { completions = await dueCompletions(7); } catch (e) { console.error("[initiative] 완결 스캔 실패:", e?.message); }
    const signals = { 미해결_문의재수급: overdue.slice(0, 25), 완결후보: completions.slice(0, 25) };
    const nowStr = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "full", timeStyle: "short" });
    const v = await runInitiative({ model: DISPATCHER_MODEL, nowStr, signals });
    if (v?.speak && v.message) {
      try {
        const dm = await app.client.conversations.open({ users: DISPATCHER_USER_ID });
        if (dm.channel?.id) await app.client.chat.postMessage({ channel: dm.channel.id, text: `💡 *[먼저 제안]* ${v.message}`, ...SENDER });
        console.log(`[initiative] 발화 — ${v.topic || ""}`);
      } catch (e) { console.error("[initiative] DM 실패:", e?.message); }
    } else {
      console.log(`[initiative] 침묵 (${v?.reason || v?.skipped || "low-value"})`);
    }
  } catch (e) { console.error("[initiative] 실패:", e?.message ?? e); }
}
// ── 주간 자동화 스크럼 공지 ─────────────────────────────────
// 매주 지정 요일·시각(1회): (토큰 있으면) Outline 스크럼 문서 생성 → 링크 붙여 공지 채널 발송.
// 채널(WEEKLY_SCRUM_CHANNEL) 미설정이면 도먼트(안 뜸). Outline 토큰 오면 링크 자동 포함.
const SCRUM_CHANNEL = process.env.WEEKLY_SCRUM_CHANNEL || "";
const SCRUM_DAY = Number(process.env.WEEKLY_SCRUM_DAY ?? 1);     // 0=일 … 1=월(기본)
const SCRUM_HOUR = Number(process.env.WEEKLY_SCRUM_HOUR ?? 10);  // KST 시
const OUTLINE_BASE = process.env.OUTLINE_BASE || "https://voithru.getoutline.com";
async function createOutlineDoc(title, text) {
  const tok = process.env.OUTLINE_API_TOKEN, coll = process.env.OUTLINE_COLLECTION_ID;
  const parent = process.env.OUTLINE_PARENT_DOC_ID;   // 있으면 그 문서 하위로 중첩 생성
  if (!tok || !coll) return null;   // 토큰/컬렉션 없으면 문서 생성 스킵(링크 없이 공지)
  try {
    const payload = { title, text, collectionId: coll, publish: true };
    if (parent) payload.parentDocumentId = parent;
    const r = await fetch(`${OUTLINE_BASE}/api/documents.create`, {
      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j?.data?.url) return { id: j.data.id, url: j.data.url.startsWith("http") ? j.data.url : `${OUTLINE_BASE}${j.data.url}` };
    console.error("[scrum] Outline 응답 이상:", JSON.stringify(j).slice(0, 200));
  } catch (e) { console.error("[scrum] Outline 생성 실패:", e?.message ?? e); }
  return null;
}
// Outline 읽기 헬퍼 — 주차 문서 이어받기 / diff용
async function outlineApi(method, body) {
  const tok = process.env.OUTLINE_API_TOKEN; if (!tok) return null;
  try { const r = await fetch(`${OUTLINE_BASE}/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); return await r.json(); }
  catch (e) { console.error("[outline]", method, e?.message ?? e); return null; }
}
async function outlineChildren() {   // 부모 하위 주차 문서 목록
  const parent = process.env.OUTLINE_PARENT_DOC_ID; if (!parent) return [];
  const j = await outlineApi("documents.list", { parentDocumentId: parent, limit: 30 });
  return j?.data || [];
}
async function outlineDocText(id) { const j = await outlineApi("documents.info", { id }); return j?.data?.text || ""; }
const SCRUM_DIFF_HOUR = Number(process.env.WEEKLY_SCRUM_DIFF_HOUR ?? 12);   // 회의일 diff 요약 시각(KST)
function scrumBlankBody(mdate, mdow) {
  const members = (process.env.WEEKLY_SCRUM_MEMBERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const section = (nm) => [
    `## 👤 ${nm || "(이름)"}`,
    `### 🤖 AI와 나눈 대화 요약`,
    `_어떤 문제를 물었고 어떻게 풀었는지 (Claude·ChatGPT 등) 자유롭게 붙여넣기_`,
    ``,
    `### 🔄 이번 주 업데이트`,
    `_표에 안 들어가는 자잘한 진척·변경을 자유롭게 (불릿)_`,
    `- `,
    ``,
    `### ✅ 자동화 중인 항목`,
    `| 항목 | 무엇을 자동화 | 도구(n8n/코드봇/GAS) | 상태 | 비고 | 다음 주까지 하고 싶은 것 |`,
    `| --- | --- | --- | --- | --- | --- |`,
    `|  |  |  |  |  |  |`,
    ``,
    `### 💡 자동화 하고 싶은 항목`,
    `| 하고 싶은 것 | 기대 효과 | 예상 난이도 | 우선도 | 필요한 도움/리소스 |`,
    `| --- | --- | --- | --- | --- |`,
    `|  |  |  |  |  |`,
    ``,
    `### 📎 관련 정보`,
    `_코드 · 워크플로우 JSON · 시트 링크 · 스크린샷 · API 메모 등_`,
    ``,
    `### 🚧 막힌 부분 / 질문`,
    `| 자동화 항목 | 상세 내용 | 필요한 도움 |`,
    `| --- | --- | --- |`,
    `|  |  |  |`,
  ].join("\n");
  return [
    `## 🎯 목적`,
    `각자 자동화 희망·필요 주제를 리스트업 → 난이도·임팩트로 우선순위 결정 → 순차 개발.`,
    `- AI 도움으로도 안 풀리는 부분 논의`,
    `- 워크플로우 피드백 (운영 단계 리스크 절감·효율화)`,
    `- 기획 단계 논의 · 완성 후 확장성 피드백 (타 업무 연계)`,
    `- 만든 자동화 공유(중복 작업 방지) · 효과 KPI 추적 · 참조 워크플로우 공유 · Q&A`,
    `- 재팬팀 n8n 플레이그라운드`,
    ``,
    `## 📝 작성 방법`,
    `- 각자 섹션의 '자동화 중 / 하고 싶은 항목' 표 (지난주 항목 유지하고 업데이트)`,
    `- 관련 정보(코드·링크·스크린샷·n8n JSON)는 자유롭게 첨부`,
    ``,
    `---`,
    ``,
    members.length ? members.map(section).join("\n\n---\n\n") : section(""),
  ].join("\n");
}
async function checkWeeklyScrum() {
  try {
    if (!SCRUM_CHANNEL) return;
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    if (kst.getUTCDay() !== SCRUM_DAY || kstHourNow() < SCRUM_HOUR) return;
    const meetDay = Number(process.env.WEEKLY_SCRUM_MEETING_DAY ?? 3);
    const mtg = new Date(kst); mtg.setUTCDate(mtg.getUTCDate() + ((meetDay - kst.getUTCDay() + 7) % 7));
    const mdate = mtg.toISOString().slice(0, 10);
    const mdow = ["일", "월", "화", "수", "목", "금", "토"][mtg.getUTCDay()];
    const mdShort = `${mtg.getUTCMonth() + 1}/${mtg.getUTCDate()}`;
    let st = {}; try { st = JSON.parse(readFileSync("data/weekly-scrum.json", "utf8")); } catch { /* 첫 실행 */ }
    if (st.week === mdate) return;                               // 이번 회의 주기 이미 공지
    // ★Outline 문서 생성·슬랙 발송(느림) 전에 먼저 주차를 마킹 — 그 사이 재기동/겹친 tick이 있어도 재공지 안 되게.
    st.week = mdate; try { writeFileSync("data/weekly-scrum.json", JSON.stringify(st)); } catch { }
    // 지난주 문서 이어받기(있으면 그 마크다운 그대로 — 링크·첨부 보존), 없으면 빈 템플릿
    let body = scrumBlankBody(mdate, mdow);
    try {
      const prev = (await outlineChildren()).filter((k) => k.id && !String(k.title || "").includes(mdate)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      if (prev) { const t = await outlineDocText(prev.id); if (t && t.length > 100) body = t; }
    } catch (e) { console.error("[scrum] 이어받기 실패:", e?.message ?? e); }
    const doc = await createOutlineDoc(`자동화 정기 스크럼 — ${mdate}`, body);
    const mentions = process.env.WEEKLY_SCRUM_MENTIONS || "";
    const docLine = doc?.url ? `📄 회의록: ${doc.url}` : `_📄 회의록 링크는 Outline 연동(토큰) 후 자동 첨부돼요._`;
    const lines = [
      `📣 *자동화 정기 스크럼 공지*`,
      ...(mentions ? [mentions] : []),
      ``,
      `${mdShort}(${mdow}) 회의 전까지 아래 회의록에 한 주간 업데이트 내용을 미리 채워주세요 🙌`,
      ``,
      `🎯 주제 리스트업 → 우선순위 → 순차 개발 · 공유/피드백으로 중복작업 방지`,
      docLine,
      ``,
      `🤖 매주 *수요일 12시*엔 지난 한 주간 무엇이 업데이트됐고 무엇을 확인해야 하는지 툰식이가 자동 분석해서 이 스레드에 정리해드려요.`,
    ];
    const res = await app.client.chat.postMessage({ channel: SCRUM_CHANNEL, text: lines.join("\n"), ...SENDER, unfurl_links: false });
    st.week = mdate; st.channel = SCRUM_CHANNEL; st.threadTs = res?.ts || null; st.docId = doc?.id || null; st.docUrl = doc?.url || null;
    try { writeFileSync("data/weekly-scrum.json", JSON.stringify(st)); } catch { /* 무시 */ }
    console.log(`[scrum] 주간 공지 (${mdate}) doc=${doc?.url || "없음"} thread=${res?.ts || "?"}`);
  } catch (e) { console.error("[scrum] 실패:", e?.message ?? e); }
}
// 회의일(수) diff 요약 — 이번 주 vs 지난주 문서 비교, 월요일 공지 스레드에 답글
async function checkWeeklyScrumDiff() {
  try {
    if (!SCRUM_CHANNEL) return;
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const meetDay = Number(process.env.WEEKLY_SCRUM_MEETING_DAY ?? 3);
    if (kst.getUTCDay() !== meetDay || kstHourNow() < SCRUM_DIFF_HOUR) return;
    const mdate = kst.toISOString().slice(0, 10);               // 회의 당일 = 이번 주기 mdate
    let st = {}; try { st = JSON.parse(readFileSync("data/weekly-scrum.json", "utf8")); } catch { }
    if (st.diffDone === mdate) return;                          // 이번 회의 diff 이미 발송
    if (st.week !== mdate || !st.docId || !st.threadTs) {       // 이번 주기 월요일 공지 없으면 스킵
      st.diffDone = mdate; try { writeFileSync("data/weekly-scrum.json", JSON.stringify(st)); } catch { }
      return;
    }
    // ★무거운 작업(Outline 조회·LLM 호출·슬랙 발송) 전에 먼저 완료 마킹 — 그 사이 재기동/겹친 tick이 있어도 재실행 안 되게(중복 발송 방지 우선, 실패 시 발송 누락 감수).
    st.diffDone = mdate; try { writeFileSync("data/weekly-scrum.json", JSON.stringify(st)); } catch { }
    const cur = await outlineDocText(st.docId);
    const prev = (await outlineChildren()).filter((k) => k.id !== st.docId && !String(k.title || "").includes(mdate)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    const prevText = prev ? await outlineDocText(prev.id) : "";
    const prompt = [
      `[자동화 스크럼 진행 diff] 아래 '지난주'와 '이번주' 회의록을 비교해, 이번 주 진행을 참가자별로 요약하라. 표/내용을 *의미로* 비교(문자 비교 아님).`,
      `출력은 두 부분으로, 사이에 정확히 '===상세===' 한 줄로 구분:`,
      `[1부 = 슬랙 스레드용 *간략*] 참가자별 딱 1줄(핵심 변화만, 굵게 봇 이름 대신 사람 이름). 실질 변화 없으면 '— 변화 없음'. 군더더기·머리말 없이 불릿만.`,
      `[2부 = DM용 *상세*] 참가자별로 🆕 신규 / 📈 진행됨(상태·우선도 변화) / ✅ 완료 / 🚧 여전히 막힘(지난주부터 반복이면 강조) / 🔗 중복·연계·주의. 해당 없는 항목은 생략.`,
      ``, `[지난주]`, prevText.slice(0, 9000), ``, `[이번주]`, cur.slice(0, 9000),
    ].join("\n");
    const out = (await toollessQuery(prompt, { label: "스크럼 diff", channel: SCRUM_CHANNEL })) || "";
    const [brief, detail] = out.includes("===상세===") ? out.split("===상세===") : [out, ""];
    const head = `📊 *회의 전 진행 요약* — ${mdate} 회의${prev ? " (지난 회의 대비)" : ""}`;
    // 스레드엔 간략 요약(+상세는 DM 안내)
    await app.client.chat.postMessage({ channel: st.channel || SCRUM_CHANNEL, thread_ts: st.threadTs, text: `${head}\n\n${brief.trim() || "요약 생성 실패"}${detail.trim() ? `\n\n_상세 diff는 박재상 DM으로 보냈어요._` : ""}`, ...SENDER, unfurl_links: false });
    // 상세는 박재상 DM
    if (detail.trim()) await dmOwner(`📊 *스크럼 상세 진행 diff* — ${mdate} 회의 (지난 회의 대비)\n${st.docUrl ? st.docUrl + "\n" : ""}\n${detail.trim()}`);
    st.diffDone = mdate; try { writeFileSync("data/weekly-scrum.json", JSON.stringify(st)); } catch { }
    console.log(`[scrum-diff] ${mdate} 진행 요약 발송 (thread ${st.threadTs}, 상세 DM ${detail.trim() ? "O" : "X"})`);
  } catch (e) { console.error("[scrum-diff] 실패:", e?.message ?? e); }
}
// ── 작품별 특이사항(비고) 납품일 리마인드 ───────────────────────
// 출판사 드라이브 링크 시트 F열(비고)에 적힌 작품이 오늘 납품일이면, 그날의 "Toon_Japan 납품스레드"
// (재팬_공지 채널에 하루 1개, 담당봇이 "[M/D *Toon_Japan 납품스레드]*"로 매일 새로 올림)를 찾아 답글로
// 리마인드한다. 스레드가 하루 1개뿐이라 결정적으로 찾을 수 있어 find_thread 같은 fuzzy 검색이 불필요
// (재상 님이 실제 스레드 예시 제공 후 2026-07-10 설계 확정: 매번 다른 스레드가 아니라 일별 고정 패턴).
const DELIVERY_NOTE_HOUR = Number(process.env.DELIVERY_NOTE_HOUR ?? 9);   // 이 시각(KST) 이후 그날 첫 tick에서 1회
const DELIVERY_THREAD_CHANNEL = process.env.DELIVERY_THREAD_CHANNEL || "C09B8QLR5FG";   // 재팬_공지
let _deliveryNoteDate = null, _deliveryNoteDmDate = null;
async function todayDeliveriesWithNotes() {
  if (!gasReady()) return [];
  const notes = await listWorkNotes();
  if (!notes.length) return [];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const j = await gasQuery({ sheet: "delivery", q: "byDate", date: today, lang: "both" }).catch(() => null);
  const rows = j?.rows || [];
  if (!rows.length) return [];
  const hits = [];
  for (const n of notes) {
    const titles = [n.koTitle, n.jaTitle, n.fixTitle, n.zhTitle].filter(Boolean).map(norm);
    const matched = rows.filter((r) => { const rw = norm(r.work); return titles.some((t) => t && (rw.includes(t) || t.includes(rw))); });
    if (matched.length) {
      const apmId = n.apm ? (Object.entries(USER_NAMES).find(([, nm]) => nm === String(n.apm).trim())?.[0] || null) : null;
      hits.push({ work: n.koTitle || n.jaTitle || n.zhTitle, note: n.note, apm: n.apm, apmId, episodes: [...new Set(matched.map((m) => m.episode))].sort((a, b) => a - b) });
    }
  }
  return hits;
}
// 오늘자 "Toon_Japan 납품스레드" 루트 메시지 ts를 찾는다(하루 1개, 결정적 텍스트 패턴 매칭).
async function findTodayDeliveryThreadTs() {
  try {
    const hist = await app.client.conversations.history({ channel: DELIVERY_THREAD_CHANNEL, limit: 40 });
    const todayKST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    for (const m of hist.messages || []) {
      if (!/납품\s*스레드/.test(m.text || "")) continue;
      const d = new Date(Number(m.ts) * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
      if (d === todayKST) return m.ts;
    }
  } catch (e) { console.error("[delivery-note] 오늘 납품스레드 탐색 실패:", e?.message ?? e); }
  return null;
}
// ── 일일 납품 공지("Toon_Japan 납품스레드") 자동 발송 ──────────────
// 재상 님 요청(2026-07-15): 매일 오전 엑셀 파일 탭이 있는 날짜만, 2026-07-24까지 자동 발송.
// 이미 그날 스레드가 있으면(다른 프로세스가 먼저 올렸거나 재기동 중복) 스킵 — findTodayDeliveryThreadTs 재사용.
const DELIVERY_NOTICE_SEND_HOUR = Number(process.env.DELIVERY_NOTICE_SEND_HOUR ?? 9);
const DELIVERY_NOTICE_CUTOFF = "2026-07-24";
let _deliveryNoticeSentDate = null;
async function checkDailyNoticePost() {
  try {
    if (!BRAIN_ON) return;
    const now = new Date();
    const kh = Number(now.toLocaleString("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false }));
    const kd = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    if (kh < DELIVERY_NOTICE_SEND_HOUR || _deliveryNoticeSentDate === kd) return;
    if (kd > DELIVERY_NOTICE_CUTOFF) return;   // 기한 지남 — 매번 조용히 스킵(마킹 불필요)

    const existing = await findTodayDeliveryThreadTs();
    if (existing) { _deliveryNoticeSentDate = kd; console.log(`[delivery-notice] 오늘(${kd}) 이미 납품스레드 있음 — 스킵`); return; }

    const file = findLatestDeliveryExcel();
    if (!file) return;   // 파일 없으면 다음 tick에 재시도

    const mm = Number(now.toLocaleString("en-US", { timeZone: "Asia/Seoul", month: "numeric" }));
    const dd = Number(now.toLocaleString("en-US", { timeZone: "Asia/Seoul", day: "numeric" }));
    const md = `${mm}/${dd}`;
    const parsed = parseDeliveryNoticeTab(file, md);
    if (parsed.error) { _deliveryNoticeSentDate = kd; console.log(`[delivery-notice] ${md} 탭 없음 — 오늘은 스킵 (${parsed.error})`); return; }

    const text = buildNoticeText(parsed);
    await app.client.chat.postMessage({ channel: DELIVERY_THREAD_CHANNEL, text, ...SENDER, unfurl_links: false });
    _deliveryNoticeSentDate = kd;
    console.log(`[delivery-notice] ${md} 납품스레드 자동 발송 완료 (초도${parsed.chodo.length}·한일${parsed.hanil.length}·중일${parsed.zhongyi.length})`);
  } catch (e) { console.error("[delivery-notice] 실패:", e?.message ?? e); }
}
async function checkDeliveryNotes() {
  try {
    if (!BRAIN_ON) return;
    const now = new Date();
    const kh = Number(now.toLocaleString("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false }));
    const kd = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    if (kh < DELIVERY_NOTE_HOUR || _deliveryNoteDate === kd) return;
    const hits = await todayDeliveriesWithNotes();
    if (!hits.length) { _deliveryNoteDate = kd; return; }
    const lines = hits.map((h) => {
      const epTxt = h.episodes.length ? ` ${h.episodes.join(",")}화` : "";
      const who = h.apmId ? `<@${h.apmId}> ` : (h.apm ? `${h.apm} 님 ` : "");
      return `⚠️ *${h.work}*${epTxt} — ${who}특이사항: ${h.note}`;
    });
    const text = `🔔 *오늘 납품 중 특이사항 있는 작품*\n${lines.join("\n")}`;
    const threadTs = await findTodayDeliveryThreadTs();
    if (threadTs) {
      const replies = await app.client.conversations.replies({ channel: DELIVERY_THREAD_CHANNEL, ts: threadTs, limit: 60 }).catch(() => null);
      const alreadyPosted = (replies?.messages || []).some((m) => /오늘 납품 중 특이사항 있는 작품/.test(m.text || ""));
      if (alreadyPosted) {   // 재기동으로 메모리 플래그가 초기화돼도 실제 스레드를 재확인해 중복 게시 방지
        console.log(`[delivery-note] 이미 오늘자 리마인드 있음 — 스킵`);
        _deliveryNoteDate = kd;
        return;
      }
      await app.client.chat.postMessage({ channel: DELIVERY_THREAD_CHANNEL, thread_ts: threadTs, text, ...SENDER, unfurl_links: false });
      console.log(`[delivery-note] 납품스레드에 ${hits.length}건 리마인드 게시`);
      _deliveryNoteDate = kd;
    } else {
      if (_deliveryNoteDmDate !== kd) {   // DM 안내는 하루 1번만(재시도 자체는 매 tick 조용히 계속)
        await dmOwner(`${text}\n\n⚠️ 오늘 [Toon_Japan 납품스레드]를 아직 못 찾았어요 — 올라오는 대로 자동으로 거기 남길게요(계속 재시도 중).`);
        _deliveryNoteDmDate = kd;
      }
      console.log(`[delivery-note] 납품스레드 못 찾음 — 날짜 미마킹(재시도 예정, ${hits.length}건 대기)`);
      // 날짜를 마킹하지 않아 스레드가 늦게 올라와도 다음 tick(1분)에 재시도된다.
    }
  } catch (e) { console.error("[delivery-note] 실패:", e?.message ?? e); }
}
let _tickRunning = false;   // setInterval은 이전 tick()이 끝나든 말든 다음 틱을 쏨 — LLM 호출 등으로 60초 넘게 걸리면 겹쳐 재진입해 중복 발송(2026-07-22 스크럼 diff 4중발송 사고 원인). 락으로 겹침 자체를 차단.
async function tick() {
  if (_tickRunning) return;
  _tickRunning = true;
  try {
    await checkScheduled(); await checkNag(); await checkInitiative(); await checkDailyReport(); await checkWeeklyScrum(); await checkWeeklyScrumDiff(); await checkDailyNoticePost(); await checkDeliveryNotes(); await checkSetjipDeadline(); await checkSetjipTaskCompletion(); await tickReviewFollowup(app.client).catch((e) => console.error("[reviewFollowup] tick 오류:", e?.message ?? e));
  } finally {
    _tickRunning = false;
  }
}

(async () => {
  await app.start();
  try { const a = await app.client.auth.test(); SELF_BOT_USER = a.user_id; } catch { /* self id 조회 실패 무시 */ }
  if (BRAIN_ON) startSession();   // 엔진을 미리 띄워 워밍(콜드스타트 제거)
  initSince();                    // 토톡 since 복원(없으면 KST 자정)
  refreshJungil().catch((e) => console.error("[totalk] 중일 캐시 초기빌드 실패:", e?.message));   // 중일 작품 uuid 집합 백그라운드 빌드
  tick();                         // 부팅 직후 1회
  setInterval(tick, 60 * 1000);   // 1분마다 (예약은 ~1분 내 발송, 재촉·문의는 dueNagSlot이 시각 슬롯별 하루 1회로 제한)
  console.log(`🤖 디스패처 가동 — 브레인 ${BRAIN_ON ? `ON (${DISPATCHER_MODEL}, 세션 워밍됨)` : "OFF (에코 모드)"} · 재촉 ${BOT_NAG_HOURS}시 · 예약 1분틱`);
})();
