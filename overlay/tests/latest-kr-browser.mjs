#!/usr/bin/env node
/**
 * Focused real-browser acceptance for the isolated 9f93096 + KR candidate.
 *
 * This intentionally requires a loopback base URL (use an SSH tunnel from a local
 * browser machine). It never talks to a public hostname and never creates a room.
 * The renderer page reuses the upstream /dev/game-mock.html fixture while fetching
 * every module/PNG/mesh from the candidate itself.
 *
 * Example:
 *   node overlay/tests/latest-kr-browser.mjs \
 *     --base-url http://127.0.0.1:3006 \
 *     --app-root work/latest-9f93096/upstream \
 *     --chrome "$CHROME_PATH" \
 *     --artifacts overlay/reports/latest-9f93096
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_APP_VERSION = '0.1.4';
const INVALID_ROOM_CODE = 'ZZZZ'; // four valid characters; preflight requires an empty candidate
const REQUIRED_BOARD_IMAGES = ['D', 'N', 'R', 'E', 'common', 'BG', 'wind', 'gate', 'waterN', 'caustics', 'noise'];
const REQUIRED_BOARD_MESHES = ['crate', 'blower', 'bgPlane'];
const REQUIRED_GATE_MESHES = ['startDown', 'startUp', 'endDown', 'endUp'];
const VOICE_SELECTOR = '[data-testid="voice-language"], select[name="voiceLanguage"], select[data-voice-language]';
const VOICE_CASES = ['krAvailable', 'krMissingJaAvailable', 'jaSelected', 'bothMissing'];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--require-voice-locales') { opts.requireVoiceLocales = true; continue; }
    if (!['--base-url', '--app-root', '--chrome', '--artifacts', '--voice-fixture'].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    opts[arg.slice(2)] = value;
  }
  for (const key of ['base-url', 'app-root', 'artifacts']) {
    if (!opts[key]) throw new Error(`Required argument missing: --${key}`);
  }
  opts.chrome ||= process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!opts.chrome) throw new Error('Pass --chrome or set CHROME_PATH to an installed Chrome/Chromium executable');
  return opts;
}

function loopbackBase(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('--base-url must be an absolute loopback URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--base-url must be a credential-free http:// loopback origin; use an SSH tunnel, not a public canary');
  }
  return url;
}

function browserEntry(appRoot) {
  const candidates = [
    path.join(appRoot, 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'puppeteer.js'),
    path.join(appRoot, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js'),
  ];
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  if (!entry) {
    throw new Error(`puppeteer-core is missing under --app-root: ${path.join(appRoot, 'node_modules', 'puppeteer-core')}`);
  }
  return pathToFileURL(entry).href;
}

function assertCheck(ok, message) {
  assert.ok(ok, message);
}

function tracePage(page, label, origin) {
  const trace = { label, requests: [], responses: [], failed: [], pageErrors: [], consoleErrors: [] };
  const safeRequest = (request) => {
    let url;
    try { url = new URL(request.url()); } catch { return null; }
    return {
      origin: url.origin,
      path: url.pathname,
      queryVersion: url.searchParams.get('v') || undefined,
      method: request.method(),
      resourceType: request.resourceType(),
      sameOrigin: url.origin === origin,
    };
  };
  page.on('request', (request) => {
    const record = safeRequest(request);
    if (record) trace.requests.push(record);
  });
  page.on('response', (response) => {
    const record = safeRequest(response.request());
    if (!record) return;
    const headers = response.headers();
    trace.responses.push({
      ...record,
      status: response.status(),
      contentType: headers['content-type'] || '',
      bytes: Number(headers['content-length'] || 0),
    });
  });
  page.on('requestfailed', (request) => {
    const record = safeRequest(request);
    if (!record) return;
    trace.failed.push({ ...record, reason: request.failure()?.errorText || 'request failed' });
  });
  page.on('pageerror', (error) => trace.pageErrors.push(String(error?.message || error)));
  page.on('console', (message) => {
    if (message.type() === 'error') trace.consoleErrors.push(message.text());
  });
  return trace;
}

async function fetchHealth(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(new URL('/healthz', base), { signal: controller.signal });
    assert.equal(response.status, 200, 'candidate /healthz must return HTTP 200');
    const health = await response.json();
    assert.equal(health.ok, true, 'candidate /healthz must be healthy');
    assert.equal(health.app, EXPECTED_APP_VERSION, 'candidate app version must be 0.1.4');
    return health;
  } finally {
    clearTimeout(timer);
  }
}

function assertIdle(health, where, { expectedSessions, maxSessions } = {}) {
  for (const key of ['rooms', 'matches', 'humans', 'sockets']) {
    if (typeof health[key] === 'number') assert.equal(health[key], 0, `${where}: candidate ${key} must be zero`);
  }
  if (typeof health.sessions === 'number') {
    if (Number.isInteger(expectedSessions)) assert.equal(health.sessions, expectedSessions, `${where}: candidate sessions must be ${expectedSessions}`);
    else if (Number.isInteger(maxSessions)) assert.ok(health.sessions <= maxSessions, `${where}: candidate disconnected sessions must be at most ${maxSessions}`);
    else assert.equal(health.sessions, 0, `${where}: candidate sessions must be zero`);
  }
}

function sameOriginResponses(traces) {
  return traces.flatMap((trace) => trace.responses.filter((r) => r.sameOrigin));
}

function checkRequiredResponse(responses, pathname, label) {
  // URL.pathname preserves literal brackets, while the browser trace reports their percent-encoded form.
  const comparablePath = (value) => value.replace(/%5b/ig, '[').replace(/%5d/ig, ']');
  const expectedPath = comparablePath(pathname);
  const hits = responses.filter((response) => comparablePath(response.path) === expectedPath && response.status >= 200 && response.status < 300);
  assertCheck(hits.length > 0, `${label}: candidate did not return a successful ${pathname} response`);
  return hits;
}

function normalizeVoiceLocale(value) {
  if (/^ko(?:[-_].*)?$/i.test(String(value || ''))) return 'ko';
  if (/^ja(?:[-_].*)?$/i.test(String(value || ''))) return 'ja';
  return null;
}

async function voiceSelectorSnapshot(page) {
  return page.evaluate((selector) => {
    const control = document.querySelector(selector);
    if (!(control instanceof HTMLSelectElement)) return null;
    let settings = {};
    try { settings = JSON.parse(localStorage.getItem('sp.pref.settings') || '{}'); } catch { /* malformed old preference */ }
    return {
      options: [...control.options].map((option) => ({ value: option.value, label: option.textContent.trim() })),
      selectedValue: control.value,
      uiPreference: localStorage.getItem('sp.pref.lang'),
      voicePreference: settings.voiceLanguage,
      uiLanguage: document.documentElement.lang,
    };
  }, VOICE_SELECTOR);
}

