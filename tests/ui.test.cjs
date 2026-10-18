const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {readFile} = require('node:fs/promises');
const {join} = require('node:path');
const {webcrypto} = require('node:crypto');
const {chromium} = require('playwright');

const root = join(__dirname, '..');
const today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Asia/Seoul'});
const day = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const fixture = {
  updated: new Date().toISOString(),
  wx: {lat: 37.5, lon: 127, name: '서울'},
  done: {topic: 'schedule-ui-test', key: 'test-only-key'},
  items: [
    {id: 1, date: today, k: 'o', t: '09:30', text: '주간 업무 계획 정리', c: '업무'},
    {id: 2, date: today, k: 'o', t: '14:00', text: '디자인 검토 미팅', c: '미팅'},
    {id: 3, date: today, k: 'o', text: '자동차 정기 점검 예약과 필요한 서류 확인하기', c: '차량'},
    {id: 4, date: day(1), k: 'o', t: '10:00', text: '다음 프로젝트 자료 준비', c: '업무'},
    {id: 5, date: day(-2), k: 'o', text: '지난주 경비 정산', c: '업무'},
    {id: 6, date: today, k: 'o', text: '아침 산책', c: '개인', done: true}
  ],
  rules: [{id: 7, label: '매주 금요일 업무 회고', c: '업무'}],
  memos: [{id: 8, text: '읽고 싶은 책 기록하기', c: '개인'}]
};
fixture.edit = 1;
fixture.edit_results = [];
for (const item of fixture.items.filter(x => !x.done)) item.edit = {rev: 'a'.repeat(64), kind: 'once', date: item.date, memo: false};
Object.assign(fixture.rules[0], {text: '업무 회고', t: '', edit: {rev: 'b'.repeat(64), kind: 'weekly', wd: 4, memo: false}});
fixture.memos[0].edit = {rev: 'c'.repeat(64), kind: 'note', memo: true};
const weatherFixture = {
  current: {time: today + 'T09:00', temperature_2m: 18.4, apparent_temperature: 17.8, weather_code: 1},
  hourly: {
    time: ['09:00', '10:00', '11:00', '12:00'].map(time => today + 'T' + time),
    temperature_2m: [18.4, 19, 20, 21], precipitation_probability: [10, 10, 20, 20], weather_code: [1, 1, 2, 2]
  },
  daily: {
    time: [today, day(1), day(2), day(3), day(4), day(5), day(6)],
    weather_code: [1, 3, 61, 0, 2, 0, 0], temperature_2m_max: [23, 21, 20, 22, 23, 24, 22],
    temperature_2m_min: [13, 12, 14, 12, 13, 14, 12], precipitation_probability_max: [10, 20, 80, 0, 10, 0, 0]
  }
};
let browser;
const base = 'https://schedule.test';
const fixtureSalt = webcrypto.getRandomValues(new Uint8Array(16)); // The publisher keeps its salt across refreshes.

async function encryptFixture(payload) {
  const salt = fixtureSalt;
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('preview'), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt']);
  const ct = await webcrypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(payload)));
  const b64 = x => Buffer.from(x).toString('base64');
  return JSON.stringify({salt: b64(salt), iv: b64(iv), ct: b64(ct), iter: 1000});
}
before(async () => {
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined});
});

after(async () => {await browser?.close()});

async function open(t, options = {}, weather = {}) {
  const blob = await encryptFixture(weather.payload || (weather.configured === false ? {...fixture, wx: null} : fixture));
  const context = await browser.newContext({viewport: {width: 390, height: 844}, colorScheme: 'light', serviceWorkers: 'block', ...options});
  t.after(() => context.close());
  const requests = [], errors = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === base) {
      if (url.pathname === '/data.enc.json') return route.fulfill({contentType: 'application/json', body: blob});
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'tokens.css', 'sw.js', 'manifest.webmanifest'].includes(file) && !/^icons\/[\w.-]+$/.test(file)) return route.fulfill({status: 404});
      return route.fulfill({path: join(root, file)});
    }
    if (url.hostname === 'api.open-meteo.com') return route.fulfill({status: weather.status || 200, contentType: 'application/json', body: JSON.stringify(weatherFixture)});
    return route.fulfill({status: 200, body: '{}'});
  });
  const page = await context.newPage();
  page.on('request', request => {if(new URL(request.url()).origin !== base)requests.push(request)});
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  if (weather.configured !== false && (!weather.status || weather.status === 200)) await page.waitForFunction(() => document.getElementById('wxb').textContent.includes('18°'));
  t.after(() => assert.deepEqual(errors, [], 'no browser script errors'));
  return {page, requests};
}

