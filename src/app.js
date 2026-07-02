import "dotenv/config";
import pkg from "@slack/bolt";
const { App } = pkg;
import { pollOnce, initSince, refreshJungil } from "./totalk.js";
import { runInitiative, dueDailyInitiative } from "./initiative.js";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { lookupDelivery } from "./delivery.js";
import { gasReady, gasQuery } from "./gas.js";
import { lookupWork } from "./works.js";
import { queryView, VIEWS, VIEW_CATALOG, readTab } from "./sheets-registry.js";
import { resolveDeliveryCell, resolveDeliveryCells } from "./delivery-edit.js";
import { setCell, getCell, setCells, getCells } from "./sheets-write.js";
import { readRange as readRangeRO } from "./sheets.js";
import { buildFeedback, FEEDBACK_SHEET_ID, FEEDBACK_SHARE_RANGE } from "./feedback.js";
import { buildRetake } from "./retake.js";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { quotationByPivo, findProject, scheduleSummary, projectJobs, taskList, taskDetail, translationText, jobProcesses, setDeliveryDate, setProjectSettings, deliverySourceGroups } from "./totus.js";
import { search as notionSearch, readPage as notionReadPage } from "./notion.js";
import { extractEpisode, QA_INSTRUCTIONS } from "./review.js";
import { addReminder, addScheduled, listReminders, completeReminder, dueNagSlot, listNagItems, dueScheduled } from "./reminders.js";
import { overdueInquiries } from "./inquiries.js";
import { dueCompletions, fmtCompletions } from "./completions.js";
import { addLearned, removeLearned, listLearned, learnedPromptBlock } from "./learned.js";
import { missingOriginals, deliveryOnDate, workSchedule, episodeLaunch } from "./schedule.js";
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
  BOT_NAG_HOURS = "9,14,18", // 재촉 리마인더 발송 시각들(콤마, 시·로컬). 기본 09·14·18시 하루 3회
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
    const m = part.match(/^(\d+)\s*[-~]\s*(\d+)$/);
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
  "★사용자가 붙인 리스트의 분류 = 정답: 메시지에 'X N건'처럼 사람별로 묶인 리스트(예 '*박재상 3건*')가 있으면 그게 그 리스트 기준 담당자(예 검수자)다. '내가 검수/담당하는 작품'은 거기서 *내 이름 섹션을 그대로* 골라 답하고, 납품시트·TOTUS에서 'APM=나' 등 다른 기준으로 재조회하지 마라(APM≠검수담당자, 엉뚱한 결과). 링크 필요하면 그 항목으로 프로젝트URL만 추가 조회.",
  "★실행 전 확인 (필수 슬롯 + 애매하면 되묻기): 아래 핵심 업무는 *필수 정보*가 갖춰져야 실행한다. 정보가 빠졌거나 의도가 둘 이상으로 애매하면 — 추측해서 실행하지 말고 **한 줄로 되묻는다**. 반대로 정보가 충분하고 의도가 명확하면 묻지 말고 바로 진행한다(매번 슬롯 채우라고 캐묻는 폼봇처럼 굴지 말 것).\n  · 리테이크 전달(propose_retake): 작품·회차·수정내용\n  · 검수 등급 공유(share_feedback): 작품·회차 (중일 전용)\n  · 납품예정일 변경(propose_totus_delivery_edit/propose_delivery_edit): 작품·회차·새 날짜·대상(TOTUS 시스템인지 내부 시트인지)\n  · 슬랙 발송(send_message): 받는 곳·내용\n  · 조회(납품일·원본·에디터·프로젝트URL 등): 작품 (필요시 회차)\n  특히 '번역가/작업자 피드백'은 *리테이크 전달*인지 *검수 등급 공유*인지 단어만으론 못 가른다 — 맥락(채널/스레드)으로도 안 갈리면 반드시 되묻는다.",
  "말투: 따뜻하고 친근하게, 군더더기 없이. 표나 정형 양식은 꼭 필요할 때만 쓰고, 평소엔 사람처럼 자연스럽게 대화한다.",
  "★담당 APM @멘션 Slack ID(이 3명은 시트 조회 없이 바로 <@ID>로 멘션): **서주원=U07E0QPL8MV · 정태영=U05CE8HFA6B · 박재상=U04463JR4HH**. '담당 APM 멘션해줘'면 작품 담당 APM 이름을 이 맵으로 실제 @멘션한다(worker_db 조회·'ID를 못 찾는다' 금지). 이 3명 외 이름일 때만 query_sheet(worker_db)로 slack_id 조회.",
  "사용자 권한: 재상 님 외에 APM 두 분도 너에게 말을 건다(같은 '툰식이'로 똑같이 친절하게 응대). 단 '변경·발송·리마인더'(납품예정일/시트 변경·삭제, 슬랙 메시지 발송, 리마인더 등록·조회·완료)는 재상 님 전용이다. APM 분이 그런 요청을 하면 해당 도구가 거부(denied)를 돌려주는데, 그때는 '그건 재상 님만 할 수 있어요. 대신 조회·검수·링크·원본파일은 도와드릴게요'처럼 부드럽게 안내한다. 조회·검수·링크·원본 파일은 모두에게 열려 있다.",
  "내부 구현은 답변에 드러내지 않는다 — 도구명·뷰명(예: translator_grade, query_sheet)이나 '어느 탭·필드에서 어떤 로직으로 가져왔는지'를 괄호로 달거나 설명하지 말 것. 그건 나와 봇만 아는 내부 사정이다. 결과만 자연스럽게 말하고, 사용자가 직접 '어디서 가져왔어?'라고 물을 때만 출처를 짧게 답한다.",
  "강조 기호(**굵게)를 남용하지 않는다 — 정말 핵심 한두 군데만. 평소엔 일반 텍스트로. 표·불릿·헤더도 꼭 필요할 때만.",
  "업무 명령이든 가벼운 잡담이든 가리지 않고 받아준다. '그건 내 역할이 아니다' 같은 선긋기나 자기 한계 변명을 길게 늘어놓지 않는다.",
  "★★ 절대 규칙(최우선): 작품명·고유명사는 도구가 돌려준 셀 값(원문 문자열)을 **글자 하나도 바꾸지 않고 그대로 복사해** 출력한다. 음역·번역·한자↔한글 변환·가나 변환·표기 정리 일체 금지 (예: '最弱'→'최약' 금지, '覇王'→'패왕' 금지). 어느 언어(중/한/일) 제목을 골라올지 판단이 틀릴 수는 있어도, 일단 가져온 제목 문자열은 무조건 셀 값 그대로 출력한다. 한국어·일본어 제목이 둘 다 있으면 섞지 말고 각각 원문대로.",
  "- 납품일/일정 → get_delivery_date (특정 작품 납품일, 중일 기본·한일 ko-ja). '그날/기간 납품 예정 리스트'(예 '7/17 납품 리스트')는 delivery_on_date(date 또는 from~to). → 날짜별 납품은 query_sheet로 시트 통째 읽지 말고 delivery_on_date로(서버측이라 빠름).",
  "- 리테이크 집계·현황은 retake_query로(시트 통째 읽기 금지·빠름): '기간 리테이크 개수/많이 나온 작품 TOP'=mode:agg(from,to,top) 즉시. '○○ 리테이크 현황/오탈자 개수' 및 유형(번역/식자/애매) 분류=mode:list로 그 기간 행을 받아 *comment를 읽고* 분류(tag는 참고만, 결과 많으면 기간/작품 좁혀 재요청), 카운트는 compute.",
  "- 납품예정일 '변경/삭제(비우기)' 요청: ①실제 TOTUS/픽코마 시스템 납품예정일 = propose_totus_delivery_edit(PIVO 자동반영, 변경 전용) / ②내부 납품관리시트 G열 = propose_delivery_edit(변경+삭제 둘 다). 둘 다 게이트형(버튼 확인). ★'납품일 지워/삭제/비워줘'(특히 재수급·문의로 고객사 확인 필요해 일정을 비워둘 때) → 내부 시트면 propose_delivery_edit에 new_date='삭제'(또는 빈 문자열)로 호출하면 G열을 비운다. 확인 끝나 다시 잡을 땐 같은 도구에 날짜를 준다. 어느 쪽인지 불명확하면 'TOTUS 시스템인지, 내부 시트인지' 짧게 되묻고(삭제는 보통 내부 시트), 절대 '변경/삭제했다'고 단정하지 말 것(버튼 눌러야 반영).",
  "★여러 회차를 같은 날짜로 바꿀 때(예 '1-20화 납품일 ~로'): 회차마다 도구를 여러 번 부르지 말고, episode에 범위/목록 문자열('1-20' 또는 '1,3,5')을 넣어 propose 도구를 **딱 한 번** 호출해라 — 그러면 확인 버튼 하나로 일괄 변경된다. 회차마다 날짜가 다르면 그때만 나눠 호출.",
  "★'피드백' 라우팅(자주 헷갈림): propose_retake=클라이언트 수정요청(리테이크)을 번역가에게 일본어로 전달 / share_feedback=검수 퀄리티 등급(총평·번역가·LG 등급+코멘트) 공유. 맥락에 리테이크 BOT 메시지(작품·리테이크화수·수정내용·프로젝트URL)가 있거나 '번역가에게/리테이크/수정 전달'이면 → propose_retake. 명시적 '검수 등급/퀄리티/총평 공유'만 → share_feedback. 애매하면 리테이크 BOT 메시지 유무로 판단(있으면 propose_retake). 한일은 KP평가 없어 share_feedback 불가→propose_retake.",
  "- propose_retake(work,episode,fix): 제목·번역가채널·cc·식자검수에디터 자동(중일·한일). fix는 *일본어로만*(한국어 사유는 일역, 예 '「楽」が旧字体になっていたため新字体に修正'), 가능하면 '오류원문->수정문'; 작품/화수/수정은 맥락의 리테이크 BOT 메시지에서 옮긴다. 게이트형(버튼)—'보냈다' 단정·내용 지어내기 금지. share_feedback(work,episode,batch): 중일 전용, 등급·코멘트는 시트값 그대로(임의변경·지어내기 금지, 받는이 APM·CC 재상 님). ★배치: 1-3화 등 초회분이면 batch 생략(初回分 기본), '재제출/추가분/再提出/追話'이거나 4화 이상 후속분이면 batch='再提出追話'로 그 배치 등급·코멘트를 고른다. 회차(예 '4')는 사용자가 말한 그대로 episode에. 초안은 ✏️수정 모달로 본문(문구·코멘트·등급) 손볼 수 있음.",
  "- 완결 작품 처리('○○ 완결 작품 처리해줘/완결처리'): propose_totus_complete(work나 pivo). 프로젝트명 뒤 '(완)' + 상태 완료를 한 번에(게이트). 이미 (완) 있으면 상태만. '처리했다' 단정 금지.",
  "- TOTUS 프로젝트 이름/상태 변경: propose_totus_project(work나 pivo + action 또는 name). action=hold(홀드)/unhold/process/pause/complete(완료)/cancel(취소), name=새 프로젝트명. '○○ 홀드/완료/취소해줘', '○○ 프로젝트명 △△로' 류. 한 번에 하나(상태 or 이름). 게이트형(버튼)—'바꿨다' 단정 금지. (검수 후 가제→FIX의 TOTUS 부분; 납품·출판사 시트 변경은 별도.)",
  "- 설정집 작성 요청 생성('수주 확정됐어 설정집 요청해줘', 견적요청 스레드에서 호출): propose_setjip_request(pivo, apm, [translator], [typesetter]). 스레드 본문의 [PV-xxxxxx]에서 PIVO를 읽고(여러 작품이면 각 PIVO마다 한 번씩), 담당 APM 이름만 받아라(번역/식자는 사용자가 주면 반영, 없으면 기본값). 작품명·원제·제출일·초도정보·국가/기대치/특이사항은 견적+내부시트에서 자동. 게이트(버튼)—'게시했다' 단정 금지. APM 이름이 안 나오면 누구 담당인지 한 줄 되묻기.",
  "- 원고수급/이관 시트 미발송 일괄 전송('원고수급 미발송 전송/돌려줘', '이관 시트 업데이트 돌려줘', '원본수급 알림 안 보낸 거 보내줘'): run_wongo_update(인자 없음). ★재상 님이 버튼 없이 바로 실행하기로 함 — 확인 버튼 없이 즉시 전송하고 결과만 보고. 성공이면 '○건 전송했어요' 한 줄, 실패/타임아웃이면 분명히 알릴 것. 사용자가 명시적으로 전송을 요청했을 때만 호출(임의 실행 금지).",
  "- 번역 개시 요청(설정집 검수 끝난 뒤 '○○ 번역 개시/번역 시작 요청해줘'): propose_translation_start(work=작품명 또는 PIVO). DM에서 불러도 됨 — 도구가 설정집 작성 요청 채널을 검색해 그 작품의 스레드를 찾고, 메시지의 담당 APM 멘션·PIVO를 추출, PIVO로 견적 조회해 초도 납품일·초도 회차를 자동으로 채운다. 한국어 타이틀은 보통 이 대화에서 함께 정한 합의 제목을 ko_title로 넘긴다(없으면 견적 제목). 검수 시작일 자동(요청일+11일). 발송은 그 설정집 스레드에 답글, APM 실제 멘션(게이트 버튼). 수정사항·타이틀은 ✏️수정 모달로도 입력. ★번역개시 발송(✅) 후 TOTUS 프로젝트명 가제→FIX 변경 제안 + 1-3화 번역검수 자동 모니터 등록은 봇이 자동으로 이어서 하니, propose_totus_project·register_translation_monitor를 따로 부르지 말 것(수동 등록 요청 때만 register). 후보 여러 건이면 사용자에게 되묻기. 검색이 안 잡혀 사용자가 설정집 작성 요청 메시지 '링크 복사' 값을 주면 thread 인자로 넘겨라(그러면 검색 없이 그 스레드에 바로 발송). ★재상 님이 설정집 파일을 올리며 번역개시를 요청하면, 그 **파일명의 일본어 가제 또는 중국어 원제**를 work로 써서 검색하라(파일명에 【修正要望】 등 군더더기가 붙어도 작품 제목 부분만). 그리고 그 메시지에 올린 파일들은 발송 시 그 스레드에 자동으로 같이 첨부된다(봇이 재업로드—따로 첨부하라고 안내할 필요 없음). '보냈다' 단정 금지.",
  "★PIVO ID 상식: 프로젝트명·메시지·견적요청 본문의 **`[PV-숫자]`(보통 6자리)에서 그 숫자가 PIVO ID**다. 도구에 PIVO를 넘길 땐 'PV-' 접두를 떼고 **숫자만** 넘겨라('PV-201454'→'201454'). 그리고 PIVO로 견적/프로젝트를 못 찾으면 거기서 멈추지 말고 **일본어 가제나 중국어 원제로도 조회**해본다(견적 by-pivo·totus_find_project 둘 다 이름검색이 됨).",
  "★용어 구분(엄수·문맥으로 판단): **'납품일'**(='예정' 글자 없음) → 무조건 **내부 납품 시트 get_delivery_date**. **'납품예정일'/'납품 예정일'/'TOTUS 납품예정일'**(예정 명시) → **TOTUS totus_delivery_date**. 즉 '예정'이 안 붙으면 시트가 기본이다 — 그냥 '납품일 조회'에 totus_delivery_date를 쓰지 마라(혼동 금지). 애매하면 시트(get_delivery_date) 우선. ③totus_jobs·totus_tasks·totus_schedule_summary의 마감일은 *오퍼레이션*(PIVO 납품검수 등) 마감일이지 납품예정일이 아니다 — '납품예정일'이라 단정 금지.",
  "- 작품 기본정보(PIVO ID·타이틀·APM·출판사) → get_work_info",
  "- 작품 '원본 링크/원고 받는 곳/원본 수급처' 요청 → get_work_info의 driveLink(출판사 드라이브 링크)를 답한다. driveLink가 있으면 그 URL을 그대로 주고, 비어있으면(없음) '원본 링크는 시트에 없어요 — 출판사 {publisher}에서 중국어 제목 「{zhTitle}」로 검색하세요'처럼 **출판사(publisher) + 중국어 원제(zhTitle)** 를 함께 알려준다(드라이브를 중국어 작품명으로 검색하므로 zhTitle 필수). ★단 출판사가 bilibili comics(哔哩哔哩漫画)나 kuaikan(快看漫画)이면 긴 검색 안내는 생략하되 **플랫폼명 + 중국어 원제(zhTitle)** 를 함께 짧게 준다(원제로 검색하므로 필수). 예: '비리비리예요 — 원제: 「{zhTitle}」' / '콰이칸이에요 — 원제: 「{zhTitle}」'.",
  "- TOTUS 링크 요청: 작품 '프로젝트/작업진행 페이지 링크' = get_project_url(작품) (작품 단위, 회차 불필요). 특정 회차·오퍼레이션의 '에디터 링크' = get_editor_url(작품, 회차, 오퍼레이션명) (상태 무관 최신 task 기준).",
  "- 원본/원고/소스 'PSD·파일 다운로드' 요청 → get_source_files(작품, 회차[, page]). 특정 페이지만(예 '48화 2페이지', '3,4페이지')이면 page 인자에 번호를 넣는다. 돌려받은 **파일명 + 다운로드 링크만 그대로 안내**한다(봇이 파일을 직접 받거나 슬랙에 올리지 말 것 — 대용량이라 링크로만). 링크는 cf.totus.pro 서명 URL이라 클릭하면 바로 받힌다(로그인 불필요·일정 시간 후 만료).",
  "- 그 외 운영 시트 → query_sheet (사용 가능한 뷰 목록·필드는 그 도구 설명에 들어있으니 거기 보고 고른다).",
  "query_sheet 효율 규칙(중요): 리스트/현황/기간 질문은 한 번의 호출로 서버측에서 좁혀 가져온다. filterField/filterOp/filterValue(예: 리테이크 미완료=filterField:done, filterOp:neq, filterValue:완료), dateField/dateFrom/dateTo(기간), distinct(중복 제거)를 적극 사용. work 없이 큰 시트를 통째로 가져오거나, 같은 호출을 반복하지 말 것. 한 번에 답이 되도록 필터를 설계해 호출 횟수를 최소화한다.",
  "- TOTUS(작품 진행상황·일정 지연/임박·작업자·번역텍스트·견적) → totus_* 도구. PIVO ID 있으면 totus_quotation으로 projectUuid부터 확보 → 그 uuid로 totus_schedule_summary(일정)·totus_jobs/totus_tasks(작업·상태). 작품명만 있으면 totus_find_project로 uuid. 진행/일정/작업자는 시트보다 TOTUS가 정확. 번역텍스트(totus_translation_text)는 양 많으니 필요한 Task에만.",
  "- 번역 검수/QA 요청(예: '게임속기연 90 검수', '○○ ○○화 검수해줘') → review_episode(work, episode). 한일이면 lang 생략(ko-ja 기본), 중일이면 zh-ja. 스레드에서 작품명·회차가 보이면 그걸 읽어 호출한다. 도구가 돌려준 [검수 기준]과 pairs로 2패스 검수해, 문제 있는 항목만 [출력 템플릿]대로 작성한다(작품/회차/단계 + task URL + 페이지-텍박 + 수정전→후 + 사유). 문제 없으면 '問題なし'. 이 검수표는 그대로 작업자에게 복붙되는 것이니 임의 해설·강조 없이 템플릿만 깔끔히. error가 오면 그 사유를 그대로 전한다.",
  "★ 검수 결과 전달 규칙: 검수표는 **그냥 네 답변 텍스트로 출력만** 해라 — 시스템이 사용자가 부른 바로 그 자리(스레드/DM)에 자동으로 전달한다. send_message 도구로 직접 보내거나, DM/채널로 따로 발송하거나, 작업자 DB(slack_id/채널)를 조회해 보내려 하지 마라. 'DM으로 보냈다'·'DB에 ID가 없어 못 보냈다' 같은 발송 관련 말도 하지 마라(전달은 시스템 몫). 진행 신호(🔎 추출 완료)도 시스템이 자동으로 띄우니 네가 따로 만들지 마라.",
  "- query_sheet 뷰에 없는 탭을 물으면 → read_tab(탭 이름). 시트 실제 헤더가 곧 필드명이라 사용자가 말한 헤더로 바로 거른다. 표 헤더가 중간 행이면 headerRow 지정. 알려진 6개 시트의 어떤 탭이든 조회 가능.",
  "- 스레드 찾기('○○ 작품 ~~ 스레드 찾아줘', '○○ 관련 논의 어디 있어', 과거 대화/스레드 내용): find_thread(query=작품명+키워드). 등록된 주요 업무 채널들에서 검색해 매칭 스레드를 찾고, 1개로 분명하면 내용(topContent)까지 와서 요약·답+링크. 여러 개면 후보를 보여주고 어느 건지 되묻거나 키워드를 좁힌다(임의 단정 금지). 사용자가 특정 채널을 말하면 channel 인자로. 특정 스레드/링크를 콕 집으면 read_thread. (등록 채널·봇 멤버 범위 내 — 전역 검색 아님)",
  "- '고객사 스케줄 시트'(중일, =내부 납품 시트와 다름) 질문 → query_schedule. 블록 구조라 query_sheet/read_tab으론 안 됨. '○○ N화 런칭일'·재수급/문의 확인 후 납품일 재설정 기준 런칭일=mode:launch(work나 pivo + episode, PIVO로 정확매칭), 'N/일 납품 회차 카운트'=mode:delivery_on+date, '원본 미수급'=mode:missing, '○○ 작품 스케줄'=mode:work. ID 묻지 말 것(이 도구가 그 시트임). 런칭일 못 찾으면 PIVO ID나 일본어 제목 확인을 요청(한국어만으론 시트에 없을 수 있음).",
  "★ 용어 사전(재상 님 표현 → 정확한 소스. 이 매핑을 *최우선*으로 따르고 추측하지 말 것): '에러율/월간 에러율' = 리테이크 시트 '중일 에러율' 탭의 '월별 전체 에러율'(기준월별, 에러작품 Top5 포함) → read_tab(tab:'중일 에러율'). '합격률/등급/KP등급' = 번역가_등급표(translator_grade 뷰). 사전에 없는데 한 용어가 여러 소스로 갈릴 수 있으면, 임의로 고르지 말고 '어느 걸 말씀하시는지' 짧게 되묻는다.",
  "- 학습/교정(영구): 재상 님이 '앞으로 ~로 기억해/외워둬', '이건 이렇게 이해해', 또는 내가 잘못 이해한 걸 바로잡아 주면 → remember(note)로 저장한다(재기동에도 유지, 다음부터 자동 적용). '그 규칙 잊어'=forget, '뭐 배웠어'=list_learned. ★단순 '나중에 ~할 일'은 add_reminder(리마인더), 항구적 동작 규칙·별칭·이해 교정은 remember로 구분. 모호하면 '리마인더로 할까요, 규칙으로 외울까요?' 한 줄 확인.",
  "- 리마인더 두 종류: ①시각 없이 '이거 기억해둬'·'나중에 ~해야 해'·'~잊지마' → add_reminder(text) (끝내거나 '그만'할 때까지 하루 여러 번 자동 재촉, 시간 묻지 말 것). ②특정 시각 '월요일 오전 10시에 ~ 리마인드'·'내일 3시에' → schedule_reminder(text, when) (when은 메시지 앞 [현재 시각(KST)] 기준으로 ISO8601 계산, +09:00). 목록 → list_reminders. 완료('~했어'·'N번 완료'·'해결됐어')거나 중단('그만'·'멈춰'·'이건 그만 리마인드해') 신호 → complete_reminder(번호 또는 내용 일부). 재촉 중인 일을 대화로 처리하다가 '그만/됐어' 신호가 오면 그 항목을 complete_reminder로 빼라.",
  "그 밖에 도구가 없는 일이면, '도구가 없다'를 장황히 설명하지 말고 — 아는 선에서 바로 도움이 되는 답을 주고, 정확한 데이터가 필요하면 어디(어느 시트·채널)를 보면 되는지 한 줄로만 짚어준다.",
  "★계산·집계·무거운 작업은 compute로(암산·수동 카운트 금지, 타임아웃 방지): 합계·환율·정산·통계·CSV/시트 집계(개수·비율·분류·TOP N)는 머리로 세지 말고 compute로 코드 실행. 첨부 CSV/엑셀은 compute 안 attachments[i].text로 직접 접근(원문 재기입 금지). 시트 대량 집계는 read_tab으로 행을 가져와 compute에 넘겨 계산(수백 행 직접 세지 말 것). 번역 검수(review_episode)는 한 번에 한 작품·회차씩만 — 몰아치면 타임아웃. ★검수 요청이 **여러 작품**(예 '위 8작품 하나씩 순차 검수')이면 review_episode를 한 턴에 반복 호출하지 말고(중간에 타임아웃 남) **review_queue(works=[{work,episode,lang?}…])로 한 번에 큐잉**하라 — 그러면 봇이 작품당 별도 턴으로 차례차례 검수해 각 결과를 올린다. 한 작품만이면 review_episode 직접.",
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
// 지금 턴이 온 스레드(요청 자리)의 슬랙 퍼머링크. 리마인더에 '어디서 요청했는지' 링크를 붙일 때 사용.
async function ctxPermalink() {
  const c = currentCtx;
  if (!c?.client || !c?.channel || !c?.ts) return null;
  try { const pl = await c.client.chat.getPermalink({ channel: c.channel, message_ts: c.ts }); return pl?.permalink || null; }
  catch { return null; }
}
const EDIT_TTL_MS = 24 * 60 * 60 * 1000;   // 버튼 유효 24h (영속화로 재시작에도 유지)

