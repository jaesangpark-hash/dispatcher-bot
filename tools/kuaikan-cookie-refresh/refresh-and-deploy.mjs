// Kuaikan 세션 쿠키 만료 시 실행하는 원커맨드 갱신 스크립트.
// 1) 브라우저 자동 로그인(ID/PW 자동입력, 캡차만 사람이 풀기)
// 2) 쿠키 추출 + 실제 API로 유효성 검증
// 3) EC2 dispatcher-bot .env 갱신 + 재기동까지 자동
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SSH_KEY = path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'toonsigi_ec2');
const EC2_HOST = 'ubuntu@54.180.120.83';
const EC2_ENV_PATH = '/home/dispatcher/app/.env';

function log(msg) { console.log(`\n[${new Date().toLocaleTimeString('ko-KR')}] ${msg}`); }

function loadLocalEnv() {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  const env = {};
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function ssh(cmd) {
  return execFileSync('ssh', ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', EC2_HOST, cmd], { encoding: 'utf8' });
}

async function loginAndExtractCookie(email, password) {
  log('브라우저 여는 중...');
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  await page.goto('https://pan.kuaikanmanhua.com/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  const inputs = await page.$$('input');
  await inputs[0].fill(email);
  await inputs[1].fill(password);
  log('ID/PW 입력 완료. 로그인 버튼 클릭...');

  const loginButtons = await page.$$('button.login-btn, .el-button.login-btn');
  await loginButtons[0].click();

  log('캡차가 뜨면 화면에서 직접 풀어줘 — 로그인 성공까지 최대 5분 대기.');

  const deadline = Date.now() + 5 * 60 * 1000;
  let success = false;
  while (Date.now() < deadline) {
    if (!page.url().includes('/login')) { success = true; break; }
    await page.waitForTimeout(2000);
  }

  if (!success) {
    log('5분 내 로그인 완료를 감지 못 했어. 브라우저는 열어둘게 — 직접 확인 후 다시 실행해줘.');
    process.exit(1);
  }

  log(`로그인 성공: ${page.url()}`);
  await page.waitForTimeout(1500);
  const cookies = await context.cookies();
  await browser.close();

  const relevant = cookies.filter(c => /kuaikanmanhua\.com$/.test(c.domain.replace(/^\./, '')));
  return relevant.map(c => `${c.name}=${c.value}`).join('; ');
}

async function verifyCookie(cookie) {
  log('새 쿠키로 실제 API 검증 중...');
  const r = await fetch('https://pan.kuaikanmanhua.com/v1/kkftp/entry/list/new?id=0&page=1&limit=1', {
    headers: { accept: 'application/json, text/plain, */*', cookie, language: 'korean', logintype: 'web', systemtype: 'web' },
  });
  if (!r.ok) throw new Error(`검증 실패: HTTP ${r.status}`);
  const j = await r.json();
  if (j.code !== 200) throw new Error(`검증 실패: code=${j.code}`);
  log('검증 성공 — 쿠키 정상 동작 확인.');
}

async function deployToEc2(cookie) {
  log('EC2 .env 갱신 중...');
  // 쿠키에 |, ", $, ` 등 셸 특수문자가 없다는 전제(세미콜론/등호만 있는 표준 쿠키 형식) — sed 구분자는 | 사용.
  const escaped = cookie.replace(/\|/g, '\\|');
  ssh(`sudo sed -i "s|^KUAIKAN_SESSION_COOKIE=.*|KUAIKAN_SESSION_COOKIE=${escaped}|" ${EC2_ENV_PATH}`);
  log('dispatcher-bot 재기동 중...');
  ssh('sudo systemctl restart dispatcher-bot');
  await new Promise(r => setTimeout(r, 3000));
  const status = ssh('sudo systemctl is-active dispatcher-bot').trim();
  log(`재기동 상태: ${status}`);
  if (status !== 'active') throw new Error('재기동 후 active 상태가 아님 — 로그 직접 확인 필요');
}

async function main() {
  const env = loadLocalEnv();
  const email = env.KUAIKAN_LOGIN_EMAIL;
  const password = env.KUAIKAN_LOGIN_PASSWORD;
  if (!email || !password) throw new Error('.env에 KUAIKAN_LOGIN_EMAIL/PASSWORD 없음');

  const cookie = await loginAndExtractCookie(email, password);
  await verifyCookie(cookie);
  await deployToEc2(cookie);

  log('✅ 전체 완료 — Kuaikan 세션 갱신 + EC2 반영 + 재기동까지 끝났어.');
}

main().catch(e => { console.error('\n실패:', e.message); process.exit(1); });
