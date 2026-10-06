import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const projectRoot = path.resolve(process.env.OVERLAY_APP_ROOT || '/app');
const publicRoot = path.join(projectRoot, 'public');
const puppeteerEntry = path.join(projectRoot, 'node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer.js');
const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)).default;
const types = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.ttf': 'font/ttf', '.html': 'text/html' };
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>设置</title>
<script type="module">import {tr} from "/js/i18n/i18n.js"; window.tr=tr;</script></head>
<body><div id="text">设置</div><div id="rich">加入同盟</div><div id="new-ui">观战席</div><span id="new-pattern">导入失败：无法识别的格式</span><input id="input" value="设置">
<div id="skip" data-i18n-skip>设置</div><span id="attr" title="设置"></span></body></html>`;

test('real browser translates live DOM, preserves skipped values, and loads Nanum Gothic', async t => {
  const dictionaryRequests = [];
  const fontRequests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/__i18n_test__.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pageHtml);
      return;
    }
    const file = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const extension = path.extname(file);
    const charset = extension === '.js' || extension === '.json' ? '; charset=utf-8' : '';
    response.writeHead(200, { 'Content-Type': `${types[extension] || 'application/octet-stream'}${charset}` });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('sp.pref.lang', 'ko'); } catch {} });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/i18n/ko/')) {
      assert.match(url, /[?&]v=[a-f0-9]{16}/);
      dictionaryRequests.push(url);
    }
    if (url.includes('/fonts/nanum-gothic/')) fontRequests.push(url);
    request.continue();
  });

  await page.goto(`http://127.0.0.1:${server.address().port}/__i18n_test__.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.documentElement.lang === 'ko' && document.querySelector('#text')?.textContent === '설정' && typeof window.tr === 'function');
  await page.evaluate(() => document.fonts.load('16px "Nanum Gothic"', '한글'));
  const initial = await page.evaluate(() => ({
    title: document.title,
    rich: document.querySelector('#rich').textContent,
    input: document.querySelector('#input').value,
    skip: document.querySelector('#skip').textContent,
    attr: document.querySelector('#attr').title,
    direct: window.tr('选择模拟协议'),
    newUi: document.querySelector('#new-ui').textContent,
    newPattern: document.querySelector('#new-pattern').textContent,
    nestedPattern: window.tr('导入失败：无法识别的格式'),
    importCount: window.tr('已导入 3 名干员（另有 2 项未导入）'),
    roomCode: window.tr('没有找到密钥 AB12CD 对应的同盟：请和房主核对密钥（同盟结束后密钥即失效）'),
    funds: window.tr('还有 120 资金未使用。休整期结束时，本回合的剩余资金将清零。确定准备就绪吗？'),
    font: document.fonts.check('16px "Nanum Gothic"', '한글'),
    family: getComputedStyle(document.body).fontFamily,
  }));
  assert.equal(initial.title, '설정');
  assert.equal(initial.rich, '동맹 참가');
  assert.equal(initial.input, '设置');
  assert.equal(initial.skip, '设置');
  assert.equal(initial.attr, '설정');
  assert.equal(initial.direct, '시뮬레이션 협의 선택');
  assert.equal(initial.newUi, '관전석');
  assert.equal(initial.newPattern, '가져오기 실패: 형식을 인식할 수 없습니다.');
  assert.equal(initial.nestedPattern, '가져오기 실패: 형식을 인식할 수 없습니다.');
  assert.equal(initial.importCount, '오퍼레이터 3명을 가져왔습니다 (가져오지 못한 항목: 2개).');
  assert.equal(initial.roomCode, '코드 AB12CD에 해당하는 동맹을 찾을 수 없습니다. 방장에게 코드를 확인하세요 (동맹이 끝나면 코드가 만료됩니다).');
  assert.equal(initial.funds, '자금 120이 남아 있습니다. 정비 기간이 끝나면 이번 라운드의 잔여 자금은 사라집니다. 준비 완료할까요?');
  assert.ok(initial.font);
  assert.match(initial.family, /Nanum Gothic/);
  assert.ok(dictionaryRequests.length >= 5, `expected five versioned dictionaries; got ${dictionaryRequests.length}`);
  assert.ok(fontRequests.some(url => url.includes('NanumGothic-Regular.ttf')), 'regular font was not requested');

  await page.evaluate(() => {
    const node = document.createElement('div');
    node.id = 'dynamic';
    node.textContent = '加入同盟';
    node.title = '设置';
    document.body.append(node);
  });
  await page.waitForFunction(() => document.querySelector('#dynamic')?.textContent === '동맹 참가' && document.querySelector('#dynamic')?.title === '설정');
  assert.deepEqual(errors, []);
});