const SETJIP_CHANNEL = process.env.SETJIP_CHANNEL || "C09AUQN8GEB";   // 설정집 작성 요청 채널(#재팬_작업요청)
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
const totusTool = (fn) => async (a) => { try { return { content: [{ type: "text", text: capJson(await fn(a)) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } };

// JOB Task 조회 시 '식자검수 이후 후공정'(납품검수·PIVO 납품검수·고객검수·최종검수)은 기본 제외 — 식자검수까지만.
const POST_SIKJA_OPS = ["납품검수", "고객검수", "최종검수"];   // 이름 부분일치(공백제거). 'PIVO 납품 검수'는 '납품검수'로 걸림
const isPostSikjaOp = (op) => { const nm = String(op?.태스크?.[0]?.오퍼레이션유형명 || "").replace(/\s/g, ""); return !!nm && POST_SIKJA_OPS.some((e) => nm.includes(e)); };
const trimJobsAtSikja = (j) => { for (const job of j?.data || []) if (Array.isArray(job.오퍼레이션)) job.오퍼레이션 = job.오퍼레이션.filter((op) => !isPostSikjaOp(op)); return j; };

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
              else items.set(ep, { jobProcessUuid: m[0].jobProcessUuid, episode: ep, currentDate: m[0].납품예정일 ? String(m[0].납품예정일).slice(0, 10) : null, deliveryDate: date });
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
          const fmt = (iso) => (iso ? String(iso).slice(0, 10) : null);
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
          const proj = (fp?.data || [])[0];
          if (!proj?.uuid) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음.` }) }] };
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
      "get_project_url",
      "작품의 TOTUS 작업진행관리 프로젝트 링크(admin.totus.pro/ko/workProgressManagementDetail/?id={projectUuid})를 준다. 작품 단위 페이지(회차 전체 포함)라 회차 불필요. '프로젝트 링크/작업진행 페이지/TOTUS 작품 링크' 요청에 쓴다.",
      { work: z.string().describe("작품명(한/일/중) 또는 PIVO ID") },
      async ({ work }) => {
        try {
          const fp = await findProject(work);
          const proj = (fp?.data || [])[0];
          if (!proj?.uuid) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음.` }) }] };
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
          const fp = await findProject(work);
          const proj = (fp?.data || [])[0];
          if (!proj?.uuid) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음.` }) }] };
          const projName = String(proj.프로젝트 || work).replace(/\[[^\]]*\]\s*/g, "").trim();
          const r = await deliverySourceGroups(proj.uuid, String(episode));
          const groups = r?.data || [];
          if (!groups.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, work: projName, msg: `${episode}화 원본(소스) 파일을 못 찾음. 회차 표기 확인 필요.` }) }] };
          const pageOf = (name) => { const m = String(name).replace(/\.[^.]+$/, "").match(/\d+/g); return m ? parseInt(m[m.length - 1], 10) : null; };
          let out = groups.flatMap((g) => (g.파일목록 || []).map((f) => ({ episode: g.에피소드, page: pageOf(f.파일이름), file: f.파일이름, ext: f.확장자, url: f.다운로드URL })));
          const all = out;
          if (page != null && String(page).trim() !== "") {
            const want = String(page).split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
            out = all.filter((f) => want.includes(f.page));
            if (!out.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, work: projName, episode, msg: `${episode}화에서 페이지 ${page} 파일을 못 찾음.`, 전체파일: all.map((f) => `${f.file}(p${f.page})`) }) }] };
          }
          return { content: [{ type: "text", text: capJson({ work: projName, episode, page: page || "전체", 파일수: out.length, files: out, note: "다운로드URL은 서명된 직접 링크(로그인 불필요, 일정 시간 후 만료). 사용자에게 파일명과 링크를 그대로 안내." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool("review_episode",
      "웹툰 번역 검수: 작품명+회차만 주면 납품탭에서 PIVO를 찾아 식자번역검수(없으면 번역검수/번역) 텍스트를 추출해 돌려준다. 한일이면 lang 'ko-ja'(기본), 중일이면 'zh-ja'. 검수 요청(예 '게임속기연 90 검수')이면 이 도구를 쓰고, 돌려받은 [검수 기준]대로 pairs를 2패스 검수해 문제 있는 항목만 [출력 템플릿]으로 작성한다. 결과에 error가 있으면 그 메시지를 그대로 사용자에게 전한다. taskUuid 직접 추출(translation_text)은 이 도구를 못 쓸 때만.",
      {
        work: z.string().describe("작품명(한국어, [출판사] 접두사 없어도 됨)"),
        episode: z.string().describe("회차 숫자"),
        lang: z.enum(["ko-ja", "zh-ja"]).optional().describe("ko-ja=한일(기본), zh-ja=중일"),
        stage: z.enum(["식자번역검수", "번역검수", "번역"]).optional().describe("검수 대상 단계. 생략 시 텍스트 있는 마지막 단계 자동(식자번역검수>번역검수>번역)"),
      },
      async (a) => {
        console.log(`[review] 추출 시작: ${a.work} ${a.episode}화 (lang=${a.lang ?? "ko-ja"}${a.stage ? ", " + a.stage : ""})`);
        try {
          const r = await extractEpisode({ work: a.work, episode: a.episode, lang: a.lang ?? "ko-ja", stage: a.stage ?? null });
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
      "여러 작품을 '순차 검수'할 때 쓴다(예 '위 8작품 하나씩 순차 검수해'). 작품마다 **별도 턴**으로 큐에 넣어, 한 턴=한 작품으로 차례차례 review_episode 검수하게 한다(한 턴에 몰면 타임아웃 나므로 절대 직접 여러 개를 검수하지 말고 이 도구로 큐잉). works=검수할 [{work, episode, lang?}] 목록(사용자/스레드에서 순서대로 파싱). 등록만 하고 즉시 반환하며, 이후 봇이 하나씩 자동으로 검수해 각 결과를 이 자리(스레드/DM)에 올린다.",
      {
        works: z.array(z.object({
          work: z.string().describe("작품명(한국어)"),
          episode: z.string().describe("회차 숫자"),
          lang: z.enum(["ko-ja", "zh-ja"]).optional().describe("ko-ja=한일, zh-ja=중일"),
        })).describe("검수할 작품·회차 목록(처리 순서대로)"),
      },
      async ({ works }) => {
        try {
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "맥락을 못 잡음." }) }] };
          const list = (works || []).filter((w) => w?.work && String(w.episode ?? "").trim());
          if (!list.length) return { content: [{ type: "text", text: JSON.stringify({ error: "검수할 작품 목록(works)이 비었음. 작품명·회차를 파싱해 넘겨라." }) }] };
          const reqUser = currentUser;
          list.forEach((w, i) => {
            const langArg = w.lang ? `, lang="${w.lang}"` : "";
            const content = `[순차 검수 ${i + 1}/${list.length}] 다음 한 작품만 검수하라(다른 작품은 신경 쓰지 말 것). review_episode(work="${w.work}", episode="${String(w.episode).trim()}"${langArg}) 를 호출하고, 돌려받은 [검수 기준]대로 pairs를 2패스 검수해 문제 있는 항목만 [출력 템플릿]으로 작성하라. 문제 없으면 '${w.work} ${w.episode}화: 問題なし'.`;
            queue.push({ content, ctx: { client: ctx.client, channel: ctx.channel, threadTs: ctx.threadTs, ts: ctx.ts, done: false }, user: reqUser });
          });
          if (wake) { const wk = wake; wake = null; wk(); }
          return { content: [{ type: "text", text: JSON.stringify({ queued: list.length, order: list.map((w) => `${w.work} ${w.episode}`), note: `${list.length}작품을 한 작품씩 차례로 검수하도록 큐에 넣었음. 사용자에겐 '${list.length}작품 순차 검수 시작할게요 — 하나씩 결과 올릴게요'라고만 간단히 알리고, 직접 검수하려 들지 말 것(각 작품은 별도 턴에서 처리됨).` }) }] };
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
    tool("send_message",
      "슬랙으로 메시지를 보낸다. 받는이가 재상 님 본인(U04463JR4HH)이면 바로 발송, 그 외(다른 사람/채널)면 프리뷰+확인 버튼 후 발송. target=채널ID(C…) 또는 사용자ID(U…). 사람 이름만 알면 먼저 query_sheet(worker_db)로 slack_id를 조회해 ID로 넘겨라. 특정 스레드에 댓글로 달려면 thread에 그 메시지 링크(permalink)를 넘겨라(그러면 그 스레드 답글로 발송). 임의로 '보냈다'고 말하지 말 것(확인 대기일 수 있음).",
      { target: z.string().optional().describe("받는 곳: 채널 ID(C…) 또는 사용자 ID(U…). thread(링크)를 주면 채널은 링크에서 자동 추출되므로 생략 가능"), text: z.string().describe("보낼 메시지 내용"), thread: z.string().optional().describe("스레드 답글로 달 대상 메시지의 슬랙 링크(permalink) 또는 thread_ts. 주면 그 스레드 안에 댓글로 발송") },
      async ({ target, text, thread }) => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "발송 컨텍스트 없음" }) }] };
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
      "리테이크(수정 요청) 피드백을 번역가에게 보낼 '발송 제안'을 한다('이 리테이크 번역가에게 공유/보내줘'). 작품·회차·수정내용으로 일본어 메시지(고정 템플릿)를 만들어 확인 버튼과 함께 보낸다 — 재상 님이 버튼을 눌러야 실제 발송. 작품명은 FIX 일본어 타이틀, 받는이는 번역가(작업자 DB의 채널), cc는 작품 APM, 참고 에디터는 식자검수 URL을 자동으로 채운다. 수정내용(fix)은 리테이크 메시지 그대로 옮기되 '오류→수정'(예 買ってきてね -> 勝ってきてね) 형태가 있으면 그대로 넣어라. 절대 '보냈다'고 단정하지 말 것(확인 대기).",
      {
        work: z.string().describe("작품명(한/일/중) 또는 PIVO ID"),
        episode: z.string().describe("리테이크 화수. 단일('121'), 범위('121-123'), 목록('121,122') 가능. 여러 회차면 회차별 식자검수 링크가 들어간다."),
        fix: z.string().describe("수정 내용. 반드시 일본어로만 작성(한국어 사유·설명은 일본어로 번역, 예 '「楽」が旧字体になっていたため新字体に修正'). 가능하면 '오류원문 -> 수정문' 형태(예 '買ってきてね -> 勝ってきてね')."),
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
      "query_sheet 뷰에 없는 임의 탭을 탭 이름으로 직접 조회한다(read-only). 시트의 *실제 헤더*를 필드명으로 쓰므로 한글/일본어 헤더 그대로 필터·기간조회 가능. sheet 생략 시 알려진 시트들(delivery/ops/worker/retake/schedule/kp_eval)에서 탭명 자동검색. 헤더가 1행이 아니면 headerRow 지정(예 作業記録=4). 같은 데이터를 query_sheet 뷰로 조회할 수 있으면 그걸 우선 쓰고, 뷰에 없는 탭일 때 이걸 쓴다.",
      {
        tab: z.string().describe("탭 이름(부분일치 OK)"),
        sheet: z.string().optional().describe("스프레드시트 별칭 delivery/ops/worker/retake/schedule/kp_eval (생략 시 자동검색)"),
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
    tool("notion_search", "노션에서 페이지/DB를 키워드로 검색(읽기). 통합에 공유된 것만 보임. 결과의 id로 notion_read_page 호출.",
      { query: z.string().describe("검색 키워드") },
      async (a) => { try { return { content: [{ type: "text", text: capJson(await notionSearch(a.query)) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: true } }),
    tool("notion_read_page", "노션 페이지 본문을 텍스트로 읽는다. notion_search 결과의 id를 넣는다.",
      { pageId: z.string().describe("노션 페이지 ID") },
      async (a) => { try { return { content: [{ type: "text", text: capJson(await notionReadPage(a.pageId)) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: true } }),
    tool("query_schedule",
      "중일 '고객사 스케줄 시트'(내부 납품 시트와 다름) 조회. 블록 구조라 일반 query_sheet/read_tab으로는 안 되고 이 도구로만. mode: 'launch'(★특정 회차의 런칭일=주차별 リリース日 + 그 주차 납품예정일. work나 pivo + episode. PIVO ID로 정확매칭하니 가장 신뢰도 높음) · 'delivery_on'(특정 날짜에 납품 예정인 회차 집계, date 필수 예 '6/19') · 'missing'(런칭 임박인데 原本 미수급 회차, monthsAhead 기본1) · 'work'(작품별 주차 스케줄 전체, work 필수). 작품명·고객사 일정·원본 수급·런칭/납품 회차 질문은 여기로. ★'○○ N화 런칭일'·재수급/문의 확인 후 납품일 재설정 기준 런칭일 → mode:launch.",
      { mode: z.enum(["launch", "delivery_on", "missing", "work"]).describe("조회 종류"), date: z.string().optional().describe("delivery_on용 날짜 M/D (예 6/19)"), work: z.string().optional().describe("work/launch용 작품명(한/일/중 무엇이든)"), pivo: z.string().optional().describe("launch용 PIVO ID(있으면 가장 정확). 작품명 대신/병행 사용"), episode: z.string().optional().describe("launch용 회차 번호(예 '289'). 생략 시 주차 전체 반환"), monthsAhead: z.number().optional().describe("missing용 런칭 임박 개월(기본 1)") },
      async ({ mode, date, work, pivo, episode, monthsAhead }) => {
        try {
          let r;
          if (mode === "launch") r = await episodeLaunch({ work, pivo, episode });
          else if (mode === "delivery_on") r = await deliveryOnDate(date);
          else if (mode === "missing") r = await missingOriginals({ monthsAhead: monthsAhead ?? 1 });
          else if (mode === "work") r = await workSchedule(work);
          else r = { error: "mode는 launch|delivery_on|missing|work 중 하나" };
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
          let firstDelivery = first_delivery_date?.trim() || "", firstEpisode = first_episode?.trim() || "", koFromQuote = "";
          if (pivo) {
            try {
              const q = await quotationByPivo(pivo);
              const d = Array.isArray(q?.data) ? q.data[0] : null;
              if (d) {
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
      "원고수급(납품·이관) 시트의 '미발송' 건(발송 여부 N열 미체크 & 담당 APM 매칭 & 작품명 있음)을 GAS 웹앱으로 일괄 전송한다. ★재상 님이 버튼 없이 바로 실행하기로 함 — 이 도구는 확인 버튼 없이 즉시 슬랙 리포트 전송 + N열 체크 + n8n 반영을 수행하고 결과만 보고한다. '원고수급 미발송 전송/돌려줘', '이관 시트 업데이트 돌려줘', '원본수급 알림 안 보낸 거 보내줘' 류에 사용. 사용자가 명시적으로 전송을 요청했을 때만 호출(임의 실행 금지). 빈 행·담당자 미매칭은 GAS가 제외. 성공 시 간단히, 실패/일부실패/타임아웃이면 분명히 보고.",
      {},
      async () => {
        try {
          const _d = ownerOnly(); if (_d) return _d;
          const r = await wongoPost(false);                 // 버튼 없이 즉시 실제 전송
          const sent = r.managers ?? 0, failed = r.failedManagers ?? 0, rows = r.rows ?? 0;
          if (sent === 0 && failed === 0) return { content: [{ type: "text", text: JSON.stringify({ ok: true, pending: 0, note: "보낼 미발송 건이 없었음(전부 발송됨/담당자 미매칭). 사용자에게 '보낼 거 없었어요'만 간단히." }) }] };
          if (failed > 0) return { content: [{ type: "text", text: JSON.stringify({ ok: false, sent, failed, rows, codes: r.codes, note: `일부/전부 전송 실패(웹훅 응답코드 확인). 성공 ${sent}명/${rows}건만 체크됨, 실패분은 N 그대로. 사용자에게 실패 사실과 코드를 분명히 알릴 것.` }) }] };
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, sent, rows, note: `전송 완료(APM ${sent}명/${rows}건). 사용자에게 간단히 '○건 전송했어요'.` }) }] };
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
      const r = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
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
      allowedTools: ["mcp__apm__get_delivery_date", "mcp__apm__retake_query", "mcp__apm__delivery_on_date", "mcp__apm__get_work_info", "mcp__apm__query_sheet", "mcp__apm__propose_delivery_edit", "mcp__apm__propose_totus_delivery_edit", "mcp__apm__totus_delivery_date",
        "mcp__apm__totus_quotation", "mcp__apm__totus_find_project", "mcp__apm__totus_schedule_summary", "mcp__apm__totus_jobs", "mcp__apm__totus_tasks", "mcp__apm__totus_task", "mcp__apm__totus_translation_text", "mcp__apm__get_editor_url", "mcp__apm__get_project_url", "mcp__apm__get_source_files",
        "mcp__apm__review_episode", "mcp__apm__review_queue", "mcp__apm__find_thread", "mcp__apm__read_thread",
        "mcp__apm__send_message", "mcp__apm__share_feedback", "mcp__apm__propose_retake", "mcp__apm__propose_translation_start", "mcp__apm__propose_setjip_request", "mcp__apm__register_translation_monitor", "mcp__apm__run_wongo_update", "mcp__apm__propose_totus_project", "mcp__apm__propose_totus_complete", "mcp__apm__read_tab", "mcp__apm__notion_search", "mcp__apm__notion_read_page",
        "mcp__apm__query_schedule", "mcp__apm__compute",
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

// ── 부팅 ──────────────────────────────────────────────────────────
const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// DM (message.im) — 본인 DM만, 봇/수정 이벤트 제외
app.message(async ({ message, say, client }) => {
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
    if (!failed.length) await reply(`✅ TOTUS 변경 완료 — ${p.projectName || p.projectUuid}: ${done.map(desc).join(" + ")}${sheetMsg}`);
    else await reply(`⚠️ 일부 실패 — 성공: ${done.map(desc).join(", ") || "없음"} / 실패: ${failed.map((f) => desc(f.ch)).join(", ")}. 실패분만 다시 시도해줘.${sheetMsg}`);
  } catch (e) { await reply(`❌ 변경 실패: ${e?.message ?? e}`); }
});

app.action("proj_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingTotusProj.delete(body.actions?.[0]?.value);
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
    await client.chat.postMessage({ channel: p.channel, text, ...SENDER });
    appendFileSync("logs/sends.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, kind: "setjip", channel: p.channel, work: p.work, pivo: p.e?.pivo }) + "\n");
    await reply(`✅ 설정집 작성 요청 게시 완료 → <#${p.channel}> (${p.work})`);
  } catch (e) {
    await reply(`❌ 게시 실패: ${e?.message ?? e}\n(봇이 그 채널 멤버인지 확인)`);
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
  let expectation = ""; const eLine = lines.find((l) => /기대치/.test(l)); if (eLine) { const em = eLine.match(/기대치\s*[:：]?\s*(.*)$/); expectation = em ? em[1].trim() : ""; }
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
          const apmName = USER_NAMES[p.apmId] || "";   // 출판사 시트 A열(APM 이름)용
          const pjId = `proj_${++totusProjSeq}`;
          // sheet: 확정 시 TOTUS 이름 변경 후 출판사 시트 A(APM)·C(한국어)도 같이 채움
          pendingTotusProj.set(pjId, { projectUuid: d.projectUuid, projectName: d.projectName || "", steps: [{ name: newName }], label: `이름 → *${newName}*`, sheet: { pivo: p.pivo, apmName, koTitle: ko }, createdAt: Date.now() });
          await client.chat.postMessage({
            channel: chan, thread_ts: thread, ...SENDER, text: "TOTUS 프로젝트명 + 출판사 시트 변경 제안",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `🛠 이어서 *TOTUS 프로젝트명* + *출판사 시트*도 FIX로 반영할까요?\n• 프로젝트명: \`${newName}\`\n• 출판사 시트: 한국어 *${ko}*${apmName ? ` · 담당 APM *${apmName}*` : " · (APM 미상 — A열 생략)"}` } },
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
async function tick() { await checkScheduled(); await checkNag(); await checkInitiative(); }

(async () => {
  await app.start();
  if (BRAIN_ON) startSession();   // 엔진을 미리 띄워 워밍(콜드스타트 제거)
  initSince();                    // 토톡 since 복원(없으면 KST 자정)
  refreshJungil().catch((e) => console.error("[totalk] 중일 캐시 초기빌드 실패:", e?.message));   // 중일 작품 uuid 집합 백그라운드 빌드
  tick();                         // 부팅 직후 1회
  setInterval(tick, 60 * 1000);   // 1분마다 (예약은 ~1분 내 발송, 재촉·문의는 dueNagSlot이 시각 슬롯별 하루 1회로 제한)
  console.log(`🤖 디스패처 가동 — 브레인 ${BRAIN_ON ? `ON (${DISPATCHER_MODEL}, 세션 워밍됨)` : "OFF (에코 모드)"} · 재촉 ${BOT_NAG_HOURS}시 · 예약 1분틱`);
})();