test('CG branding loads locally on the lock screen and app in both themes', async t => {
  const {page, requests} = await open(t);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({colorScheme});
    const logo = page.locator('#app .brand img');
    assert.equal(await logo.getAttribute('alt'), 'CGPORTFOLIO');
    assert.equal(await logo.evaluate(img => img.complete && img.naturalWidth > 0), true);
    assert.match(await page.title(), /CG/);
  }
  assert.equal(await page.locator('#today').getAttribute('datetime'), today);
  assert.match(await page.locator('#today').getAttribute('aria-label'), /\d+년 \d+월 \d+일 [일월화수목금토]요일/);
  await page.reload();
  const lockLogo = page.locator('#lock img');
  await lockLogo.waitFor({state: 'visible'});
  assert.equal(await lockLogo.evaluate(img => img.complete && img.naturalWidth > 0), true);
  assert.equal(requests.some(request => request.url().includes('tailab9ee1.ts.net')), false, 'the brand must work without the private portfolio server');
});

test('editing sends a signed field patch and waits for the actual saved result', async t => {
  const {page, requests} = await open(t);
  assert.equal(await page.locator('#tl .ed[data-id="1"]').count(), 1, 'the task title opens the editor');
  await page.locator('#tl .ed[data-id="1"]').click();
  assert.equal(await page.locator('#editor').isVisible(), true);
  await page.locator('#editText').fill('수정한 검토 미팅');
  await page.locator('#editDate').fill(day(1));
  await page.locator('#editTime').fill('11:30');
  await page.locator('#editCat').selectOption('개인');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editSave').disabled);
  const body = requests.find(r => r.url().includes('ntfy.sh')).postDataJSON();
  assert.equal(body.a, 'edit');
  assert.equal(body.id, 1);
  const command = JSON.parse(body.text);
  assert.equal(command.rev, fixture.items[0].edit.rev);
  assert.deepEqual(command.changes, {text: '수정한 검토 미팅', date: day(1), time: '11:30', cat: '개인'});
  const {createHmac} = require('node:crypto');
  assert.equal(body.sig, createHmac('sha256', fixture.done.key).update(`edit|1|${body.text}|${body.ts}`).digest('hex'));
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영'));
  assert.match(await page.locator('#editState').innerText(), /반영/);
  assert.match(await page.locator('#tl').innerText(), /주간 업무 계획 정리/, 'transport acceptance is not a saved result');
  await page.locator('#editClose').click();
  assert.equal(await page.locator('#actions .edit-resume').count(), 1, 'the pending edit remains discoverable after closing its sheet');
  await page.locator('#actions .edit-resume').click();
  assert.equal(await page.locator('#editor').isVisible(), true);
  const updated = structuredClone(fixture);
  Object.assign(updated.items[0], {text: command.changes.text, date: day(1), t: '11:30', c: '개인'});
  updated.edit_results = [{rid: command.rid, id: 1, ok: true, message: '수정했어요.'}];
  const blob = await encryptFixture(updated);
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.evaluate(() => reload());
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.match(await page.locator('#nl').innerText(), /수정한 검토 미팅/);
  assert.equal(await page.locator('#tl .ed[data-id="1"]').count(), 0);
  const stored = await page.evaluate(() => JSON.stringify({...localStorage, ...sessionStorage}));
  assert.equal(stored.includes(command.changes.text), false, 'private edit text is not stored unencrypted');
});