async function selectVoiceLocale(page, locale) {
  await page.$eval(VOICE_SELECTOR, (control, wanted) => {
    const option = [...control.options].find((item) => {
      const value = item.value.toLowerCase();
      const label = item.textContent;
      return wanted === 'ko'
        ? /한국어/.test(label) || /^ko(?:[-_]|$)/i.test(value)
        : /日本語/.test(label) || /^ja(?:[-_]|$)/i.test(value);
    });
    if (!option) throw new Error(`voice-language dropdown lacks the ${wanted} option`);
    control.value = option.value;
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }, locale);
  await page.waitForFunction((wanted) => {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('sp.pref.settings') || '{}').voiceLanguage; } catch { /* malformed old preference */ }
    const norm = (value) => /^ko(?:[-_].*)?$/i.test(value || '') ? 'ko' : /^ja(?:[-_].*)?$/i.test(value || '') ? 'ja' : null;
    return norm(stored) === wanted;
  }, { timeout: 8000 }, locale);
}

async function reopenTitleSettings(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.title-screen .title-settings', { visible: true, timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.lang === 'ko', { timeout: 20000 });
  await page.click('.title-screen .title-settings');
  await page.waitForSelector(VOICE_SELECTOR, { visible: true, timeout: 10000 });
}

async function checkVoiceSelectorPersistence(page, report, required) {
  const initial = await voiceSelectorSnapshot(page);
  if (!initial) {
    report.voiceLocaleAcceptance = {
      status: 'pending',
      reason: 'voice-language dropdown is absent from the candidate build',
      selectorContract: VOICE_SELECTOR,
      storageKey: 'sp.pref.settings.voiceLanguage',
    };
    if (required) throw new Error('required voice-language dropdown is absent');
    return;
  }
  const koOption = initial.options.find((option) => /한국어/.test(option.label) || normalizeVoiceLocale(option.value) === 'ko');
  const jaOption = initial.options.find((option) => /日本語/.test(option.label) || normalizeVoiceLocale(option.value) === 'ja');
  assertCheck(!!koOption && /한국어/.test(koOption.label), 'voice-language selector must visibly offer 한국어');
  assertCheck(!!jaOption && /日本語/.test(jaOption.label), 'voice-language selector must visibly offer 日本語');

  await selectVoiceLocale(page, 'ko');
  let persisted = await voiceSelectorSnapshot(page);
  assert.equal(normalizeVoiceLocale(persisted.voicePreference), 'ko', 'Korean voice selection must persist independently');
  assert.equal(persisted.uiPreference, 'ko', 'selecting a voice must not change the UI language preference');
  await reopenTitleSettings(page);
  persisted = await voiceSelectorSnapshot(page);
  assert.equal(normalizeVoiceLocale(persisted.selectedValue), 'ko', 'Korean voice selection must survive reload');

  await selectVoiceLocale(page, 'ja');
  persisted = await voiceSelectorSnapshot(page);
  assert.equal(normalizeVoiceLocale(persisted.voicePreference), 'ja', 'Japanese voice selection must persist independently');
  assert.equal(persisted.uiPreference, 'ko', 'Japanese voice selection must leave Korean UI preference unchanged');
  await reopenTitleSettings(page);
  persisted = await voiceSelectorSnapshot(page);
  assert.equal(normalizeVoiceLocale(persisted.selectedValue), 'ja', 'Japanese voice selection must survive reload');
  assert.equal(persisted.uiLanguage, 'ko', 'UI must remain Korean while Japanese voices are selected');

  report.checks.voiceSelectorPersistence = {
    status: 'passed',
    selector: VOICE_SELECTOR,
    storageKey: 'sp.pref.settings.voiceLanguage',
    uiStorageKey: 'sp.pref.lang',
    options: { ko: koOption.label, ja: jaOption.label },
    tested: ['KR select → reload persisted', 'JA select → reload persisted', 'UI stayed KO throughout'],
  };
  report.voiceLocaleAcceptance = {
    status: 'selector-persistence-passed-url-resolution-pending',
    reason: 'pass --voice-fixture after B publishes voice inventory to exercise real sound URL resolution',
  };
  if (required && !report.voiceFixture) throw new Error('--require-voice-locales requires --voice-fixture for actual URL-resolution cases');
}

