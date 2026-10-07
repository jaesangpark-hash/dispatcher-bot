// 설정집 작성 의향조사 — 작성 요청을 게시한 뒤 「🙋 작업자 의향조사」 버튼을 누르면
// 대상 작업자 개인 채널로 작품 정보 + 가능/불가 버튼을 보내고, 응답을 요청 스레드에 모은다.
//
// 설계 결정(2026-10-07 재상 님 지정):
//   - 개인 채널 + 버튼 — 이모지 반응은 주기적으로 긁어와야 해서 즉시성이 떨어지고,
//     공통 채널은 남의 응답이 보여 눈치를 본다. 누가 무엇을 눌렀는지 확실히 남는 쪽.
//   - 게시와 동시가 아니라 **별도 버튼** — 매번 나갈 필요는 없고 필요할 때만 돌린다.
//   - **번역과 식자를 나눠서** 묻는다. 설정집 작성 요청 자체가 두 역할을 따로 적게 되어 있고,
//     사람도 겹치지 않는다(번역=일본인 번역가 / 식자=이관 명단). 한 번에 섞어 물으면
//     누가 무엇을 하겠다는 건지 알 수 없다.
//
// 채널은 작업자 DB(A이름 C slack D channel)에서 확인한 값. 사람이 바뀌면 여기를 고친다.
// ★언어는 역할마다 다르다(2026-10-07 재상 님 지정) — 번역은 일본인 번역가라 **일본어**,
//   식자는 한국인 작업자라 **한국어**. 그리고 양쪽 다 **본인 멘션 필수**(개인 채널이어도
//   멘션이 있어야 알림이 뜬다 — 멘션 없이 올리면 그냥 지나친다).
export const SURVEY_ROLES = {
  번역: [
    { channel: "C056R2DBFT3", uid: "U0565QMEJMC", name: "Yamamoto Yuka" },
    { channel: "C06UA75SGRG", uid: "U06U79R2A9K", name: "Emi Tamura" },
    { channel: "C058T0ZNSES", uid: "U058K33BXST", name: "Tomomi Morishita" },
    { channel: "C09G7V2J352", uid: "U09GH1639J5", name: "Akiyama Miyu" },
  ],
  식자: [
    { channel: "C05HR4MAGLQ", uid: "U08MW7J2RK5", name: "Tika Mando" },
    { channel: "C04CWM3TQ6Q", uid: "U08HXMGHKGX", name: "강연재" },
    { channel: "C05C93JPJDS", uid: "U05ATD29R4Z", name: "주슬기" },
    { channel: "C034ETP7ZQS", uid: "U08N3JX4TFT", name: "서윤주" },
    { channel: "C0560CEKN2J", uid: "U04NTNW3198", name: "이지인" },
    { channel: "C04NTJNLTGT", uid: "U04NM49BGEA", name: "정은주" },
    { channel: "C052FBQTL11", uid: "U052HVDN1MJ", name: "손광수" },
  ],
};
const ROLE_LANG = { 번역: "ja", 식자: "ko" };

// .env SETJIP_SURVEY_번역 / SETJIP_SURVEY_식자 로 채널 목록을 덮어쓸 수 있다(쉼표 구분).
export function surveyTargets(role) {
  const env = String(process.env[`SETJIP_SURVEY_${role}`] || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length) return env.map((id) => ({ channel: id, name: (SURVEY_ROLES[role] || []).find((w) => w.channel === id)?.name || id }));
  return SURVEY_ROLES[role] || [];
}
export const SURVEY_ROLE_NAMES = Object.keys(SURVEY_ROLES);

// ── 견적의 「작업특이사항」을 번역/식자로 가른다 ──────────────────
// 평가자가 쓴 작품 설명이 두 블록으로 들어 있는데, 헤더 표기가 작품마다 다르다
// (「翻訳」/「식자」 또는 「[번역]」/「[식자]」). 괄호·공백 변형을 받아 둘 다 잡는다.
// 실측 — 중일 13개 작품 전부 분리 성공(2026-10-07).
// ★원문 언어가 역할과 그대로 맞는다: 번역 블록은 일본어, 식자 블록은 한국어로 쓰여 있다.
const NOTE_HEAD = /^[\s[(【「*]*(翻訳|번역|飜訳|식자|写植|食字)[\])】」:：*\s]*$/;
const NOTE_KIND = (s) => (/翻訳|번역|飜訳/.test(s) ? "번역" : "식자");
export function splitWorkNotes(text) {
  const out = {};
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const l = raw.trim();
    if (l && NOTE_HEAD.test(l)) { cur = NOTE_KIND(l); out[cur] = out[cur] || []; continue; }
    if (cur) out[cur].push(raw);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join("\n").trim();
  return out;
}