test('closing the editor preserves its draft and a rejected edit keeps the input', async t => {
  const {page, requests} = await open(t);
  assert.equal(await page.locator('#tl .ed[data-id="1"]').count(), 1);
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('남겨 둘 수정 내용');
  await page.keyboard.press('Escape');
  await page.locator('#tl .ed[data-id="1"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '남겨 둘 수정 내용');
  await page.locator('#editSave').click();
  const command = JSON.parse(requests.find(r => r.url().includes('ntfy.sh')).postDataJSON().text);
  const updated = structuredClone(fixture);
  updated.items[0].text = '다른 곳에서 바꾼 내용';
  updated.items[0].edit.rev = 'd'.repeat(64);
  updated.edit_results = [{rid: command.rid, id: 1, ok: false, code: 'conflict', message: '다른 곳에서 먼저 바뀐 일정이에요.'}];
  const blob = await encryptFixture(updated);
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.evaluate(() => reload());
  assert.equal(await page.locator('#editor').isVisible(), true);
  assert.equal(await page.locator('#editText').inputValue(), '남겨 둘 수정 내용');
  assert.match(await page.locator('#editState').innerText(), /바뀐/);
  await page.locator('#editLatest').click();
  await page.waitForFunction(() => document.getElementById('editText').value === '다른 곳에서 바꾼 내용');
  assert.equal(await page.locator('#editText').inputValue(), '다른 곳에서 바꾼 내용');
});

test('browser edits round-trip through the installed bot without changing real data', {skip: !process.env.SCHEDULE_BOT_DIR}, async t => {
  const {execFileSync} = require('node:child_process');
  const bridge = input => JSON.parse(execFileSync('python', [join(__dirname, 'edit_bridge.py')], {input: JSON.stringify({...input, today}), encoding: 'utf8', env: {...process.env, PYTHONIOENCODING: 'utf-8'}}));
  const db = {next_id: 2, items: [{id: 1, kind: 'once', date: today, time: '09:30', text: '테스트상사 미팅', cat: '미팅', added: day(-1)}]};
  const initial = bridge({db});
  const payload = {...initial.payload, wx: fixture.wx, done: fixture.done, updated: fixture.updated};
  const {page, requests} = await open(t, {}, {payload});
  await page.locator('#tl .ed').click();
  assert.equal(await page.locator('#editText').inputValue(), 'T사 미팅');
  await page.locator('#editText').fill('T사 계약 검토');
  await page.locator('#editDate').fill(day(1));
  await page.locator('#editTime').fill('11:00');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영'));
  const body = requests.find(r => r.url().includes('ntfy.sh')).postDataJSON();
  const saved = bridge({db: initial.db, body});
  assert.equal(saved.db.items[0].id, 1);
  assert.equal(saved.db.items[0].text, '테스트상사 계약 검토');
  assert.equal(saved.db.items[0].date, day(1));
  const blob = await encryptFixture({...payload, ...saved.payload});
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.evaluate(() => reload());
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.match(await page.locator('#nl').innerText(), /T사 계약 검토/);
});

test('a failed edit keeps its draft and retry reuses the same request identity', async t => {
  const {page, requests} = await open(t);
  await page.context().route('https://ntfy.sh/**', route => route.fulfill({status: 503, body: ''}));
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('실패해도 남길 내용');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => !document.getElementById('editSave').disabled);
  assert.equal(await page.locator('#editText').inputValue(), '실패해도 남길 내용');
  assert.match(await page.locator('#editState').innerText(), /확인하지 못/);
  const first = JSON.parse(requests.find(r => r.url().includes('ntfy.sh')).postDataJSON().text);
  await page.context().route('https://ntfy.sh/**', route => route.fulfill({status: 200, body: '{}'}));
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영'));
  await page.locator('#editForm').evaluate(form => form.requestSubmit());
  const sent = requests.filter(r => r.url().includes('ntfy.sh')).map(r => JSON.parse(r.postDataJSON().text));
  assert.equal(sent.length, 2, 'submitting again while waiting does not send another request');
  assert.equal(sent[1].rid, first.rid, 'ambiguous delivery can be retried safely');
});

test('an unconfirmed edit releases the form without losing its draft or retry identity', async t => {
  const {page, requests} = await open(t);
  await page.clock.install();
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('확인이 늦어도 남길 내용');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영'));
  await page.clock.fastForward(121000);
  await page.waitForFunction(() => !document.getElementById('editSave').disabled);
  assert.equal(await page.locator('#editText').inputValue(), '확인이 늦어도 남길 내용');
  assert.match(await page.locator('#editState').innerText(), /아직 반영/);
  const first = JSON.parse(requests.find(r => r.url().includes('ntfy.sh')).postDataJSON().text);
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  const sent = requests.filter(r => r.url().includes('ntfy.sh')).map(r => JSON.parse(r.postDataJSON().text));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].rid, first.rid);
});

