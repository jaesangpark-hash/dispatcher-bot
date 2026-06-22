import "dotenv/config";
import pkg from "@slack/bolt";
const { App } = pkg;
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { lookupDelivery } from "./delivery.js";
import { lookupWork } from "./works.js";
import { queryView, VIEWS, VIEW_CATALOG, readTab } from "./sheets-registry.js";
import { resolveDeliveryCell } from "./delivery-edit.js";
import { setCell, getCell } from "./sheets-write.js";
import { appendFileSync } from "node:fs";
import { quotationByPivo, findProject, scheduleSummary, projectJobs, taskList, taskDetail, translationText, jobProcesses, setDeliveryDate } from "./totus.js";
import { search as notionSearch, readPage as notionReadPage } from "./notion.js";
import { extractEpisode, QA_INSTRUCTIONS } from "./review.js";
import { addReminder, addScheduled, listReminders, completeReminder, dueNag, dueScheduled } from "./reminders.js";
import { missingOriginals, deliveryOnDate, workSchedule } from "./schedule.js";
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
  BOT_NAG_HOUR = "9", // 재촉 리마인더 데일리 발송 시각(시, 로컬). 기본 오전 9시
} = process.env;

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
  "말투: 따뜻하고 친근하게, 군더더기 없이. 표나 정형 양식은 꼭 필요할 때만 쓰고, 평소엔 사람처럼 자연스럽게 대화한다.",
  "내부 구현은 답변에 드러내지 않는다 — 도구명·뷰명(예: translator_grade, query_sheet)이나 '어느 탭·필드에서 어떤 로직으로 가져왔는지'를 괄호로 달거나 설명하지 말 것. 그건 나와 봇만 아는 내부 사정이다. 결과만 자연스럽게 말하고, 사용자가 직접 '어디서 가져왔어?'라고 물을 때만 출처를 짧게 답한다.",
  "강조 기호(**굵게)를 남용하지 않는다 — 정말 핵심 한두 군데만. 평소엔 일반 텍스트로. 표·불릿·헤더도 꼭 필요할 때만.",
  "업무 명령이든 가벼운 잡담이든 가리지 않고 받아준다. '그건 내 역할이 아니다' 같은 선긋기나 자기 한계 변명을 길게 늘어놓지 않는다.",
  "운영 데이터 질문은 추측하지 말고 도구로 실제 시트 값을 조회해 답한다. 작품을 못 찾으면 솔직히 알리고 작품명 표기 확인을 요청한다.",
  "★★ 절대 규칙(최우선): 작품명·고유명사는 도구가 돌려준 셀 값(원문 문자열)을 **글자 하나도 바꾸지 않고 그대로 복사해** 출력한다. 음역·번역·한자↔한글 변환·가나 변환·표기 정리 일체 금지 (예: '最弱'→'최약' 금지, '覇王'→'패왕' 금지). 어느 언어(중/한/일) 제목을 골라올지 판단이 틀릴 수는 있어도, 일단 가져온 제목 문자열은 무조건 셀 값 그대로 출력한다. 한국어·일본어 제목이 둘 다 있으면 섞지 말고 각각 원문대로.",
  "- 납품일/일정 → get_delivery_date (중일 기본, 한일은 ko-ja)",
  "- 납품예정일 '변경' 요청: ①실제 TOTUS/픽코마 시스템 납품예정일 = propose_totus_delivery_edit(PIVO 자동반영) / ②내부 납품관리시트 G열만 = propose_delivery_edit. 둘 다 게이트형(버튼 확인). 어느 쪽인지 불명확하면 'TOTUS 시스템인지, 내부 시트인지' 짧게 되묻고, 절대 '변경했다'고 단정하지 말 것(버튼 눌러야 반영).",
  "★납품예정일 '조회' 구분(중요): ①'TOTUS/실제 시스템 납품예정일'(JobProcess deliveryDate) = totus_delivery_date(work, episode). ②'내부 납품시트' 납품일 = get_delivery_date. ③totus_jobs·totus_tasks·totus_schedule_summary의 마감일은 *오퍼레이션*(PIVO 납품검수 등) 마감일이지 납품예정일이 아니다 — 그걸 '납품예정일'이라 단정 금지. '실제 TOTUS 납품예정일'을 물으면 totus_delivery_date로 정확히 답해라.",
  "- 작품 기본정보(PIVO ID·타이틀·APM·출판사) → get_work_info",
  "- 작품 '원본 링크/원고 받는 곳/원본 수급처' 요청 → get_work_info의 driveLink(출판사 드라이브 링크)를 답한다. driveLink가 있으면 그 URL을 그대로 주고, 비어있으면(없음) '원본 링크는 시트에 없어요 — 출판사 {publisher}에서 중국어 제목 「{zhTitle}」로 검색하세요'처럼 **출판사(publisher) + 중국어 원제(zhTitle)** 를 함께 알려준다(드라이브를 중국어 작품명으로 검색하므로 zhTitle 필수).",
  "- TOTUS 링크 요청: 작품 '프로젝트/작업진행 페이지 링크' = get_project_url(작품) (작품 단위, 회차 불필요). 특정 회차·오퍼레이션의 '에디터 링크' = get_editor_url(작품, 회차, 오퍼레이션명) (상태 무관 최신 task 기준).",
  "- 그 외 운영 시트 → query_sheet (사용 가능한 뷰 목록·필드는 그 도구 설명에 들어있으니 거기 보고 고른다).",
  "query_sheet 효율 규칙(중요): 리스트/현황/기간 질문은 한 번의 호출로 서버측에서 좁혀 가져온다. filterField/filterOp/filterValue(예: 리테이크 미완료=filterField:done, filterOp:neq, filterValue:완료), dateField/dateFrom/dateTo(기간), distinct(중복 제거)를 적극 사용. work 없이 큰 시트를 통째로 가져오거나, 같은 호출을 반복하지 말 것. 한 번에 답이 되도록 필터를 설계해 호출 횟수를 최소화한다.",
  "- TOTUS(작품 진행상황·일정 지연/임박·작업자·번역텍스트·견적) → totus_* 도구. PIVO ID 있으면 totus_quotation으로 projectUuid부터 확보 → 그 uuid로 totus_schedule_summary(일정)·totus_jobs/totus_tasks(작업·상태). 작품명만 있으면 totus_find_project로 uuid. 진행/일정/작업자는 시트보다 TOTUS가 정확. 번역텍스트(totus_translation_text)는 양 많으니 필요한 Task에만.",
  "- 번역 검수/QA 요청(예: '게임속기연 90 검수', '○○ ○○화 검수해줘') → review_episode(work, episode). 한일이면 lang 생략(ko-ja 기본), 중일이면 zh-ja. 스레드에서 작품명·회차가 보이면 그걸 읽어 호출한다. 도구가 돌려준 [검수 기준]과 pairs로 2패스 검수해, 문제 있는 항목만 [출력 템플릿]대로 작성한다(작품/회차/단계 + task URL + 페이지-텍박 + 수정전→후 + 사유). 문제 없으면 '問題なし'. 이 검수표는 그대로 작업자에게 복붙되는 것이니 임의 해설·강조 없이 템플릿만 깔끔히. error가 오면 그 사유를 그대로 전한다.",
  "★ 검수 결과 전달 규칙: 검수표는 **그냥 네 답변 텍스트로 출력만** 해라 — 시스템이 사용자가 부른 바로 그 자리(스레드/DM)에 자동으로 전달한다. send_message 도구로 직접 보내거나, DM/채널로 따로 발송하거나, 작업자 DB(slack_id/채널)를 조회해 보내려 하지 마라. 'DM으로 보냈다'·'DB에 ID가 없어 못 보냈다' 같은 발송 관련 말도 하지 마라(전달은 시스템 몫). 진행 신호(🔎 추출 완료)도 시스템이 자동으로 띄우니 네가 따로 만들지 마라.",
  "- query_sheet 뷰에 없는 탭을 물으면 → read_tab(탭 이름). 시트 실제 헤더가 곧 필드명이라 사용자가 말한 헤더로 바로 거른다. 표 헤더가 중간 행이면 headerRow 지정. 알려진 6개 시트의 어떤 탭이든 조회 가능.",
  "- '고객사 스케줄 시트'(중일, =내부 납품 시트와 다름) 질문 → query_schedule. 블록 구조라 query_sheet/read_tab으론 안 됨. 'N/일 납품 회차 카운트'=mode:delivery_on+date, '원본 미수급'=mode:missing, '○○ 작품 스케줄'=mode:work. ID 묻지 말 것(이 도구가 그 시트임).",
  "★ 용어 사전(재상 님 표현 → 정확한 소스. 이 매핑을 *최우선*으로 따르고 추측하지 말 것): '에러율/월간 에러율' = 리테이크 시트 '중일 에러율' 탭의 '월별 전체 에러율'(기준월별, 에러작품 Top5 포함) → read_tab(tab:'중일 에러율'). '합격률/등급/KP등급' = 번역가_등급표(translator_grade 뷰). 사전에 없는데 한 용어가 여러 소스로 갈릴 수 있으면, 임의로 고르지 말고 '어느 걸 말씀하시는지' 짧게 되묻는다.",
  "- 리마인더 두 종류: ①시각 없이 '이거 기억해둬'·'나중에 ~해야 해'·'~잊지마' → add_reminder(text) (끝낼 때까지 매일 아침 자동 재촉, 시간 묻지 말 것). ②특정 시각 '월요일 오전 10시에 ~ 리마인드'·'내일 3시에' → schedule_reminder(text, when) (when은 메시지 앞 [현재 시각(KST)] 기준으로 ISO8601 계산, +09:00). 목록 → list_reminders. '~했어'·'N번 완료'·'취소' → complete_reminder(번호 또는 내용 일부, 둘 다에 적용).",
  "그 밖에 도구가 없는 일이면, '도구가 없다'를 장황히 설명하지 말고 — 아는 선에서 바로 도움이 되는 답을 주고, 정확한 데이터가 필요하면 어디(어느 시트·채널)를 보면 되는지 한 줄로만 짚어준다.",
  "★계산은 compute로(암산 금지): 다행 합계·환율 변환·벤더별 정산·통계·CSV 집계 등 숫자 계산은 절대 머리로 하지 말고 compute 도구로 코드 실행해 정확히 구한다. 첨부 CSV/엑셀은 compute 안에서 attachments[i].text로 직접 접근(원문 다시 옮겨적지 말 것). 큰 데이터를 직접 나열·암산하려 하지 말 것 — 느리고 틀린다.",
  "★도구 라우팅(엄수·양방향 폴백 금지): ①운영·내부 데이터(작품·납품·일정·작업자·정산·고객사·스케줄 등)는 반드시 내부 도구(get_*·query_sheet·totus_*·read_tab·query_schedule 등)로만 조회한다. 못 찾으면 '못 찾았다'고 답하고 작품명 표기 확인을 요청한다 — 절대 웹으로 넘어가지 마라. ②WebSearch(웹 검색)는 사용자가 '웹에서/검색해줘'라고 명시했거나, 환율·일반상식·뉴스처럼 내부에 있을 리 없는 외부·실시간 정보일 때만 쓴다. 웹에서 못 찾으면 '웹에서 못 찾았다'고 답하고 내부 도구로 폴백하지 마라. ③즉 각 요청은 지정된 한쪽 출처에서만 처리하고, 미스는 '못 찾음'으로 끝낸다(반대편으로 안 넘어감). WebFetch(임의 URL 회수)는 쓰지 말고, 같은 검색을 2회 넘게 재시도하지 마라.",
  "비가역적이거나 고객사로 나가는 동작(발송·삭제·수정)은 절대 임의 실행하지 않고 먼저 확인을 받는다.",
  "모르면 모른다고 솔직하게, 추측이면 추측이라고 표시한다.",
].join("\n");

