import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 로컬 전용 .env 로드(dotenv 미설치라 직접 파싱 — 이 폴더 밖으로 안 나감)
const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const EMAIL = env.KUAIKAN_LOGIN_EMAIL;
const PASSWORD = env.KUAIKAN_LOGIN_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('.env에 KUAIKAN_LOGIN_EMAIL/PASSWORD 없음');

console.log('브라우저 여는 중...');
const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();

await page.goto('https://pan.kuaikanmanhua.com/login', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1500);

// 이메일 탭 첫 번째 input(이메일)/두 번째 input(비밀번호)에 입력
const inputs = await page.$$('input');
await inputs[0].fill(EMAIL);
await inputs[1].fill(PASSWORD);
console.log('ID/PW 입력 완료. 로그인 버튼 클릭...');

const loginButtons = await page.$$('button.login-btn, .el-button.login-btn');
await loginButtons[0].click();

console.log('\n캡차가 뜨면 화면에서 직접 풀어줘 — 로그인 성공까지 최대 5분 대기할게.\n');

// 로그인 성공 판정: URL이 /login 을 벗어나거나, 로그인 폼이 사라지면 성공으로 간주
const deadline = Date.now() + 5 * 60 * 1000;
let success = false;
while (Date.now() < deadline) {
  const url = page.url();
  if (!url.includes('/login')) { success = true; break; }
  await page.waitForTimeout(2000);
}

if (!success) {
  console.log('5분 내 로그인 완료를 감지 못 했어. 브라우저 창은 열어둘게 — 직접 확인해줘.');
  process.exit(1);
}

console.log('로그인 성공 감지:', page.url());
await page.waitForTimeout(1500);

const cookies = await context.cookies();
const relevant = cookies.filter(c => /kuaikanmanhua\.com$/.test(c.domain.replace(/^\./, '')));
const cookieStr = relevant.map(c => `${c.name}=${c.value}`).join('; ');

console.log('\n=== 추출된 쿠키 (' + relevant.length + '개) ===');
console.log(relevant.map(c => c.name).join(', '));

fs.writeFileSync(path.join(__dirname, 'new-cookie.txt'), cookieStr, 'utf8');
console.log('\nnew-cookie.txt 에 저장 완료 (로컬 전용, git 추적 안 됨).');

await browser.close();