test('forgetting the device clears the editor and ignores a late data refresh', async t => {
  const {page} = await open(t);
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#rem').check();
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('기억 해제 때 지워야 할 내용');
  await page.locator('#editClose').click();
  let release;
  const held = new Promise(resolve => {release = resolve});
  t.after(() => release());
  const blob = await encryptFixture(fixture);
  await page.context().route('**/data.enc.json?*', async route => {await held; await route.fulfill({contentType: 'application/json', body: blob})});
  const loading = page.waitForRequest('**/data.enc.json?*');
  await page.evaluate(() => {window.refreshForTest = reload()});
  await loading;
  await page.locator('#forget').focus();
  await page.keyboard.press('Enter');
  release();
  await page.evaluate(() => window.refreshForTest);
  assert.equal(await page.locator('#lock').isVisible(), true);
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.equal(await page.locator('#editText').inputValue(), '');
  assert.equal(await page.evaluate(() => data === null), true, 'old decryption cannot restore data after logout');
});

test('recurring and memo editors expose their real scheduling fields', async t => {
  const {page, requests} = await open(t);
  await page.locator('.focus-aside details summary').click();
  await page.locator('#rl .ed').click();
  assert.equal(await page.locator('#editDate').isVisible(), false);
  assert.equal(await page.locator('#editWeek').inputValue(), '4');
  await page.locator('#editWeek').selectOption('0');
  await page.locator('#editTime').fill('08:00');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영'));
  const command = JSON.parse(requests.find(r => r.url().includes('ntfy.sh')).postDataJSON().text);
  assert.deepEqual(command.changes, {time: '08:00', wd: 0});

  const other = await open(t);
  await other.page.locator('#tabM').click();
  await other.page.locator('#ml2 .ed').click();
  await other.page.locator('#editDate').fill(day(1));
  await other.page.locator('#editTime').fill('09:00');
  await other.page.locator('#editClearDate').click();
  assert.equal(await other.page.locator('#editDate').inputValue(), '');
  assert.equal(await other.page.locator('#editTime').inputValue(), '');
  await other.page.locator('#editSave').click();
  assert.equal(await other.page.locator('#editor').isVisible(), false, 'saving an unchanged memo sends nothing');
  assert.equal(other.requests.some(r => r.url().includes('ntfy.sh')), false);
});

test('completion and editing for the same schedule cannot overlap', async t => {
  const payload = structuredClone(fixture);
  payload.items[0].k = 'w';
  payload.items[0].edit = {...payload.items[0].edit, kind: 'weekly', wd: 6};
  payload.rules.unshift({id: 1, label: '매주 일요일 업무 계획', text: payload.items[0].text, c: '업무', edit: payload.items[0].edit});
  const {page} = await open(t, {}, {payload});
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.locator('.focus-aside details summary').click();
  assert.equal(await page.locator('#rl .ed[data-id="1"]').count(), 0, 'a repeat rule cannot change while its completion is queued');
  await page.locator('#actions .undo').click();
  await page.locator('#rl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('수정 중인 반복 업무');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영'));
  await page.locator('#editClose').click();
  await page.locator('#tl .dn[data-id="1"]').click();
  assert.equal(await page.locator('#actions .undo').count(), 0, 'completion waits until the date or repeat edit is confirmed');
  assert.equal(await page.locator('#editor').isVisible(), true);
});

test('the edit sheet fits short phones, keeps focus inside and supports dark mode', async t => {
  const {page} = await open(t, {isMobile: true, hasTouch: true});
  await page.locator('#tl .ed[data-id="1"]').tap();
  for (const viewport of [{width: 320, height: 568}, {width: 390, height: 360}, {width: 844, height: 390}, {width: 1280, height: 900}]) {
    await page.setViewportSize(viewport);
    const dialog = await page.locator('#editor').boundingBox();
    assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= viewport.width && dialog.y >= 0 && dialog.y + dialog.height <= viewport.height, `editor fits ${viewport.width}x${viewport.height}`);
    assert.equal(await page.locator('#editor').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.locator('#editSave').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#editor').evaluate(el => el.contains(document.activeElement)), true, 'Tab stays inside the dialog');
    const save = await page.locator('#editSave').boundingBox();
    assert.ok(save.height >= 44 && save.y + save.height <= viewport.height, 'save remains above the keyboard-sized viewport');
  }
  if (process.env.UI_SCREENSHOTS) {
    await page.setViewportSize({width: 390, height: 844});
    await page.emulateMedia({colorScheme: 'light'});
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-editor.png')});
    await page.emulateMedia({colorScheme: 'dark'});
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-editor-dark.png')});
  }
});

