# APM 디스패처 봇 (T3 — 빌드 0)

박재상 개인 업무 총괄 에이전트의 **슬랙 소환 리스너 + 브레인**. 슬랙 DM/멘션으로 명령 → Claude Agent SDK가 응답.

- **리스너**: `@slack/bolt` Socket Mode (public URL 불필요)
- **브레인**: `@anthropic-ai/claude-agent-sdk` `query()`
- **위치**: botV2 repo 밖 (푸쉬 위험 회피)

## 빌드 0 범위

본인(`DISPATCHER_USER_ID`) DM/멘션만 처리 → 즉시 "처리 중" ack → 브레인 응답을 thread에 회신. **도구 0개, 가역성 게이트(canUseTool) 없음** — 소켓·토큰·권한·브레인 왕복만 검증.

`ANTHROPIC_API_KEY`가 없으면 **에코 모드**로 동작(소켓 연결만 검증). 키 채우면 자동으로 `query()` 활성화.

## 슬랙 앱 설정 (기존 개인비서봇 앱 재사용)

Event Subscriptions가 꺼져 있어 토큰 재사용 안전. api.slack.com/apps → 앱 선택:

1. **Socket Mode** → 토글 ON
2. **Basic Information → App-Level Tokens → Generate** → scope `connections:write` → `xapp-` 토큰 → `SLACK_APP_TOKEN`
3. **Event Subscriptions** → ON (Socket Mode라 Request URL 불필요) → *Subscribe to bot events*: `message.im`, `app_mention`
4. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `im:history`, `app_mentions:read` (필요 시 `im:write`) → 스코프 추가 후 **Reinstall**
5. **App Home** → *Messages Tab* 활성 + "메시지 보내기 허용" 체크 (DM 수신용)

## 실행

```bash
cp .env.example .env   # 값 채우기
npm install
npm start
```

`🤖 디스패처 가동 — 브레인 OFF (에코 모드)` 가 뜨면 봇에게 DM → "처리 중" 후 에코가 오면 소켓 OK.

## 다음 단계 (빌드 0 검증 후)

1. `ANTHROPIC_API_KEY` 채워 브레인 ON
2. 모듈 툴 1개 추가: `tool()` + `createSdkMcpServer()` → `options.mcpServers` (예: `call_n8n_webhook` = 납품 이관 webhook)
3. `options.canUseTool` 게이트: 비가역·고객발송 = 슬랙 확인 후 / 가역 = 자동
4. 모델 라우팅: 들어온 메시지 난이도로 model 선택 (Sonnet 기본 / Opus 어려움 / Haiku 분류)