function validateVoiceFixture(fixture, base) {
  assertCheck(fixture && typeof fixture === 'object' && fixture.cases, 'voice fixture must contain a cases object');
  for (const name of VOICE_CASES) {
    const item = fixture.cases[name];
    assertCheck(item && typeof item.characterId === 'string' && item.characterId, `voice fixture missing ${name}.characterId`);
    assertCheck(typeof item.cue === 'string' && item.cue, `voice fixture missing ${name}.cue`);
    assertCheck(item.slot === undefined || (typeof item.slot === 'string' && item.slot), `voice fixture has an invalid ${name}.slot`);
    assertCheck(item.lineIndex === undefined || (Number.isInteger(item.lineIndex) && item.lineIndex >= 0), `voice fixture has an invalid ${name}.lineIndex`);
    assertCheck(item.available && typeof item.available.ko === 'boolean' && typeof item.available.ja === 'boolean', `voice fixture missing ${name}.available.ko/ja`);
  }
  const cases = fixture.cases;
  assert.equal(cases.krAvailable.available.ko, true, 'krAvailable must have a Korean payload');
  assert.equal(cases.krAvailable.available.ja, true, 'krAvailable fixture should include both locale payloads');
  assert.equal(cases.krMissingJaAvailable.available.ko, false, 'fallback case must have no Korean payload');
  assert.equal(cases.krMissingJaAvailable.available.ja, true, 'fallback case must have a Japanese payload');
  assert.equal(cases.jaSelected.available.ja, true, 'Japanese-selected case must have a Japanese payload');
  assert.equal(cases.bothMissing.available.ko, false, 'silent case must have no Korean payload');
  assert.equal(cases.bothMissing.available.ja, false, 'silent case must have no Japanese payload');
  assert.equal(cases.krMissingJaAvailable.characterId, cases.jaSelected.characterId, 'KR-missing fallback and JA-selected cases must use the same character');
  assert.equal(cases.krMissingJaAvailable.cue, cases.jaSelected.cue, 'KR-missing fallback and JA-selected cases must use the same cue');
  assert.equal(cases.krMissingJaAvailable.slot || 'start', cases.jaSelected.slot || 'start', 'fallback and JA-selected cases must use the same slot');
  assert.equal(cases.krMissingJaAvailable.lineIndex ?? 0, cases.jaSelected.lineIndex ?? 0, 'fallback and JA-selected cases must use the same cue index');
  assertCheck(typeof cases.krAvailable.expectedUrl === 'string', 'krAvailable needs its exact expected sound URL');
  assertCheck(typeof cases.krMissingJaAvailable.expectedUrl === 'string', 'KR-missing fallback needs its exact expected JA URL');
  assert.equal(cases.krMissingJaAvailable.expectedUrl, cases.jaSelected.expectedUrl, 'fallback and JA selection must resolve to the same Japanese URL');
  assertCheck(typeof cases.jaSelected.expectedUrl === 'string', 'jaSelected needs its exact expected sound URL');
  assert.equal(cases.bothMissing.expectedUrl ?? null, null, 'bothMissing must expect safe silence');
  for (const name of VOICE_CASES) {
    const item = cases[name];
    if (item.expectedUrl == null) continue;
    const url = new URL(item.expectedUrl, base.origin);
    assert.equal(url.origin, base.origin, `${name} expected sound must resolve from the candidate origin`);
    assertCheck(/^\/assets\/audio\/voice\/(?:kr|jp)\//.test(url.pathname), `${name} must resolve only to a Korean or Japanese voice path`);
  }
}

function voiceAvailabilityForScenario(original, scenario) {
  const availability = structuredClone(original);
  const slot = scenario.slot || 'start';
  const index = Number.isInteger(scenario.lineIndex) ? scenario.lineIndex : 0;
  const originalLine = original?.characters?.[scenario.characterId]?.[slot]?.find((item) => item?.index === index);
  const line = availability?.characters?.[scenario.characterId]?.[slot]?.find((item) => item?.index === index);
  assertCheck(!!originalLine && !!line, `voice fixture line is absent from candidate availability: ${scenario.characterId}/${slot}/${index}`);

  const expectedLanguage = scenario.expectedUrl === originalLine.kr?.url ? 'ko'
    : scenario.expectedUrl === originalLine.ja?.url ? 'ja' : scenario.expectedUrl == null ? null : undefined;
  if (scenario.expectedUrl != null) {
    assertCheck(expectedLanguage !== undefined, `${scenario.cue}: expected URL is not a staged Korean or Japanese payload`);
    assert.equal(originalLine[expectedLanguage === 'ko' ? 'kr' : 'ja']?.available, true,
      `${scenario.cue}: expected ${expectedLanguage} payload must exist in the candidate release`);
  }

  const overrides = {};
  for (const [locale, key] of [['ko', 'kr'], ['ja', 'ja']]) {
    if (scenario.available[locale]) {
      assert.equal(originalLine[key]?.available, true,
        `${scenario.cue}: fixture claims an unavailable ${locale} payload is real`);
      overrides[key] = false;
    } else {
      overrides[key] = originalLine[key]?.available === true;
      line[key] = { ...(line[key] || {}), available: false };
    }
  }
  return { availability, overrides };
}

function expectedMediaPath(raw, origin) {
  const url = new URL(raw, origin);
  const audio = /^\/assets\/audio\/(.+)$/i.exec(url.pathname);
  const suffix = /\.(?:mp3|ogg|wav|m4a|aac|flac)$/i;
  if (audio && suffix.test(audio[1])) return `/media/${audio[1].replace(suffix, '')}`;
  return url.pathname;
}

async function waitForTrace(trace, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runVoiceUrlCases(browser, base, report, fixture) {
  validateVoiceFixture(fixture, base);
  const availabilityResponse = await fetch(new URL('/data/voice-availability.json', base.origin));
  assert.equal(availabilityResponse.status, 200, 'candidate voice-availability document must return HTTP 200');
  const originalAvailability = await availabilityResponse.json();
  const results = {};
  const selectedLocale = { krAvailable: 'ko', krMissingJaAvailable: 'ko', jaSelected: 'ja', bothMissing: 'ko' };
  for (const caseName of VOICE_CASES) {
    const scenario = fixture.cases[caseName];
    const { availability: scenarioAvailability, overrides } = voiceAvailabilityForScenario(originalAvailability, scenario);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      let url;
      try { url = new URL(request.url()); } catch { url = null; }
      const action = url?.origin === base.origin && url.pathname === '/data/voice-availability.json'
        ? request.respond({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(scenarioAvailability) })
        : request.continue();
      action.catch(() => {});
    });
    const trace = tracePage(page, `voice-${caseName}`, base.origin);
    report.traces.push(trace);
    await page.evaluateOnNewDocument((locale) => {
      localStorage.setItem('sp.pref.lang', 'ko');
      localStorage.setItem('sp.pref.settings', JSON.stringify({ bgm: 0, sfx: 0, voice: 1, voiceLanguage: locale, muted: false, damageNumbers: true, quality: 'high' }));
    }, selectedLocale[caseName]);
    const url = new URL('/dev/game-mock.html', base.origin);
    url.searchParams.set('phase', 'PREP');
    url.searchParams.set('shot', '1');
    url.searchParams.set('render', 'fallback');
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    assert.equal(response?.status(), 200, `${caseName}: candidate audio fixture must return HTTP 200`);
    await page.waitForFunction(() => !!globalThis.__MOCK__, { timeout: 30000 });
    await page.mouse.click(24, 24); // real browser gesture unlocks the app's Web Audio context
    const started = await page.evaluate(async ({ characterId, cue, cueName, lineIndex, locale }) => {
      const { audio, installAudio } = await import('/js/audio.js');
      const { data } = await import('/js/data.js');
      const { updateSettings } = await import('/js/ui/settings.js');
      updateSettings({ voiceLanguage: locale });
      await data.loadAll(['assets', 'voiceAvailability']);
      // The upstream dev/game-mock fixture wires the manifest but not this overlay-owned availability source.
      // Attach the candidate's real staged document to the same production resolver before calling audio.voice().
      installAudio({ getVoiceAvailability: () => data.get('voiceAvailability') });
      const line = data.get('assets')?.audio?.voice?.[characterId]?.[cue];
      const cn = Array.isArray(line) ? line : [line];
      const { mediaUrl } = await import('/js/media.js');
      const forbiddenCnRequests = cn.filter((value) => typeof value === 'string' && value).map((value) => mediaUrl(value));
      const index = Number.isInteger(lineIndex) ? lineIndex : 0;
      const stagedLine = data.get('voiceAvailability')?.characters?.[characterId]?.[cue]?.find((item) => item?.index === index);
      if (stagedLine?.cue !== cueName) throw new Error('voice fixture cue does not match staged availability index');
      const played = audio.voice(characterId, cue, { unitKey: `acceptance-${Date.now()}`, lineIndex: index });
      return { played, contextState: audio.ctx?.state || null, forbiddenCnRequests };
    }, { characterId: scenario.characterId, cue: scenario.slot || 'start', cueName: scenario.cue, lineIndex: scenario.lineIndex, locale: selectedLocale[caseName] });
    assert.equal(started.contextState, 'running', `${caseName}: browser Web Audio context did not unlock`);
    assertCheck(started.forbiddenCnRequests.length > 0, `${caseName}: latest upstream CN voice baseline could not be inspected`);
    const expectedPath = scenario.expectedUrl == null ? null : expectedMediaPath(scenario.expectedUrl, base.origin);
    const forbiddenPaths = new Set(started.forbiddenCnRequests.map((item) => expectedMediaPath(item, base.origin)));
    if (caseName === 'bothMissing') {
      assert.equal(started.played, false, 'when both JA and KR are absent the voice call must be safely silent');
      await new Promise((resolve) => setTimeout(resolve, 800));
      assertCheck(!trace.requests.some((request) => forbiddenPaths.has(request.path)), 'both-missing voice case requested the forbidden CN fallback');
      assertCheck(!trace.requests.some((request) => (request.path.startsWith('/media/voice/') || request.path.startsWith('/assets/audio/voice/'))
        && request.resourceType === 'fetch'), 'both-missing voice case requested a voice URL despite no JA/KR payload');
      results[caseName] = { selectedLocale: selectedLocale[caseName], played: false, requestedSoundUrls: [], forbiddenCnFallback: false, syntheticAvailabilityOverrides: overrides };
    } else {
      assert.equal(started.played, true, `${caseName}: expected locale payload should start a voice request`);
      await waitForTrace(trace, () => trace.requests.some((request) => request.path === expectedPath));
      const requested = trace.requests.filter((request) => request.path === expectedPath);
      assertCheck(requested.length > 0, `${caseName}: expected localized sound URL was not requested`);
      assertCheck(!trace.requests.some((request) => forbiddenPaths.has(request.path)), `${caseName}: resolver requested the forbidden upstream CN voice URL`);
      const responseRecord = trace.responses.find((item) => item.path === expectedPath);
      assertCheck(!!responseRecord && responseRecord.status >= 200 && responseRecord.status < 300, `${caseName}: localized sound response was not successful`);
      assertCheck(!/text\/html/i.test(responseRecord.contentType), `${caseName}: localized sound URL returned HTML instead of audio`);
      results[caseName] = {
        selectedLocale: selectedLocale[caseName],
        expectedLocale: caseName === 'krAvailable' ? 'ko' : caseName === 'bothMissing' ? null : 'ja',
        played: true,
        requestedSoundUrls: requested.map((request) => request.path),
        response: { status: responseRecord.status, contentType: responseRecord.contentType, bytes: responseRecord.bytes },
        forbiddenCnFallback: false,
        syntheticAvailabilityOverrides: overrides,
      };
    }
    await page.close();
  }
  report.checks.voiceUrlResolution = results;
  report.voiceLocaleAcceptance = { status: 'passed', contract: 'independent persisted selector + JA/KR resolver; no CN fallback' };
}