test('mobile starts with actionable tasks and switches schedule views without losing filters', async t => {
  const {page} = await open(t);
  assert.equal(await page.locator('#tl').isVisible(), true);
  assert.equal(await page.locator('#wkl').isVisible(), false, 'weekly list must not extend the today screen');
  assert.equal(await page.locator('#cal').isVisible(), false, 'monthly calendar must not extend the today screen');
  await page.locator('#chips button[data-c="업무"]').click();
  assert.equal(await page.locator('#tl .row').count(), 1);
  await page.getByRole('tab', {name: '주간', exact: true}).click();
  assert.equal(await page.locator('#wkl').isVisible(), true);
  assert.equal(await page.locator('#tl').isVisible(), false);
  await page.getByRole('tab', {name: '월간', exact: true}).click();
  assert.equal(await page.locator('#cal').isVisible(), true);
  await page.locator('#cal button[data-d="' + today + '"]').click();
  assert.equal(await page.locator('#dayl .row').count(), 1);
  await page.getByRole('tab', {name: '오늘', exact: true}).click();
  assert.equal(await page.locator('#chips button[data-c="업무"]').getAttribute('aria-pressed'), 'true');
});

test('weather stays visible after a failed request and can be retried', async t => {
  const {page} = await open(t, {}, {status: 503});
  assert.equal(await page.locator('#wxb').isVisible(), true, 'weather must not silently disappear on failure');
  await page.waitForFunction(() => document.getElementById('wxb').textContent.includes('다시'));
  assert.match(await page.locator('#wxb').innerText(), /다시/);
  await page.context().route('https://api.open-meteo.com/**', route => route.fulfill({contentType: 'application/json', body: JSON.stringify(weatherFixture)}));
  await page.locator('#wxb').click();
  await page.waitForFunction(() => document.getElementById('wxb').textContent.includes('18°'));
  assert.match(await page.locator('#wxb').innerText(), /서울/);
  await page.locator('#wxb').click();
  assert.equal(await page.locator('#wxp').isVisible(), true);
  assert.equal(await page.locator('#wxb').getAttribute('aria-expanded'), 'true');
  await page.locator('#wxb').click();
  assert.equal(await page.locator('#wxp').isVisible(), false);
});

test('missing weather location is explained without guessing a city', async t => {
  const {page, requests} = await open(t, {}, {configured: false});
  assert.equal(await page.locator('#wxb').isVisible(), true);
  assert.match(await page.locator('#wxb').innerText(), /지역/);
  assert.equal(await page.locator('#wxb').isDisabled(), true);
  assert.equal(requests.some(r => r.url().includes('api.open-meteo.com')), false);
});

test('tabs support keyboard navigation and memo/search preserve navigation history', async t => {
  const {page} = await open(t);
  await page.getByRole('tab', {name: '오늘', exact: true}).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', {name: '주간', exact: true}).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#cal').isVisible(), true);
  await page.locator('#tabM').click();
  await page.locator('#ml2').waitFor({state: 'visible'});
  assert.equal(await page.locator('#ml2').isVisible(), true);
  await page.locator('#tabQ').click();
  await page.locator('#qin').fill('미팅');
  assert.equal(await page.locator('#ql1 .row').count(), 1);
  await page.locator('#tabS').click();
  await page.waitForURL(base + '/');
  assert.equal(await page.locator('#cal').isVisible(), true);
});