// ── 작업자에게 보내는 문면 — 번역은 일본어, 식자는 한국어. 맨 앞에 본인 멘션. ──
const L = {
  ja: {
    head: (r) => `🙋 *設定集（${r}）のご対応可否について*`, role: "翻訳",
    work: "作品名", eps: (n) => `初回 ${n}話`, about: "*【作品について】*",
    ask: "翻訳作業が可能かどうかお知らせください。",
    yes: "対応可能", no: "今回は難しい",
    thanks: (y) => `ご回答ありがとうございます — *${y}* で承りました。`,
    changed: "_変更がある場合はこのチャンネルにお知らせください。_",
    closed: "⌛ この依頼はすでに締め切られています。",
  },
  ko: {
    head: (r) => `🙋 *설정집(${r}) 작업 가능 여부 확인*`, role: "식자",
    work: "작품명", eps: (n) => `초도 ${n}화`, about: "*【작업 특이사항】*",
    ask: "식자 작업이 가능하신지 알려주세요.",
    yes: "가능합니다", no: "이번엔 어렵습니다",
    thanks: (y) => `답변 감사합니다 — *${y}*로 접수했습니다.`,
    changed: "_변경이 필요하면 이 채널로 말씀해주세요._",
    closed: "⌛ 이 요청은 이미 마감됐습니다.",
  },
};
export const roleLang = (role) => L[ROLE_LANG[role] || "ko"];

export function workerBlocks(surveyId, s, role, worker) {
  const t = roleLang(role), B = "•";
  const note = (s.workNotes || {})[role] || "";
  const lines = [
    worker?.uid ? `<@${worker.uid}>` : null,   // ★멘션 필수 — 없으면 알림이 안 떠서 그냥 지나친다
    t.head(t.role),
    "",
    // ★일정(제출희망일·납품일)은 넣지 않는다(2026-10-07 재상 님 지정) — 여기서 묻는 건
    //   「이 작업이 가능한가」지 「언제까지 되는가」가 아니다. 일정은 배정 확정 후 따로 간다.
    `${B} ${t.work} : ${s.work}${s.originalTitle ? `（${s.originalTitle}）` : ""}`,
    s.episodes ? `${B} ${t.eps(s.episodes)}` : null,
    s.country ? `${B} ${s.country}` : null,
    // 해당 역할 블록만 — 번역가에게 식자 리터칭 등급을 보여줄 이유가 없다
    note ? `\n${t.about}\n${note}` : null,
    "",
    t.ask,
  ].filter((x) => x !== null);
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: t.yes }, action_id: "setjip_survey_yes", value: `${surveyId}|${role}` },
        { type: "button", text: { type: "plain_text", text: t.no }, action_id: "setjip_survey_no", value: `${surveyId}|${role}` },
      ],
    },
  ];
}

// ── 요청 스레드에 올리는 집계(역할별로 묶어서) ──────────────────
export function summaryText(s) {
  const out = [`🙋 *설정집 작성 의향조사* — ${s.work}`];
  for (const role of SURVEY_ROLE_NAMES) {
    if (!s.sentRoles?.includes(role)) continue;
    const t = surveyTargets(role);
    const ans = s.answers || {};
    const key = (w) => `${role}|${w.channel}`;
    const yes = t.filter((w) => ans[key(w)]?.answer === "yes");
    const no = t.filter((w) => ans[key(w)]?.answer === "no");
    const pending = t.filter((w) => !ans[key(w)]);
    out.push("", `*${role}* — 가능 ${yes.length} / 불가 ${no.length} / 미응답 ${pending.length}`);
    if (yes.length) out.push(`✅ ${yes.map((w) => w.name).join(", ")}`);
    if (no.length) out.push(`✖️ ${no.map((w) => w.name).join(", ")}`);
    if (pending.length) out.push(`⏳ ${pending.map((w) => w.name).join(", ")}`);
  }
  out.push("", "_배정은 자동으로 확정되지 않아요 — 보고 직접 정해주세요._");
  return out.join("\n");
}
