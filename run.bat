@echo off
rem 디스패처 봇 실행 래퍼 — 자기 폴더로 이동 후 node 실행, 크래시 시 5초 뒤 재시작
cd /d "%~dp0"
if not exist logs mkdir logs
rem 봇 전용 Claude 자격증명 저장소 — 인터랙티브 Claude Code(~/.claude)와 분리해
rem OAuth 토큰 갱신이 서로의 credentials.json을 덮어쓰는 401 핑퐁을 차단.
set "CLAUDE_CONFIG_DIR=%~dp0.claude-config"
if not exist ".claude-config" mkdir ".claude-config"
:loop
"C:\Program Files\nodejs\node.exe" src\app.js >> logs\bot.log 2>&1
ping -n 6 127.0.0.1 >nul
goto loop