async function openTitleSmoke(browser, base, report, options) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  report.traces.push(tracePage(page, 'title-settings-and-spectator', base.origin));
  const trace = report.traces.at(-1);
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('sp.pref.lang', 'ko'); } catch { /* browser storage may be disabled */ }
  });
  const response = await page.goto(base.origin + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  assert.equal(response?.status(), 200, 'candidate title route must return HTTP 200');
  await page.waitForSelector('.title-screen .title-settings', { visible: true, timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.lang === 'ko', { timeout: 20000 });

  await page.click('.title-screen .title-settings');
  await page.waitForFunction(() => [...document.querySelectorAll('.set-row')].some((row) => {
    const micro = row.querySelector('.set-row__label');
    return micro?.textContent?.includes('VOICE') && !!row.querySelector('input.set-range[type="range"]');
  }), { timeout: 15000 });
  const settings = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.set-row')];
    const voice = rows.find((row) => row.querySelector('.set-row__label')?.textContent?.includes('VOICE'));
    const title = document.querySelector('[role="dialog"] h1, [role="dialog"] h2, .modal__title, .modal-title')?.textContent?.trim() || '';
    return {
      documentTitle: document.title,
      documentLang: document.documentElement.lang,
      voiceLabel: voice?.querySelector('.set-row__label')?.textContent?.trim() || '',
      voiceRange: voice?.querySelector('input.set-range[type="range"]')?.getAttribute('type') || null,
      voiceValue: voice?.querySelector('input.set-range')?.value || null,
      modalTitle: title,
      koreanVisible: /[\uac00-\ud7a3]/.test(document.body.innerText),
    };
  });
  assert.equal(settings.documentLang, 'ko', 'title settings must use Korean language preference');
  assertCheck(settings.koreanVisible, 'title settings did not render Korean text');
  assert.equal(settings.voiceRange, 'range', 'voice slider is missing');
  assertCheck(settings.voiceLabel.includes('VOICE'), 'voice row identity is missing');
  await checkVoiceSelectorPersistence(page, report, !!options.requireVoiceLocales);
  await page.screenshot({ path: path.join(report.artifacts, 'title-settings.png'), fullPage: true });
  report.checks.titleSettings = settings;

  const dictionaries = trace.responses.filter((r) => r.sameOrigin && r.path.startsWith('/i18n/ko/') && /\.json$/i.test(r.path) && r.status === 200);
  assertCheck(dictionaries.length >= 5, `expected five or more Korean dictionary responses; got ${dictionaries.length}`);
  for (const responseRecord of dictionaries) {
    assertCheck(/^[a-f0-9]{16}$/.test(responseRecord.queryVersion || ''), `unversioned Korean dictionary request: ${responseRecord.path}`);
  }
  assertCheck(trace.responses.some((r) => r.sameOrigin && r.path === '/i18n/ko/ko.css' && r.status >= 200 && r.status < 400), 'Korean stylesheet did not load successfully');
  checkRequiredResponse(trace.responses, '/fonts/nanum-gothic/NanumGothic-Regular.ttf', 'Korean regular font');
  const font = await page.evaluate(async () => {
    await document.fonts.load('16px "Nanum Gothic"', '한글');
    return {
      loaded: document.fonts.check('16px "Nanum Gothic"', '한글'),
      family: getComputedStyle(document.body).fontFamily,
    };
  });
  assertCheck(font.loaded, 'Nanum Gothic did not decode/load in the real browser');
  assertCheck(/Nanum Gothic/.test(font.family), 'Korean font is absent from the computed font stack');
  report.checks.korean = { dictionaryResponses: dictionaries.length, versioned: true, font };

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('input.set-range'), { timeout: 8000 });
  const nameInput = await page.$('.title-login input');
  assertCheck(!!nameInput, 'title nickname input is missing');
  await page.$eval('.title-login input', (input) => {
    input.value = 'KR Smoke';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const startButtons = await page.$$('.title-login button');
  assertCheck(startButtons.length > 0, 'title start button is missing');
  await startButtons[0].click();
  await page.waitForSelector('.lobby-screen .join-spectate', { visible: true, timeout: 30000 });

  const codeInput = await page.$('.join-panel input');
  assertCheck(!!codeInput, 'spectator test code input is missing');
  await page.$eval('.join-panel input', (input, code) => {
    input.value = code;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, INVALID_ROOM_CODE);
  await page.waitForFunction(() => {
    const button = document.querySelector('.join-spectate');
    return button && !button.disabled;
  }, { timeout: 8000 });
  await page.click('.join-spectate');
  await page.waitForFunction((code) => {
    const text = document.body.innerText;
    return text.includes(code) && /[\uac00-\ud7a3]/.test(text) && /동맹|방|코드/.test(text);
  }, { timeout: 15000 }, INVALID_ROOM_CODE);
  const spectatorToast = await page.evaluate((code) => document.body.innerText.split('\n').find((line) => line.includes(code)) || '', INVALID_ROOM_CODE);
  assertCheck(spectatorToast.includes(INVALID_ROOM_CODE), 'invalid spectator response did not include the submitted code');
  assertCheck(trace.pageErrors.length === 0, `browser page error: ${trace.pageErrors.join(' | ')}`);
  assertCheck(!trace.consoleErrors.some((text) => /ReferenceError|ERR is not defined/.test(text)), 'invalid spectator path emitted an ERR ReferenceError');
  report.checks.invalidSpectator = { code: INVALID_ROOM_CODE, toast: spectatorToast, pageErrors: trace.pageErrors.length };
  await page.close();
}

async function installSyntheticBoardFixture(page) {
  return page.evaluate(async () => {
    const { data } = await import('/js/data.js');
    const stage = data.lookup('stages', 'act2autochess_m01');
    const waterStage = data.lookup('stages', 'act2autochess_m04');
    const originiumStage = data.lookup('stages', 'act1autochess_m04');
    const crateStage = data.lookup('stages', 'act2autochess_m02');
    if (!stage || !waterStage || !originiumStage || !crateStage || !globalThis.__MOCK__) {
      throw new Error('candidate latest /dev/game-mock fixture or required stage data is missing');
    }
    const rows = stage.rows.map((row) => [...row]);
    const reserved = new Set((stage.devices || []).map((device) => Array.isArray(device.pos) ? device.pos.join(',') : ''));
    const used = new Set();
    const candidates = [[10, 5], [11, 5], [10, 6], [11, 6], [9, 5], [12, 5], [10, 4], [11, 4], [9, 4], [12, 4]];
    const place = (glyph) => {
      for (const [r, c] of candidates) {
        const key = `${r},${c}`;
        if (used.has(key) || reserved.has(key) || rows[r]?.[c] !== 'r') continue;
        rows[r][c] = glyph;
        used.add(key);
        return [r, c];
      }
      throw new Error(`could not place synthetic ${glyph} terrain on the visible field`);
    };
    const water = place('d');
    const originium = place('i');
    stage.rows = rows.map((row) => row.join(''));
    stage.tiles = {
      ...(stage.tiles || {}),
      d: structuredClone(waterStage.tiles?.d),
      i: structuredClone(originiumStage.tiles?.i),
    };
    if (!stage.tiles.d || !stage.tiles.i) throw new Error('source stage terrain definitions for water/originium are missing');
    const crate = (crateStage.devices || []).find((device) => device.key === 'trap_1105_accrate' && device.active);
    if (!crate) throw new Error('latest renderer fixture has no active crate device');
    stage.devices = [...(stage.devices || []), structuredClone(crate)];
    globalThis.__MOCK__.setPhase('PREP', '');
    globalThis.__MOCK__.mutate((state) => { state.priv.board = []; });
    const count = (glyph) => stage.rows.reduce((sum, row) => sum + [...row].filter((ch) => ch === glyph).length, 0);
    const features = {
      stage: 'act2autochess_m01 + candidate-local water/originium/crate fixture',
      waterAt: water,
      originiumAt: originium,
      highTiles: count('h'),
      startGates: count('S'),
      endGates: count('E'),
      windDevices: stage.devices.filter((device) => device.key === 'trap_013_blower' && device.active).length,
      crateDevices: stage.devices.filter((device) => device.key === 'trap_1105_accrate' && device.active).length,
      units: globalThis.__MOCK__.S().priv.board.length,
    };
    if (!features.highTiles || !features.startGates || !features.endGates || !features.windDevices || !features.crateDevices || features.units) {
      throw new Error('synthetic board fixture lacks a required visible feature');
    }
    return features;
  });
}

async function openBoardSmoke(browser, base, report, mode) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const trace = tracePage(page, `renderer-${mode}`, base.origin);
  report.traces.push(trace);
  const url = new URL('/dev/game-mock.html', base.origin);
  url.searchParams.set('phase', 'PREP');
  url.searchParams.set('shot', '1');
  url.searchParams.set('render', 'engine');
  url.searchParams.set('board', mode);
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
  assert.equal(response?.status(), 200, 'candidate latest renderer fixture must return HTTP 200');
  await page.waitForFunction(() => !!globalThis.__MOCK__, { timeout: 30000 });
  const fixture = await installSyntheticBoardFixture(page);
  await page.waitForFunction(() => {
    const view = globalThis.__SP_VIEW__;
    if (view?.kind !== 'engine') return false;
    try { return view.raw?.stats?.()?.boardArt === true; } catch { return false; }
  }, { timeout: 45000 });
  await page.waitForFunction((requestedMode) => {
    try {
      const s = globalThis.__SP_VIEW__?.raw?.stats?.();
      return requestedMode === '3d' ? s?.board3d?.on === true : s?.board3d?.on === false;
    } catch { return false; }
  }, { timeout: 45000 }, mode);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const renderer = await page.evaluate(async () => {
    const view = globalThis.__SP_VIEW__;
    const stats = view?.raw?.stats?.();
    const { assets } = await import('/js/assets.js');
    const { PACK_IMAGES, PACK_MESHES, loadBoardPack } = await import('/js/render/board3d/load.js');
    const manifest = await assets.local();
    const pack = await loadBoardPack(assets);
    if (!pack) throw new Error('renderer returned no real local KR board pack');
    const imageUrls = Object.fromEntries(Object.entries(PACK_IMAGES).map(([slot, [group, key]]) => [slot, assets.localUrl(group, key)]));
    const meshUrls = Object.fromEntries(Object.entries(PACK_MESHES).map(([slot, [group, key]]) => [slot, assets.localUrl(group, key)]));
    const groups = manifest?.groups || {};
    const imageStats = Object.fromEntries(Object.entries(pack.images || {}).map(([slot, image]) => [slot, {
      width: image?.naturalWidth || image?.width || 0,
      height: image?.naturalHeight || image?.height || 0,
    }]));
    return {
      viewKind: view?.kind,
      stats,
      imageUrls,
      meshUrls,
      imageStats,
      meshSlots: Object.keys(pack.meshes || {}),
      gateMeshSlots: Object.keys(pack.meshes?.gate || {}),
      gateMeshesReady: Object.fromEntries(Object.entries(pack.meshes?.gate || {}).map(([key, item]) => [key, !!item?.mesh?.positions?.length])),
      localGroups: Object.keys(groups).sort(),
      tilesVersion: pack.tiles?.version || null,
      tilesMaterialCount: Object.keys(pack.tiles?.materials || {}).length,
      materialData: {
        infection: pack.tiles?.materials?.infection || null,
        infection2: pack.tiles?.materials?.infection2 || null,
      },
    };
  });
  const screenshot = `board-${mode}.png`;
  await page.screenshot({ path: path.join(report.artifacts, screenshot), fullPage: true });
  report.checks[`renderer${mode.toUpperCase()}`] = {
    status: 'captured-validation-pending',
    fixture,
    viewKind: renderer.viewKind,
    board3d: renderer.stats.board3d,
    boardArt: renderer.stats.boardArt,
    tilesVersion: renderer.tilesVersion,
    tilesMaterialCount: renderer.tilesMaterialCount,
    meshSlots: renderer.meshSlots,
    gateMeshSlots: renderer.gateMeshSlots,
    materialDataPresent: { infection: !!renderer.materialData.infection, infection2: !!renderer.materialData.infection2 },
    screenshot,
    pageErrors: trace.pageErrors.length,
  };

  assert.equal(renderer.viewKind, 'engine', `${mode}: renderer must not silently use the DOM fallback`);
  assert.equal(renderer.stats?.boardArt, true, `${mode}: real candidate board texture atlas must be selected`);
  assert.equal(renderer.stats?.board3d?.on, mode === '3d', `${mode}: requested board mode was not honored`);

  const responses = sameOriginResponses([trace]);
  const pngChecks = [];
  for (const slot of REQUIRED_BOARD_IMAGES) {
    const urlPath = renderer.imageUrls[slot];
    assertCheck(typeof urlPath === 'string' && /\.png(?:$|\?)/i.test(urlPath), `${slot}: local KR texture must resolve to a PNG path`);
    const entryResponses = checkRequiredResponse(responses, new URL(urlPath, base.origin).pathname, `${slot} texture`);
    pngChecks.push({ slot, path: new URL(urlPath, base.origin).pathname, status: entryResponses[0].status, ...renderer.imageStats[slot] });
    assertCheck((renderer.imageStats[slot]?.width || 0) > 0 && (renderer.imageStats[slot]?.height || 0) > 0, `${slot}: browser did not decode the PNG image`);
  }
  if (mode === '3d') {
    for (const slot of REQUIRED_BOARD_MESHES) {
      const urlPath = renderer.meshUrls[slot];
      assertCheck(typeof urlPath === 'string', `${slot}: local mesh entry is absent from candidate manifest`);
      checkRequiredResponse(responses, new URL(urlPath, base.origin).pathname, `${slot} mesh`);
      assertCheck(renderer.meshSlots.includes(slot), `${slot}: renderer did not parse/select the candidate mesh`);
    }
    for (const slot of REQUIRED_GATE_MESHES) {
      assertCheck(renderer.gateMeshesReady[slot] === true, `${slot}: renderer did not parse/select the red/blue gate mesh`);
    }
    assertCheck(renderer.stats.board3d.triangles > 0, '3D board reported no rendered triangles');
  }
  assertCheck((renderer.tilesMaterialCount || 0) > 0, 'candidate board tiles/material table did not load');
  assertCheck(renderer.materialData.infection !== null && renderer.materialData.infection2 !== null, 'candidate originium material entries are missing');
  assertCheck(trace.pageErrors.length === 0, `${mode} page error: ${trace.pageErrors.join(' | ')}`);

  report.checks[`renderer${mode.toUpperCase()}`] = {
    ...report.checks[`renderer${mode.toUpperCase()}`],
    status: 'passed',
    pngChecks,
  };
  await page.close();
}

async function waitForIdle(base, expectedSessions = 0, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fetchHealth(base);
    const noActiveUse = ['rooms', 'matches', 'humans', 'sockets'].every((key) => typeof last[key] !== 'number' || last[key] === 0);
    const expectedSessionCount = typeof last.sessions !== 'number' || last.sessions === expectedSessions;
    if (noActiveUse && expectedSessionCount) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assertIdle(last || {}, 'after browser close', { expectedSessions });
  return last;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node latest-kr-browser.mjs --base-url http://127.0.0.1:3006 --app-root <latest-upstream> --chrome <Chrome-path> --artifacts <report-dir>\n');
    return 0;
  }
  const base = loopbackBase(args['base-url']);
  const appRoot = path.resolve(args['app-root']);
  const chrome = path.resolve(args.chrome);
  const artifacts = path.resolve(args.artifacts);
  assertCheck(fs.existsSync(path.join(appRoot, 'package.json')), '--app-root must be the frozen latest source tree with package.json');
  assertCheck(fs.existsSync(chrome) && fs.statSync(chrome).isFile(), '--chrome must name an installed Chrome/Chromium executable');
  const relativeArtifacts = path.relative(path.resolve(appRoot, 'public'), artifacts);
  const artifactsInsidePublic = relativeArtifacts === '' || (!path.isAbsolute(relativeArtifacts)
    && relativeArtifacts !== '..' && !relativeArtifacts.startsWith(`..${path.sep}`));
  assertCheck(!artifactsInsidePublic, 'browser evidence must not be written inside the app public tree');
  fs.mkdirSync(artifacts, { recursive: true });

  const report = {
    status: 'running',
    candidate: { base: base.origin, expectedAppVersion: EXPECTED_APP_VERSION, publicCanaryUsed: false },
    startedAt: new Date().toISOString(),
    artifacts,
    checks: {},
    traces: [],
    screenshots: [],
    limitations: [
      'The browser verifies selected audio URLs and payload responses, not subjective voice quality or listening volume.',
      'Saved screenshots still require a human visual review; this script verifies actual renderer selection, resource decode, and draw statistics.',
      'KR-missing fallback and both-missing silence cases use browser-only availability metadata overrides; the candidate asset tree and upstream CN manifest are unchanged.',
      'The title-to-lobby smoke leaves one disconnected resumable player session; sessions must increase by exactly one, while active sockets, rooms, matches, and humans stay at zero.',
    ],
  };
  let browser;
  let failure = null;
  try {
    const before = await fetchHealth(base);
    assertIdle(before, 'before browser smoke');
    report.checks.healthBefore = before;

    const { default: puppeteer } = await import(browserEntry(appRoot));
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist'],
    });
    if (args.requireVoiceLocales && !args['voice-fixture']) throw new Error('--require-voice-locales requires --voice-fixture');
    if (args['voice-fixture']) report.voiceFixture = JSON.parse(fs.readFileSync(path.resolve(args['voice-fixture']), 'utf8'));
    await openTitleSmoke(browser, base, report, args);
    if (report.voiceFixture) await runVoiceUrlCases(browser, base, report, report.voiceFixture);
    const boardFailures = [];
    for (const mode of ['2d', '3d']) {
      try { await openBoardSmoke(browser, base, report, mode); }
      catch (error) { boardFailures.push({ mode, error: String(error?.stack || error) }); }
    }
    report.boardFailures = boardFailures;
    if (boardFailures.length) throw new Error(boardFailures.map(({ mode, error }) => `${mode}: ${error}`).join('\n'));
  } catch (error) {
    failure = error;
  } finally {
    try { await browser?.close(); } catch { /* preserve original failure */ }
  }

  if (!failure) {
    try {
      const baselineSessions = Number.isInteger(report.checks.healthBefore.sessions) ? report.checks.healthBefore.sessions : 0;
      report.checks.healthAfter = await waitForIdle(base, baselineSessions + 1);
      assertIdle(report.checks.healthAfter, 'after browser close', { expectedSessions: baselineSessions + 1 });
    } catch (error) {
      failure = error;
    }
  }
  const allResponses = sameOriginResponses(report.traces);
  report.traces = report.traces.map((trace) => ({
    ...trace,
    responseCount: trace.responses.length,
  }));
  report.sameOriginNonSuccess = allResponses
    .filter((response) => response.status >= 400)
    .map(({ path: requestPath, status, label, queryVersion }) => ({ path: requestPath, status, label, queryVersion }));
  report.inheritedAlternative404 = report.sameOriginNonSuccess.filter((item) => item.path.startsWith('/assets/ui/'));
  report.finishedAt = new Date().toISOString();
  report.status = failure ? 'failed' : 'passed';
  if (failure) report.error = String(failure?.stack || failure?.message || failure);
  report.screenshots = ['title-settings.png', 'board-2d.png', 'board-3d.png'].filter((name) => fs.existsSync(path.join(artifacts, name)));
  fs.writeFileSync(path.join(artifacts, 'browser.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'w' });
  const log = [
    `status=${report.status}`,
    `candidate=${base.origin}`,
    `checks=${Object.keys(report.checks).join(',')}`,
    `screenshots=${report.screenshots.join(',')}`,
    `same_origin_non_success=${report.sameOriginNonSuccess.length}`,
    `inherited_alternative_404=${report.inheritedAlternative404.length}`,
    ...(failure ? [`error=${String(failure?.message || failure)}`] : []),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(artifacts, 'browser.log'), log, { flag: 'w' });
  process.stdout.write(JSON.stringify({ status: report.status, artifacts, screenshots: report.screenshots, checks: Object.keys(report.checks), error: failure ? String(failure?.message || failure) : undefined }, null, 2) + '\n');
  return failure ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(JSON.stringify({ status: 'blocked', error: String(error?.message || error) }) + '\n');
  process.exitCode = 2;
});