test('completion can be undone and adding keeps the signed request flow', async t => {
  const {page, requests} = await open(t);
  await page.locator('#tl .dn[data-id="1"]').click();
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 0);
  await page.locator('#actions .undo').click();
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 1);
  await page.locator('#sadd').fill('내일 자료 검토 #업무');
  await page.locator('#saddf button').click();
  await page.locator('#spend').waitFor({state: 'visible'});
  const add = requests.find(r => r.url().includes('ntfy.sh'));
  assert.ok(add, 'addition reaches the existing transport');
  const body = add.postDataJSON();
  assert.equal(body.a, 'add');
  assert.equal(body.text, '내일 자료 검토 #업무');
  assert.match(body.sig, /^[a-f0-9]{64}$/);
});

test('new text entered while an addition is sending is kept for the next submission', async t => {
  for (const [tab, input, form] of [['tabS', 'sadd', 'saddf'], ['tabM', 'madd', 'maddf']]) {
    const {page} = await open(t);
    await page.locator('#' + tab).click();
    await page.locator('#' + input).waitFor({state: 'visible'});
    let release;
    const held = new Promise(resolve => {release = resolve});
    t.after(() => release());
    await page.context().route('https://ntfy.sh/**', async route => {
      await held;
      await route.fulfill({status: 200, body: '{}'});
    });
    await page.locator('#' + input).fill('첫 번째 내용');
    await page.locator('#' + form + ' button').click();
    await page.locator('#' + input).fill('다음에 보낼 내용');
    release();
    await page.waitForFunction(id => !document.querySelector('#' + id + ' button').disabled, form);
    assert.equal(await page.locator('#' + input).inputValue(), '다음에 보낼 내용');
  }
});

test('completion waiting for undo survives reload and is sent exactly once', async t => {
  const {page, requests} = await open(t);
  await page.clock.install();
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'), null, {timeout: 1000});
  const actions = requests.filter(r => r.url().includes('ntfy.sh')).map(r => r.postDataJSON());
  assert.equal(actions.length, 1, 'one pending completion is delivered after reload');
  assert.equal(actions[0].a, 'done');
  assert.equal(actions[0].id, 1);
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.clock.runFor(5500);
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 1, 'accepted requests are not resent');
});

test('each pending action can be undone even after another action is queued', async t => {
  const {page, requests} = await open(t);
  await page.clock.install();
  const headerY = await page.locator('.hero').evaluate(el => el.getBoundingClientRect().top + scrollY);
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.locator('#tl .dn[data-id="2"]').click();
  assert.equal(await page.locator('.hero').evaluate(el => el.getBoundingClientRect().top + scrollY), headerY, 'action feedback does not shift the page header');
  const firstUndo = page.locator('#actions .undo[data-k="1|' + today + '"]');
  assert.equal(await firstUndo.count(), 1, 'first action keeps its own undo control');
  if(process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'pending-actions.png')});
  await firstUndo.click();
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 1);
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'), null, {timeout: 1000});
  const actions = requests.filter(r => r.url().includes('ntfy.sh')).map(r => r.postDataJSON());
  assert.deepEqual(actions.map(x => x.id), [2]);
});

test('forgetting the device cancels actions that have not been sent', async t => {
  const {page, requests} = await open(t);
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#rem').check();
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.clock.install();
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.locator('#forget').focus();
  await page.keyboard.press('Enter');
  await page.clock.runFor(5500);
  assert.equal(await page.locator('#lock').isVisible(), true);
  assert.equal(await page.locator('#toast').isVisible(), false);
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 0);
});

test('a stalled addition releases the form and keeps the unsent text', async t => {
  const {page} = await open(t);
  await page.clock.install();
  let release;
  const held = new Promise(resolve => {release = resolve});
  t.after(() => release());
  await page.context().route('https://ntfy.sh/**', async route => {
    await held;
    await route.fulfill({status: 200, body: '{}'});
  });
  await page.locator('#sadd').fill('끊겨도 남아 있어야 할 내용');
  const sent = page.waitForRequest('https://ntfy.sh/**');
  await page.locator('#saddf button').click();
  await sent;
  await page.clock.runFor(16000);
  assert.equal(await page.locator('#saddf button').isDisabled(), false, 'stalled requests do not leave the form locked');
  assert.equal(await page.locator('#sadd').inputValue(), '끊겨도 남아 있어야 할 내용');
  assert.match(await page.locator('#toast').innerText(), /보내지 못/);
});