// ── 중복 처리 방지 (슬랙 재전송 대비) ───────────────────────────────
const processed = new Set();

// ── 게이트형 쓰기: 대기 변경 + 현재 메시지 컨텍스트(버튼 발송용) ───────
const pendingEdits = new Map();   // changeId → { sheetId, cellA1, oldValue, newValue, workName, episode, tab, lang, createdAt }
const pendingTotusDates = new Map();   // changeId → { jobProcessUuid, deliveryDate, reason, work, episode, createdAt } (TOTUS 납품예정일 게이트)
let totusDateSeq = 0;
let currentCtx = null;            // { client, channel, ts } — handle()가 메시지마다 갱신(단일 사용자·직렬 가정)
let editSeq = 0;
const EDIT_TTL_MS = 10 * 60 * 1000;
const STALL_NOTICE_MS = 150 * 1000;   // 이 시간 내 응답 없으면 '처리 중'을 지연 안내로 갱신

// ── 게이트형 발송: 대기 발송 ───────────────────────────────────────
const pendingSends = new Map();   // sendId → { target, text, createdAt }
let sendSeq = 0;

// 큰 JSON 응답이 컨텍스트를 폭발시키지 않게 컷 (TOTUS 등)
const capJson = (obj) => { const s = JSON.stringify(obj); return s.length > 8000 ? s.slice(0, 8000) + `\n…(전체 ${s.length}자 중 8000자만. 필터/대상 좁혀 재조회)` : s; };
const totusTool = (fn) => async (a) => { try { return { content: [{ type: "text", text: capJson(await fn(a)) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } };

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
      "propose_delivery_edit",
      "납품 시트 납품일(G열) 변경/삭제를 '제안'한다. 즉시 바꾸지 않고 대상 셀을 찾아 프리뷰(기존→새값)를 확인 버튼으로 보낸다. 사용자가 버튼을 눌러야 반영. new_date에 날짜를 주면 변경, '삭제'(또는 빈 문자열)면 납품일을 지운다(빈칸). 절대 '변경/삭제했다'고 단정하지 말 것(확인 대기).",
      {
        work: z.string().describe("작품명(한/일/중 무엇이든)"),
        episode: z.string().describe("회차 숫자"),
        new_date: z.string().describe("새 납품일 yyyy-mm-dd. 납품일을 '지우기/삭제'면 '삭제' 또는 빈 문자열을 넣는다."),
        lang: z.enum(["zh-ja", "ko-ja"]).optional().describe("중일=zh-ja(기본), 한일=ko-ja"),
      },
      async ({ work, episode, new_date, lang }) => {
        try {
          const ctx = currentCtx;
          const clearing = !new_date || /^(삭제|지움|지워|지우기|비우기|비움|없음|빈칸|clear|none|empty)$/i.test(String(new_date).trim());
          const newValue = clearing ? "" : new_date;
          const shownNew = clearing ? "(삭제·빈칸)" : new_date;
          const r = await resolveDeliveryCell({ work, episode, lang: lang ?? "zh-ja" });
          if (!r.found) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' ${episode}화를 납품 시트에서 못 찾음. 작품명/회차 확인 필요.` }) }] };
          const changeId = `edit_${++editSeq}`;
          pendingEdits.set(changeId, { sheetId: r.sheetId, cellA1: r.cellA1, oldValue: r.currentDate, newValue, clearing, workName: r.workName, episode: r.episode, tab: r.tab, lang: r.lang, createdAt: Date.now() });
          if (ctx?.client && ctx?.channel) {
            await ctx.client.chat.postMessage({
              channel: ctx.channel, thread_ts: ctx.ts, ...SENDER,
              text: `납품일 ${clearing ? "삭제" : "변경"} 확인: ${r.workName} ${r.episode}화 ${r.currentDate || "(빈칸)"} → ${shownNew}`,
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `⚠️ *납품일 ${clearing ? "삭제" : "변경"} 확인*\n• 작품: *${r.workName}* ${r.episode}화 (${r.lang})\n• 셀: \`${r.cellA1}\`\n• *${r.currentDate || "(빈칸)"}*  →  *${shownNew}*` } },
                { type: "actions", elements: [
                  { type: "button", style: "primary", text: { type: "plain_text", text: "✅ 변경" }, value: changeId, action_id: "delivery_edit_confirm" },
                  { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: changeId, action_id: "delivery_edit_cancel" },
                ] },
              ],
            });
          }
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, action: clearing ? "삭제" : "변경", workName: r.workName, episode: r.episode, from: r.currentDate, to: shownNew, note: "확인 버튼을 보냈음. 사용자가 버튼을 눌러야 반영됨. '버튼을 눌러 확인해 주세요'라고만 안내하고, 변경/삭제 완료라고 말하지 말 것." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "propose_totus_delivery_edit",
      "TOTUS 시스템(어드민/카카오픽코마)의 실제 납품예정일(deliveryDate)을 '변경 제안'한다. 내부 납품관리시트 G열(propose_delivery_edit)과는 다른, 진짜 TOTUS 납품예정일이며 변경 시 PIVO에도 자동 반영된다. 즉시 안 바꾸고 작품·회차로 jobProcess를 찾아 확인 버튼을 보낸다 — 사용자가 버튼을 눌러야 실제 변경. 절대 '변경했다'고 단정 말 것(확인 대기).",
      {
        work: z.string().describe("작품명(한/일/중) 또는 PIVO ID"),
        episode: z.string().describe("회차 숫자(작업단위번호)"),
        new_date: z.string().describe("새 납품예정일 YYYY-MM-DD (KST 23:59로 자동 변환됨)"),
        reason: z.enum(["RETAKE", "CUSTOMER_REQUEST", "INTERNAL_REQUEST", "ETC"]).optional().describe("변경 사유(기본 CUSTOMER_REQUEST)"),
      },
      async ({ work, episode, new_date, reason }) => {
        try {
          const ctx = currentCtx;
          const fp = await findProject(work);
          const proj = (fp?.data || [])[0];
          if (!proj?.uuid) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `'${work}' 프로젝트를 TOTUS에서 못 찾음. 작품명 표기 확인 필요.` }) }] };
          const jp = await jobProcesses(proj.uuid);
          const items = (jp?.data || []).flatMap((o) => o.JOB목록 || []);
          const ep = Number(episode);
          const matched = items.filter((x) => Number(x.작업단위번호) === ep);
          if (!matched.length) return { content: [{ type: "text", text: JSON.stringify({ found: false, msg: `${proj.프로젝트 || work}에서 ${episode}화(작업단위번호) JobProcess를 못 찾음. 회차 확인 필요.` }) }] };
          if (matched.length > 1) return { content: [{ type: "text", text: JSON.stringify({ ambiguous: true, msg: `${episode}화에 JobProcess가 ${matched.length}개(주문/언어 복수). 어느 건지 사용자에게 되물어라.`, candidates: matched.map((x) => ({ jobProcessUuid: x.jobProcessUuid, 태스크상태: x.태스크상태 })) }) }] };
          const jpUuid = matched[0].jobProcessUuid;
          const current = matched[0].납품예정일 ? String(matched[0].납품예정일).slice(0, 10) : null;   // ISO(UTC14:59=KST23:59)→KST 날짜
          const projName = String(proj.프로젝트 || work).replace(/\[[^\]]*\]\s*/g, "").trim();
          const changeId = `tdate_${++totusDateSeq}`;
          pendingTotusDates.set(changeId, { jobProcessUuid: jpUuid, deliveryDate: new_date, reason: reason || "CUSTOMER_REQUEST", work: projName, episode, currentDate: current, createdAt: Date.now() });
          if (ctx?.client && ctx?.channel) {
            await ctx.client.chat.postMessage({
              channel: ctx.channel, thread_ts: ctx.ts, ...SENDER,
              text: `TOTUS 납품예정일 변경 확인: ${projName} ${episode}화 → ${new_date}`,
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `⚠️ *TOTUS 납품예정일 변경 확인*\n• 작품: *${projName}* ${episode}화\n• 납품예정일: ${current || "미설정"} → *${new_date}*` } },
                { type: "actions", elements: [
                  { type: "button", style: "primary", text: { type: "plain_text", text: "✅ 변경" }, value: changeId, action_id: "totus_date_confirm" },
                  { type: "button", style: "danger", text: { type: "plain_text", text: "취소" }, value: changeId, action_id: "totus_date_cancel" },
                ] },
              ],
            });
          }
          return { content: [{ type: "text", text: JSON.stringify({ proposed: true, work: projName, episode, from: current, to: new_date, note: "확인 버튼을 보냈음. 사용자가 버튼을 눌러야 실제 변경됨. '버튼을 눌러 확인해 주세요'라고만 안내하고, 변경 완료라고 말하지 말 것." }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] };
        }
      },
      { annotations: { readOnlyHint: true } }
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
    tool("totus_jobs", "TOTUS JOB→Operation→Task 구조: 회차별 작업·작업자·상태. episode로 특정 회차만.",
      { projectUuid: z.string(), episode: z.string().optional().describe("회차 숫자(생략 시 전체)") },
      totusTool((a) => projectJobs(a.projectUuid, a.episode)), { annotations: { readOnlyHint: true } }),
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
    tool("send_message",
      "슬랙으로 메시지를 보낸다. 받는이가 재상 님 본인(U04463JR4HH)이면 바로 발송, 그 외(다른 사람/채널)면 프리뷰+확인 버튼 후 발송. target=채널ID(C…) 또는 사용자ID(U…). 사람 이름만 알면 먼저 query_sheet(worker_db)로 slack_id를 조회해 ID로 넘겨라. 임의로 '보냈다'고 말하지 말 것(확인 대기일 수 있음).",
      { target: z.string().describe("받는 곳: 채널 ID(C…) 또는 사용자 ID(U…)"), text: z.string().describe("보낼 메시지 내용") },
      async ({ target, text }) => {
        try {
          const ctx = currentCtx;
          if (!ctx?.client) return { content: [{ type: "text", text: JSON.stringify({ error: "발송 컨텍스트 없음" }) }] };
          if (target === DISPATCHER_USER_ID) {
            await ctx.client.chat.postMessage({ channel: target, text, ...SENDER });
            return { content: [{ type: "text", text: JSON.stringify({ sent: true, to: "본인 DM" }) }] };
          }
          const sendId = `send_${++sendSeq}`;
          pendingSends.set(sendId, { target, text, createdAt: Date.now() });
          await ctx.client.chat.postMessage({
            channel: ctx.channel, thread_ts: ctx.ts, ...SENDER, text: `발송 확인: ${target}`,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `✉️ *발송 확인*\n• 받는 곳: ${target.startsWith("C") ? `<#${target}>` : `<@${target}>`}\n• 내용:\n>${String(text).replace(/\n/g, "\n>")}` } },
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
      "중일 '고객사 스케줄 시트'(내부 납품 시트와 다름) 조회. 블록 구조라 일반 query_sheet/read_tab으로는 안 되고 이 도구로만. mode: 'delivery_on'(특정 날짜에 납품 예정인 회차 집계, date 필수 예 '6/19') · 'missing'(런칭 임박인데 原本 미수급 회차, monthsAhead 기본1) · 'work'(작품별 주차 스케줄, work 필수). 작품명·고객사 일정·원본 수급·런칭/납품 회차 질문은 여기로.",
      { mode: z.enum(["delivery_on", "missing", "work"]).describe("조회 종류"), date: z.string().optional().describe("delivery_on용 날짜 M/D (예 6/19)"), work: z.string().optional().describe("work용 작품명(한/일/중)"), monthsAhead: z.number().optional().describe("missing용 런칭 임박 개월(기본 1)") },
      async ({ mode, date, work, monthsAhead }) => {
        try {
          let r;
          if (mode === "delivery_on") r = await deliveryOnDate(date);
          else if (mode === "missing") r = await missingOriginals({ monthsAhead: monthsAhead ?? 1 });
          else if (mode === "work") r = await workSchedule(work);
          else r = { error: "mode는 delivery_on|missing|work 중 하나" };
          return { content: [{ type: "text", text: capJson(r) }] };
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
      "재상 님이 '나중에 챙길 일'을 기억해달라고 할 때 저장한다(재촉 리마인더). 시간 지정 불필요 — 끝낼 때까지 매일 아침 자동으로 재촉 DM이 간다. '이거 기억해둬'·'나중에 ~해야 해'·'~하는 거 잊지마' 류에 사용.",
      { text: z.string().describe("기억할 내용") },
      async (a) => { try { const r = addReminder(a.text); return { content: [{ type: "text", text: JSON.stringify({ saved: true, id: r.id, total: r.total, note: "매일 아침 재촉 예정. 완료되면 알려주면 지움." }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: false } }),
    tool("schedule_reminder",
      "특정 시각에 1회 리마인드. '월요일 오전 10시에 ~ 리마인드'처럼 시각이 주어질 때 사용. when은 ISO8601(예 2026-06-22T10:00:00+09:00) — 메시지 앞 [현재 시각(KST)] 기준으로 계산해서 넣어라. 시각 없이 '그냥 기억해둬'면 이게 아니라 add_reminder를 쓴다.",
      { text: z.string().describe("리마인드할 내용"), when: z.string().describe("발송 시각 ISO8601(KST 오프셋 +09:00 권장)") },
      async (a) => { try { const r = addScheduled(a.text, a.when); if (r.error) return { content: [{ type: "text", text: JSON.stringify(r) }] }; return { content: [{ type: "text", text: JSON.stringify({ scheduled: true, id: r.id, dueAt: r.dueAt }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: false } }),
    tool("list_reminders", "저장된 리마인더 목록(재촉형+시각지정형, dueAt 있으면 시각지정). '내 할일/리마인더 뭐 있어' 류.",
      {},
      async () => { try { return { content: [{ type: "text", text: JSON.stringify({ items: listReminders() }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: true } }),
    tool("complete_reminder",
      "재촉 리마인더를 완료 처리(삭제)한다. '~했어'·'N번 완료'·'~끝냈어' 류. 번호(예 '2') 또는 내용 일부(부분 일치)로 지정.",
      { match: z.string().describe("완료할 리마인더의 번호 또는 내용 일부") },
      async (a) => { try { const r = completeReminder(a.match); return { content: [{ type: "text", text: JSON.stringify({ done: r.done, removed: r.removed.map((x) => x.text), remaining: r.remaining }) }] }; } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e) }) }] }; } },
      { annotations: { readOnlyHint: false } }),
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

// ── 모델: 봇 기능(조회·일정·리마인더·발송) 수행에 최적인 단일 Sonnet(DISPATCHER_MODEL)으로 통일.
//    턴별 전환(Haiku 티어링) 제거 — 모델 고정이 프롬프트 캐시를 유지해 지연↓ + 품질 일관.
//    무거운 판단(검수)은 외부 엔진으로 분리 예정이라 봇은 단일 모델로 충분.

// ── rate-limit(사용량 한도) 처리: 감지 시 친절 안내 + 지수 백오프 자동 재시도 ──
const RL_RE = /rate.?limit|\b429\b|overloaded|too many requests|usage limit|quota|exceeded/i;
const isRateLimit = (s) => RL_RE.test(String(s || ""));
const RL_BACKOFF = [8000, 20000];   // 재시도별 대기(ms). 배열 길이 = 최대 자동 재시도 횟수

const TURN_HARD_TIMEOUT_MS = 210_000;   // 한 턴이 이 시간 넘게 안 끝나면(행/과부하) 중단·재시작(정상 턴은 ~1분 내라 안 걸림)

async function* messageStream() {
  while (true) {
    if (queue.length === 0) await new Promise((r) => { wake = r; });
    while (queue.length) {
      const turn = queue.shift();
      currentTurn = turn;
      currentCtx = turn.ctx;   // 도구(발송·진행알림)가 '이 턴'의 자리로 답하도록 고정
      currentAttachments = turn.attachTexts || [];   // compute 도구가 이 턴 첨부 원문을 쓰도록
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
  const session = query({
    prompt: messageStream(),
    options: {
      model: DISPATCHER_MODEL,
      systemPrompt: DISPATCHER_PROMPT,
      mcpServers: { apm: { type: "sdk", name: "apm", instance: apmTools.instance } },
      // 명시한 apm 서버만 사용하고, 계정/조직에 배포된 외부 커넥터는 전부 무시한다.
      // (claude.ai 조직 커넥터의 깨진 헤더 'Bearer 복사한_토큰'이 봇 세션에 실려
      //  매 응답을 깨뜨리던 문제 차단 — 툰식이는 외부 커넥터가 필요 없음)
      strictMcpConfig: true,
      allowedTools: ["mcp__apm__get_delivery_date", "mcp__apm__get_work_info", "mcp__apm__query_sheet", "mcp__apm__propose_delivery_edit", "mcp__apm__propose_totus_delivery_edit", "mcp__apm__totus_delivery_date",
        "mcp__apm__totus_quotation", "mcp__apm__totus_find_project", "mcp__apm__totus_schedule_summary", "mcp__apm__totus_jobs", "mcp__apm__totus_tasks", "mcp__apm__totus_task", "mcp__apm__totus_translation_text", "mcp__apm__get_editor_url", "mcp__apm__get_project_url",
        "mcp__apm__review_episode",
        "mcp__apm__send_message", "mcp__apm__read_tab", "mcp__apm__notion_search", "mcp__apm__notion_read_page",
        "mcp__apm__query_schedule", "mcp__apm__compute",
        "mcp__apm__add_reminder", "mcp__apm__schedule_reminder", "mcp__apm__list_reminders", "mcp__apm__complete_reminder",
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
  if (user !== DISPATCHER_USER_ID) return;            // 본인만
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
  llmText = `[현재 시각(KST): ${nowStr}]\n${llmText}`;
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
  queue.push({ content, ctx: entry, attachTexts: att.texts });
  if (wake) { const w = wake; wake = null; w(); }

  // 멈춤 감시: 제한시간 내 응답 없으면 '처리 중'을 지연 안내로 갱신(영영 멈춘 듯 보이지 않게)
  if (ph?.ts) setTimeout(() => {
    if (entry.done) return;
    client.chat.update({ channel, ts: ph.ts, text: "⏳ 응답이 좀 늦어지고 있어요. 조금만 더 기다려 주시거나, 안 오면 다시 보내주세요." }).catch(() => {});
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
  if (message.subtype || message.bot_id) return;       // 편집/봇 메시지 무시
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
  try {
    const cur = await getCell(p.sheetId, p.cellA1);           // staleness 재확인
    if (String(cur).trim() !== String(p.oldValue).trim()) {
      return reply(`⚠️ 그새 값이 '${cur}'로 바뀌어 있어 안전하게 취소했어요. 다시 확인하고 요청해줘.`);
    }
    await setCell(p.sheetId, p.cellA1, p.newValue);
    appendFileSync("logs/edits.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, cell: p.cellA1, work: p.workName, episode: p.episode, from: p.oldValue, to: p.newValue, clearing: !!p.clearing }) + "\n");
    await reply(`✅ ${p.clearing ? "삭제" : "반영"} 완료 — ${p.workName} ${p.episode}화 납품일: ${p.oldValue || "(빈칸)"} → ${p.newValue || "(빈칸·삭제됨)"}`);
  } catch (e) {
    await reply(`❌ 반영 실패: ${e?.message ?? e}\n(SA가 '${p.tab}' 시트의 *편집자*인지 확인 필요)`);
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
  try {
    const res = await setDeliveryDate([{ jobProcessUuid: p.jobProcessUuid, deliveryDate: p.deliveryDate, modificationReason: p.reason }], false);
    appendFileSync("logs/totus-dates.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, jobProcessUuid: p.jobProcessUuid, work: p.work, episode: p.episode, to: p.deliveryDate, reason: p.reason, ok: res?.success, resp: res?.data }) + "\n");
    if (res?.success) await reply(`✅ TOTUS 납품예정일 변경 완료 — ${p.work} ${p.episode}화 → ${p.deliveryDate} (PIVO 자동 반영)`);
    else await reply(`❌ 변경 실패 — 실패 ${res?.data?.실패 ?? "?"}건 (failed: ${JSON.stringify(res?.data?.failedJobProcessUuids || [])}). 회차/uuid 확인 필요.`);
  } catch (e) {
    await reply(`❌ 변경 실패: ${e?.message ?? e}`);
  }
});

app.action("totus_date_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingTotusDates.delete(body.actions?.[0]?.value);
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
    await client.chat.postMessage({ channel: p.target, text: p.text, ...SENDER });
    appendFileSync("logs/sends.jsonl", JSON.stringify({ at: new Date().toISOString(), user: body.user?.id, target: p.target, text: p.text }) + "\n");
    await reply(`✅ 발송 완료 → ${p.target.startsWith("C") ? `<#${p.target}>` : `<@${p.target}>`}`);
  } catch (e) {
    await reply(`❌ 발송 실패: ${e?.message ?? e}\n(봇이 그 채널 멤버인지 / 대상 ID가 맞는지 확인)`);
  }
});

app.action("send_cancel", async ({ ack, body, client }) => {
  await ack();
  pendingSends.delete(body.actions?.[0]?.value);
  await client.chat.postMessage({ channel: body.channel?.id, thread_ts: body.message?.thread_ts || body.message?.ts, text: "취소했어요.", ...SENDER }).catch(() => {});
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

// ── 리마인더 발송 (데일리 재촉 + 시각지정 1회) ──────────────────────
let _nagDm = null;
async function dmReminder(text) {
  if (!_nagDm) { const r = await app.client.conversations.open({ users: DISPATCHER_USER_ID }); _nagDm = r.channel.id; }
  await app.client.chat.postMessage({ channel: _nagDm, text, ...SENDER });
}
async function checkNag() {
  try {
    const items = dueNag(parseInt(BOT_NAG_HOUR, 10) || 9);
    if (!items) return;
    const lines = items.map((x) => `${x.id}. ${x.text}`).join("\n");
    await dmReminder(`📌 아직 안 끝난 일, 잊지 마세요! (매일 아침 챙겨드려요)\n${lines}\n\n끝낸 건 "N번 완료" 또는 "○○ 했어"라고 알려주세요.`);
    console.log(`[nag] 재촉 발송 ${items.length}건`);
  } catch (e) { console.error("[nag] 실패:", e?.message ?? e); }
}
async function checkScheduled() {
  try {
    const fired = dueScheduled();
    for (const x of fired) await dmReminder(`⏰ 리마인드: ${x.text}`);
    if (fired.length) console.log(`[reminder] 예약 발송 ${fired.length}건`);
  } catch (e) { console.error("[reminder] 예약 실패:", e?.message ?? e); }
}
async function tick() { await checkScheduled(); await checkNag(); }

(async () => {
  await app.start();
  if (BRAIN_ON) startSession();   // 엔진을 미리 띄워 워밍(콜드스타트 제거)
  tick();                         // 부팅 직후 1회
  setInterval(tick, 60 * 1000);   // 1분마다 (예약은 ~1분 내 발송, 데일리는 dueNag가 하루 1회로 제한)
  console.log(`🤖 디스패처 가동 — 브레인 ${BRAIN_ON ? `ON (${DISPATCHER_MODEL}, 세션 워밍됨)` : "OFF (에코 모드)"} · 재촉 ${BOT_NAG_HOUR}시 · 예약 1분틱`);
})();
