import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://pan.kuaikanmanhua.com/', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);

const inputs = await page.$$eval('input', els => els.map(e => ({
  type: e.type, name: e.name, id: e.id, placeholder: e.placeholder, class: e.className,
})));
console.log('INPUTS:', JSON.stringify(inputs, null, 2));

const buttons = await page.$$eval('button, [role=button], .btn, .el-button', els => els.map(e => ({
  text: e.innerText?.trim().slice(0, 40), class: e.className,
})));
console.log('BUTTONS:', JSON.stringify(buttons, null, 2));

console.log('URL:', page.url());
const html = await page.content();
fs.writeFileSync('login-page-dump.html', html);
console.log('saved HTML, length', html.length);

await browser.close();