test('failed action delivery restores the task and clears the pending undo state', async t => {
  const {page} = await open(t);
  await page.clock.install();
  await page.context().route('https://ntfy.sh/**', route => route.fulfill({status: 503, body: ''}));
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보내지 못'), null, {timeout: 1500});
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 1);
  assert.equal(await page.locator('#actions').isVisible(), false);
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 1);
});

test('snoozing and memo deletion keep their action type across reload', async t => {
  for (const [selector, a, id] of [['#tl .sn[data-id="1"]', 'snooze', 1], ['#ml2 .rm[data-id="8"]', 'del', 8]]) {
    const {page, requests} = await open(t);
    await page.clock.install();
    if(a === 'del') {
      await page.locator('#tabM').click();
      await page.locator('#ml2').waitFor({state: 'visible'});
    }
    await page.locator(selector).click();
    await page.reload();
    await page.locator('#pw').fill('preview');
    await page.locator('#go').click();
    await page.locator('#app').waitFor({state: 'visible'});
    await page.clock.runFor(5500);
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'), null, {timeout: 1500});
    const actions = requests.filter(r => r.url().includes('ntfy.sh')).map(r => r.postDataJSON());
    assert.deepEqual(actions.map(x => [x.a, x.id]), [[a, id]]);
  }
});

test('a deleted recurring rule stays hidden until fresh data confirms deletion', async t => {
  const {page} = await open(t);
  await page.clock.install();
  await page.locator('#tabQ').click();
  await page.locator('#qin').fill('회고');
  await page.locator('#ql2 .rm[data-id="7"]').click();
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'), null, {timeout: 1500});
  assert.equal(await page.locator('#ql2 .row').count(), 0, 'a rule without near-term occurrences must stay deleted');
});

test('closing a page during delivery never automatically repeats the request', async t => {
  const {page, requests} = await open(t);
  await page.clock.install();
  let release;
  const held = new Promise(resolve => {release = resolve});
  t.after(() => release());
  await page.context().route('https://ntfy.sh/**', async route => {
    await held;
    await route.fulfill({status: 200, body: '{}'});
  });
  const sent = page.waitForRequest('https://ntfy.sh/**');
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.clock.runFor(5500);
  await sent;
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  release();
  await page.clock.runFor(5500);
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 1);
  assert.match(await page.locator('#toast').innerText(), /확인/);
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 1, 'unconfirmed actions are not shown as completed');
});

test('phone, desktop and dark mode fit the viewport with usable controls', async t => {
  const {page} = await open(t);
  for (const width of [320, 375, 390, 414, 768, 1280]) {
    await page.setViewportSize({width, height: 900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}px`);
    const button = await page.locator('#tl .dn').first().boundingBox();
    assert.ok(button.height >= 44, 'completion button has a 44px touch target');
    for (const mode of ['주간', '월간']) {
      await page.getByRole('tab', {name: mode, exact: true}).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${mode} fits at ${width}px`);
    }
    const date = await page.locator('#cal button[data-d="' + today + '"]').boundingBox();
    assert.ok(date.width >= 44 && date.height >= 44, 'calendar dates have a 44px touch target');
    await page.getByRole('tab', {name: '오늘', exact: true}).click();
  }
  const main = await page.locator('main').boundingBox();
  assert.ok(main.width >= 1000, 'desktop uses the available space');
  await page.emulateMedia({colorScheme: 'dark', reducedMotion: 'reduce'});
  assert.equal(await page.locator('#tl').isVisible(), true);
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({colorScheme});
    const ratios = await page.evaluate(() => {
      const luminance = color => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(x => {
          const n = Number(x) / 255;
          return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      return ['#saddf button', '.date-weekday', '#wxb', '#tl .dn', '#tl .pill'].map(selector => {
        const el = document.querySelector(selector), style = getComputedStyle(el);
        let parent = el, bg = style.backgroundColor;
        while (bg === 'rgba(0, 0, 0, 0)' && parent.parentElement) {parent = parent.parentElement; bg = getComputedStyle(parent).backgroundColor}
        const a = luminance(style.color), b = luminance(bg);
        return {selector, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05)};
      });
    });
    for (const {selector, ratio} of ratios) assert.ok(ratio >= 4.5, `${colorScheme} ${selector} contrast ${ratio.toFixed(2)}`);
  }
  if (process.env.UI_SCREENSHOTS) {
    const {mkdir} = require('node:fs/promises');
    await mkdir(process.env.UI_SCREENSHOTS, {recursive: true});
    await page.emulateMedia({colorScheme: 'dark'});
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'desktop-dark.png'), fullPage: true});
    await page.emulateMedia({colorScheme: 'light'});
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'desktop-light.png'), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    await page.emulateMedia({colorScheme: 'dark'});
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-dark.png')});
    await page.emulateMedia({colorScheme: 'light'});
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-light.png')});
    await page.locator('#wxb').click();
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-weather.png')});
    await page.locator('#wxb').click();
    await page.getByRole('tab', {name: '주간', exact: true}).click();
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-week.png')});
    await page.getByRole('tab', {name: '월간', exact: true}).click();
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-month.png')});
    await page.locator('#tabM').click();
    await page.locator('#ml2').waitFor({state: 'visible'});
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-memo.png')});
    await page.locator('#tabQ').click();
    await page.locator('#qin').fill('업무');
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-search.png')});
  }
});

test('small touch screens keep calendar navigation and dates tappable', async t => {
  const {page} = await open(t, {isMobile: true, hasTouch: true, viewport: {width: 320, height: 568}});
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({width, height: 740});
    await page.getByRole('tab', {name: '주간', exact: true}).tap();
    for (const id of ['wprev', 'wnext']) {
      const box = await page.locator('#' + id).boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${id} remains tappable at ${width}px`);
    }
    await page.getByRole('tab', {name: '월간', exact: true}).tap();
    const date = await page.locator('#cal button[data-d="' + today + '"]').boundingBox();
    assert.ok(date.width >= 44 && date.height >= 44, `calendar dates remain tappable at ${width}px (${date.width} × ${date.height})`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}px`);
  }
});

test('landscape phones keep the bottom navigation and fit every screen', async t => {
  const {page} = await open(t, {isMobile: true, hasTouch: true, viewport: {width: 844, height: 390}});
  const nav = await page.locator('.tabs').boundingBox();
  assert.ok(nav.y > 300 && nav.y + nav.height <= 390, 'phone navigation remains at the bottom in landscape');
  const firstTask = await page.locator('#tl .dn').first().boundingBox();
  if (process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-landscape.png')});
  assert.ok(firstTask.y + firstTask.height <= nav.y, `first task ends at ${firstTask.y + firstTask.height}, above navigation at ${nav.y} in landscape`);
  for (const tab of ['tabM', 'tabQ', 'tabS']) {
    await page.locator('#' + tab).tap();
    const panel = {tabM: '#vMemo', tabQ: '#vSearch', tabS: '#vSch'}[tab];
    await page.locator(panel).waitFor({state: 'visible'});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${tab} fits in landscape`);
  }
  if (process.env.UI_SCREENSHOTS) {
    await page.locator('#today').tap();
    await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-landscape.png')});
  }
});

test('short portrait phones show the first task before scrolling', async t => {
  const {page} = await open(t, {isMobile: true, hasTouch: true, viewport: {width: 320, height: 568}});
  const firstTask = await page.locator('#tl .dn').first().boundingBox(), nav = await page.locator('.tabs').boundingBox();
  if (process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-small.png')});
  assert.ok(firstTask.y + firstTask.height <= nav.y, `first task ends at ${firstTask.y + firstTask.height}, above navigation at ${nav.y} on a small phone`);
});

test('short mobile viewports keep the focused input and task actions above navigation', async t => {
  const {page} = await open(t, {isMobile: true, hasTouch: true, viewport: {width: 390, height: 360}});
  await page.locator('#sadd').focus();
  let control = await page.locator('#sadd').boundingBox(), nav = await page.locator('.tabs').boundingBox();
  assert.ok(control.y >= 0 && control.y + control.height <= nav.y, 'focused input clears the navigation');
  await page.getByRole('tab', {name: '월간', exact: true}).tap();
  await page.locator('#dayl .rm').last().focus();
  control = await page.locator('#dayl .rm').last().boundingBox();
  nav = await page.locator('.tabs').boundingBox();
  const tools = await page.locator('.schedule-tools').boundingBox();
  assert.ok(control.y >= tools.y + tools.height && control.y + control.height <= nav.y, 'focused action clears both fixed navigation bars');
});
