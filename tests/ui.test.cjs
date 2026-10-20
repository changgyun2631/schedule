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

async function open(t, options = {}, weather = {}, init) {
  const blob = await encryptFixture(weather.payload || (weather.configured === false ? {...fixture, wx: null} : fixture));
  const context = await browser.newContext({viewport: {width: 390, height: 844}, colorScheme: 'light', serviceWorkers: 'block', ...options});
  t.after(() => context.close());
  if (init) await context.addInitScript(init);
  const requests = [], errors = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === base) {
      if (url.pathname === '/data.enc.json') return route.fulfill({contentType: 'application/json', body: blob});
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'tokens.css', 'sw.js', 'manifest.webmanifest'].includes(file) && !/^icons\/[\w.-]+$/.test(file)) return route.fulfill({status: 404});
      return route.fulfill({path: join(root, file)});
    }
    if (url.hostname === 'api.open-meteo.com') return route.fulfill({status: weather.status || 200, contentType: 'application/json', body: JSON.stringify(weather.fixture || weatherFixture)});
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

const draftStorage = 'schedule-drafts-v1';
async function storedDraft(page) {
  const raw = await page.evaluate(name => localStorage.getItem(name), draftStorage);
  if(!raw) return null;
  const envelope = JSON.parse(raw);
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('preview'), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt: fixtureSalt, iterations: 1000}, material, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
  const plain = await webcrypto.subtle.decrypt({name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'), additionalData: new TextEncoder().encode(draftStorage)}, key, Buffer.from(envelope.ct, 'base64'));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function waitForDraft(page, matches) {
  for(let i = 0; i < 50; i++) {
    const draft = await storedDraft(page);
    if(draft && matches(draft)) return draft;
    await page.waitForTimeout(20);
  }
  assert.fail('the encrypted draft did not contain the latest input');
}

test('encrypted entry and edit drafts survive reload and only return after unlocking', async t => {
  const {page, requests} = await open(t);
  await page.locator('#sadd').fill('내일 고객에게 보낼 개인 초안');
  await page.locator('#tabM').click();
  await page.locator('#madd').fill('기억해 둘 개인 메모 초안');
  await page.locator('#tabS').click();
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('아직 보내지 않은 수정 초안');
  await page.locator('#editDate').fill(day(2));
  await page.locator('#editTime').fill('17:30');
  await page.locator('#editCat').selectOption('개인');
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="2"]').click();
  await page.locator('#editText').fill('다른 일정의 수정 초안');
  await page.locator('#editClose').click();
  await waitForDraft(page, d => d.sadd === '내일 고객에게 보낼 개인 초안' && d.madd === '기억해 둘 개인 메모 초안' && d.edits.some(e => e.id === 2 && e.draft.text === '다른 일정의 수정 초안'));
  const storage = await page.evaluate(() => JSON.stringify({...localStorage, ...sessionStorage}));
  for(const text of ['내일 고객에게 보낼 개인 초안', '기억해 둘 개인 메모 초안', '아직 보내지 않은 수정 초안', '다른 일정의 수정 초안']) assert.equal(storage.includes(text), false, 'private drafts never appear as plaintext in browser storage');
  assert.equal(await page.evaluate(() => localStorage.getItem('schedule-key-v1')), null, 'draft retention does not remember the password key without consent');
  await page.reload();
  await page.locator('#lock').waitFor({state: 'visible'});
  assert.equal(await page.locator('#sadd').inputValue(), '');
  await page.locator('#pw').fill('wrong-password');
  await page.locator('#go').click();
  await page.waitForFunction(() => document.getElementById('err').textContent.includes('비밀번호'));
  assert.equal(await page.locator('#sadd').inputValue(), '');
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  assert.equal(await page.locator('#sadd').inputValue(), '내일 고객에게 보낼 개인 초안');
  assert.equal(await page.locator('#madd').inputValue(), '기억해 둘 개인 메모 초안');
  await page.locator('#tl .ed[data-id="1"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '아직 보내지 않은 수정 초안');
  assert.equal(await page.locator('#editDate').inputValue(), day(2));
  assert.equal(await page.locator('#editTime').inputValue(), '17:30');
  assert.equal(await page.locator('#editCat').inputValue(), '개인');
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="2"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '다른 일정의 수정 초안');
  assert.equal(requests.some(r => r.url().includes('ntfy.sh')), false, 'restoring a draft never submits it');
});

test('a long pasted memo is encrypted and restored without exceeding browser argument limits', async t => {
  const {page} = await open(t);
  const text = '긴 메모 초안 '.repeat(10000);
  await page.locator('#tabM').click();
  await page.locator('#madd').fill(text);
  await page.waitForFunction(name => localStorage.getItem(name) || !document.getElementById('draftWarning').hidden, draftStorage);
  assert.equal(await page.locator('#draftWarning').isVisible(), false, 'a large paste stays eligible for encrypted draft storage');
  await waitForDraft(page, d => d.madd === text);
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  assert.equal(await page.locator('#madd').inputValue(), text);
});

test('a restored pending edit checks its receipt and keeps the same identity for a manual retry', async t => {
  const {page, requests} = await open(t);
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('새로고침해도 중복 전송하지 않을 수정');
  await page.locator('#editSave').click();
  await waitForDraft(page, d => d.edits.some(e => e.id === 1 && e.sent));
  const first = JSON.parse(requests.find(r => r.url().includes('ntfy.sh')).postDataJSON().text);
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.locator('#actions .edit-resume[data-id="1"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '새로고침해도 중복 전송하지 않을 수정');
  assert.equal(await page.locator('#editSave').isDisabled(), true);
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 1);
  await page.clock.install();
  await page.clock.fastForward(121000);
  await page.waitForFunction(() => !document.getElementById('editSave').disabled);
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  const second = JSON.parse(requests.filter(r => r.url().includes('ntfy.sh')).at(-1).postDataJSON().text);
  assert.equal(second.rid, first.rid);
  const updated = structuredClone(fixture);
  updated.items[0].text = second.changes.text;
  updated.edit_results = [{rid: first.rid, id: 1, ok: true}];
  const blob = await encryptFixture(updated);
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.evaluate(() => reload());
  await page.waitForFunction(name => localStorage.getItem(name) === null, draftStorage);
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.match(await page.locator('#tl').innerText(), /새로고침해도 중복 전송하지 않을 수정/);
});

test('remembered-device unlock restores drafts and creates a fresh IV for later input', async t => {
  const {page} = await open(t);
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#rem').check();
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.locator('#sadd').fill('기억한 기기에서 복원할 초안');
  await waitForDraft(page, d => d.sadd === '기억한 기기에서 복원할 초안');
  const first = await page.evaluate(name => JSON.parse(localStorage.getItem(name)), draftStorage);
  assert.equal(Buffer.from(first.iv, 'base64').length, 12);
  await page.reload();
  await page.locator('#app').waitFor({state: 'visible'});
  assert.equal(await page.locator('#sadd').inputValue(), '기억한 기기에서 복원할 초안');
  await page.locator('#sadd').fill('기억한 기기에서 계속 고친 초안');
  await waitForDraft(page, d => d.sadd === '기억한 기기에서 계속 고친 초안');
  const second = await page.evaluate(name => JSON.parse(localStorage.getItem(name)), draftStorage);
  assert.notEqual(second.iv, first.iv, 'each encryption uses its own random IV');
  await page.locator('#sadd').fill('');
  await page.waitForFunction(name => localStorage.getItem(name) === null, draftStorage);
});

test('forgetting the device clears encrypted drafts even when an old encryption finishes later', async t => {
  const {page} = await open(t);
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#rem').check();
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.locator('#madd').evaluate(el => {el.value = '지워야 할 메모'; el.dispatchEvent(new Event('input', {bubbles: true}))});
  await waitForDraft(page, d => d.madd === '지워야 할 메모');
  await page.evaluate(() => {
    window.encryptionsToRelease = [];
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = (...args) => encrypt(...args).then(result => new Promise(resolve => encryptionsToRelease.push(() => resolve(result))));
  });
  await page.locator('#sadd').fill('늦게 끝나도 다시 저장하면 안 되는 초안');
  await page.waitForFunction(() => encryptionsToRelease.length > 0);
  await page.locator('#forget').focus();
  await page.keyboard.press('Enter');
  await page.evaluate(async () => {encryptionsToRelease.forEach(release => release()); await Promise.resolve(); delete crypto.subtle.encrypt});
  assert.equal(await page.evaluate(name => localStorage.getItem(name), draftStorage), null);
  assert.equal(await page.locator('#sadd').inputValue(), '');
  assert.equal(await page.locator('#madd').inputValue(), '');
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  assert.equal(await page.locator('#sadd').inputValue(), '');
  assert.equal(await page.locator('#madd').inputValue(), '');
});

test('blocked draft storage reports the limit while schedule submission remains available', async t => {
  const {page, requests} = await open(t, {viewport: {width: 320, height: 568}}, {}, () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) {if(name === 'schedule-drafts-v1') throw new DOMException('full', 'QuotaExceededError'); return setItem.call(this, name, value)};
  });
  await page.locator('#sadd').fill('연결된 앱에서 보낼 수 있는 내용');
  await page.locator('#draftWarning').waitFor({state: 'visible'});
  assert.match(await page.locator('#draftWarning').innerText(), /보관하지 못/);
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('보관 실패 때도 남을 수정');
  assert.equal(await page.locator('#editDraftWarning').isVisible(), true);
  assert.equal(await page.locator('#editSave').isDisabled(), false);
  await page.setViewportSize({width: 320, height: 400});
  const saveBox = await page.locator('#editSave').boundingBox();
  assert.ok(saveBox.y >= 0 && saveBox.y + saveBox.height <= 400, 'a storage warning keeps Save reachable on a short phone viewport');
  const footer = page.locator('.edit-foot');
  const footerBox = await footer.boundingBox();
  const clip = {x: footerBox.x + 1, y: Math.ceil(footerBox.y) + 1, width: footerBox.width - 2, height: Math.min(400, footerBox.y + footerBox.height) - Math.ceil(footerBox.y) - 2};
  const footerWithFields = await page.screenshot({animations: 'disabled', caret: 'hide', clip});
  await page.locator('#editFields').evaluate(el => {el.style.visibility = 'hidden'});
  const footerWithoutFields = await page.screenshot({animations: 'disabled', caret: 'hide', clip});
  await page.locator('#editFields').evaluate(el => {el.style.visibility = ''});
  assert.equal(Buffer.compare(footerWithFields, footerWithoutFields), 0, 'scrolling fields never paint over the warning and Save controls');
  if(process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'draft-storage-warning.png')});
  await page.setViewportSize({width: 320, height: 568});
  await page.locator('#editClose').click();
  await page.locator('#saddf button[type=submit]').click();
  await page.locator('#spend').waitFor({state: 'visible'});
  assert.equal(requests.find(r => r.url().includes('ntfy.sh')).postDataJSON().text, '연결된 앱에서 보낼 수 있는 내용');
});

test('an unreadable draft never blocks unlock or gets silently overwritten', async t => {
  for(const damage of ['ciphertext', 'salt']) {
    const {page} = await open(t);
    await page.locator('#sadd').fill('손상되기 전 보관한 초안');
    await waitForDraft(page, d => d.sadd === '손상되기 전 보관한 초안');
    const raw = await page.evaluate(({name, damage}) => {
      const sealed = JSON.parse(localStorage.getItem(name));
      if(damage === 'salt') sealed.salt = 'different-salt';
      else sealed.ct = (sealed.ct[0] === 'A' ? 'B' : 'A') + sealed.ct.slice(1);
      const raw = JSON.stringify(sealed); localStorage.setItem(name, raw); return raw;
    }, {name: draftStorage, damage});
    await page.reload();
    await page.locator('#pw').fill('preview');
    await page.locator('#go').click();
    await page.locator('#app').waitFor({state: 'visible'});
    assert.equal(await page.locator('#draftWarning').isVisible(), true);
    assert.equal(await page.locator('#sadd').inputValue(), '');
    await page.locator('#sadd').fill('현재 창에서 새로 작성한 내용');
    assert.equal(await page.evaluate(name => localStorage.getItem(name), draftStorage), raw, 'the old encrypted record is kept for recovery');
  }
});

test('another open window cannot silently overwrite a newer draft', async t => {
  const {page} = await open(t);
  await page.locator('#sadd').fill('첫 창의 시작 내용');
  await waitForDraft(page, d => d.sadd === '첫 창의 시작 내용');
  const other = await page.context().newPage();
  const errors = []; other.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await other.goto(base);
  await other.locator('#pw').fill('preview');
  await other.locator('#go').click();
  await other.locator('#app').waitFor({state: 'visible'});
  await page.locator('#sadd').fill('첫 창에서 더 고친 최신 내용');
  await waitForDraft(page, d => d.sadd === '첫 창에서 더 고친 최신 내용');
  await other.locator('#sadd').fill('둘째 창에서 고친 별도 내용');
  await other.locator('#draftWarning').waitFor({state: 'visible'});
  assert.match(await other.locator('#draftWarning').innerText(), /다른 창/);
  assert.equal((await storedDraft(page)).sadd, '첫 창에서 더 고친 최신 내용');
  assert.equal(await other.locator('#sadd').inputValue(), '둘째 창에서 고친 별도 내용');
});

test('the newest input wins when encryption promises finish out of order', async t => {
  const {page} = await open(t);
  await page.evaluate(() => {
    window.encryptionsToRelease = [];
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = (...args) => encrypt(...args).then(result => new Promise(resolve => encryptionsToRelease.push(() => resolve(result))));
  });
  await page.locator('#sadd').fill('먼저 입력한 초안');
  await page.waitForFunction(() => encryptionsToRelease.length === 1);
  await page.locator('#sadd').fill('나중에 고친 최신 초안');
  await page.waitForFunction(() => encryptionsToRelease.length === 2);
  await page.evaluate(() => encryptionsToRelease[1]());
  await waitForDraft(page, d => d.sadd === '나중에 고친 최신 초안');
  await page.evaluate(async () => {encryptionsToRelease[0](); await Promise.resolve(); delete crypto.subtle.encrypt});
  assert.equal((await storedDraft(page)).sadd, '나중에 고친 최신 초안');
});

test('reopening during addition restores the text and warns before a manual resend', async t => {
  const {page, requests} = await open(t);
  let release;
  const held = new Promise(resolve => {release = resolve});
  t.after(() => release());
  await page.context().route('https://ntfy.sh/**', async route => {await held; await route.fulfill({status: 200, body: '{}'})});
  await page.locator('#sadd').fill('내일 전송 중이던 추가 내용');
  const sending = page.waitForRequest('https://ntfy.sh/**');
  await page.locator('#saddf button[type=submit]').click();
  await sending;
  await waitForDraft(page, d => d.submitting.saddf);
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  assert.equal(await page.locator('#sadd').inputValue(), '내일 전송 중이던 추가 내용');
  assert.equal(await page.locator('#svoiceState').isVisible(), true);
  assert.match(await page.locator('#svoiceState').innerText(), /이미 등록됐는지/);
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 1, 'reopening never repeats an uncertain addition');
  await page.locator('#sadd').fill('내일 새로 작성할 다음 내용');
  await waitForDraft(page, d => d.sadd === '내일 새로 작성할 다음 내용' && !d.submitting.saddf);
});

test('a restored unsent edit can be discarded without deleting the schedule', async t => {
  const {page, requests} = await open(t);
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('사용자가 버릴 수정 초안');
  await page.locator('#editClose').click();
  await waitForDraft(page, d => d.edits.some(e => e.id === 1));
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.locator('#actions .edit-resume[data-id="1"]').click();
  const discard = page.getByRole('button', {name: '초안 버리기', exact: true});
  assert.equal(await discard.count(), 1, 'restored work has an explicit discard action');
  await discard.click();
  await page.waitForFunction(name => localStorage.getItem(name) === null, draftStorage);
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.equal(requests.some(r => r.url().includes('ntfy.sh')), false);
  await page.locator('#tl .ed[data-id="1"]').click();
  assert.equal(await page.locator('#editText').inputValue(), fixture.items[0].text);
  await page.locator('#editText').fill('반영 확인이 필요한 수정');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  assert.equal(await discard.isVisible(), false, 'an uncertain server request cannot be discarded as an unsent draft');
});

function mockSpeech() {
  window.speechInstances = [];
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = class {
    constructor() {window.speechInstances.push(this)}
    start() {this.started = true; this.onstart?.()}
    stop() {this.stopped = true}
    abort() {this.aborted = true; this.onend?.()}
    emit(...texts) {this.onresult?.({results: texts.map(transcript => [{transcript}])})}
  };
}

function deletionFixture() {
  const payload = structuredClone(fixture);
  const date = new Date(Date.UTC(+today.slice(0,4), +today.slice(5,7) - 1 + (+today.slice(8) > 20 ? 1 : 0), 20)).toISOString().slice(0,10);
  payload.items.push({id: 46, date, k: 'o', text: '책 반납하기', c: '개인', edit: {rev: 'd'.repeat(64), kind: 'once', date, memo: false}});
  return payload;
}

test('date and spoken number deletion commands use the existing signed deletion and undo flow', async t => {
  const {page, requests} = await open(t, {}, {payload: deletionFixture()});
  await page.clock.install();
  const commands = ['20일 책 반납하기 제거해줘', '20일 책반납하기 삭제해줘', '샵사십육 삭제해줘', '샵사십육 제거해줘', '#46 삭제해줘', '샵 사십 육 제거 해 줘.'];
  for(const text of commands) {
    await page.locator('#sadd').fill(text);
    assert.equal(await page.locator('#saddf button[type=submit]').innerText(), '삭제', 'the button states the action before it is run');
    await page.locator('#saddf button[type=submit]').click();
    assert.equal(await page.locator('#actions .undo[data-k="x|46"]').count(), 1, text);
    assert.equal(await page.locator('#sadd').inputValue(), '');
    if(text !== commands.at(-1)) await page.locator('#actions .undo[data-k="x|46"]').click();
  }
  assert.equal(requests.some(r => r.url().includes('ntfy.sh')), false, 'deletion keeps the undo period');
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('삭제를 보냈어요'));
  const actions = requests.filter(r => r.url().includes('ntfy.sh')).map(r => r.postDataJSON());
  assert.equal(actions.length, 1);
  assert.equal(actions[0].a, 'del');
  assert.equal(actions[0].id, 46);
  const {createHmac} = require('node:crypto');
  assert.equal(actions[0].sig, createHmac('sha256', fixture.done.key).update(`del|46||${actions[0].ts}`).digest('hex'));
});

test('ambiguous, invalid and missing deletion targets never become new schedules', async t => {
  const payload = deletionFixture();
  payload.items.push({...structuredClone(payload.items.at(-1)), id: 47});
  const {page, requests} = await open(t, {}, {payload});
  for(const text of ['20일 책반납하기 삭제해줘', '20일 없는 내용 제거해줘', '2월 30일 책 반납하기 삭제해줘', '샵사십십육 삭제해줘', '샵사십영 제거해줘', '삭제해줘']) {
    await page.locator('#sadd').fill(text);
    await page.locator('#saddf button[type=submit]').click();
    assert.equal(await page.locator('#sadd').inputValue(), text);
    assert.equal(await page.locator('#actions .undo').count(), 0);
    assert.equal(requests.some(r => r.url().includes('ntfy.sh')), false, text);
    assert.equal(await page.locator('#svoiceState').isVisible(), true, 'command feedback stays next to the input');
  }
  await page.locator('#tabM').click();
  await page.locator('#madd').fill('20일 없는 내용 제거해줘');
  await page.locator('#maddf button[type=submit]').click();
  assert.equal(await page.locator('#mcommandState').isVisible(), true, 'memo entry also reports an unresolved deletion');
  assert.equal(requests.some(r => r.url().includes('ntfy.sh')), false);
  await page.locator('#tabS').click();
  await page.locator('#sadd').waitFor({state: 'visible'});
  await page.locator('#sadd').fill('#47 제거해줘');
  await page.locator('#saddf button[type=submit]').click();
  assert.equal(await page.locator('#actions .undo[data-k="x|47"]').count(), 1, 'an explicit number resolves an ambiguous title');
});

test('deletion words inside an ordinary schedule or memo still add the content', async t => {
  const {page, requests} = await open(t);
  await page.locator('#sadd').fill('내일 삭제할 파일 확인');
  assert.equal(await page.locator('#saddf button[type=submit]').innerText(), '추가');
  await page.locator('#saddf button[type=submit]').click();
  await page.locator('#spend').waitFor({state: 'visible'});
  await page.locator('#tabM').click();
  await page.locator('#madd').fill('삭제해줘라는 말 기억');
  await page.locator('#maddf button[type=submit]').click();
  await page.locator('#mpend').waitFor({state: 'visible'});
  const actions = requests.filter(r => r.url().includes('ntfy.sh')).map(r => r.postDataJSON());
  assert.deepEqual(actions.map(a => [a.a, a.text]), [['add', '내일 삭제할 파일 확인'], ['add', '#메모 삭제해줘라는 말 기억']]);
});

test('speech can prepare a deletion command without deleting before confirmation', async t => {
  const {page, requests} = await open(t, {}, {payload: deletionFixture()}, mockSpeech);
  await page.locator('#svoice').click();
  await page.evaluate(() => speechInstances[0].emit('샵사십육 제거해줘'));
  assert.equal(await page.locator('#saddf button[type=submit]').innerText(), '삭제');
  assert.equal(await page.locator('#saddf button[type=submit]').isDisabled(), true);
  assert.equal(requests.some(r => r.url().includes('ntfy.sh')), false);
  await page.locator('#saddf').evaluate(form => form.requestSubmit());
  assert.equal(await page.locator('#actions .undo').count(), 0, 'a submit event during speech recognition cannot start deletion');
  await page.evaluate(() => speechInstances[0].onend());
  await waitForDraft(page, d => d.sadd === '샵사십육 제거해줘');
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  assert.equal(await page.locator('#sadd').inputValue(), '샵사십육 제거해줘');
  assert.equal(await page.locator('#saddf button[type=submit]').innerText(), '삭제');
  assert.equal(requests.some(r => r.url().includes('ntfy.sh')), false, 'restoring recognized speech never executes the command');
  await page.locator('#saddf button[type=submit]').click();
  assert.equal(await page.locator('#actions .undo[data-k="x|46"]').count(), 1);
});

test('text deletion keeps the edit lock and distinguishes an occurrence from a whole recurring rule', async t => {
  const payload = deletionFixture();
  payload.items.push({id: 7, date: today, k: 'w', text: '업무 회고', c: '업무'});
  const {page} = await open(t, {}, {payload});
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('반영을 기다리는 수정');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  await page.locator('#editClose').click();
  await page.locator('#sadd').fill('#1 삭제해줘');
  await page.locator('#saddf button[type=submit]').click();
  assert.equal(await page.locator('#editor').isVisible(), true);
  assert.equal(await page.locator('#actions .undo').count(), 0);
  assert.equal(await page.locator('#sadd').inputValue(), '#1 삭제해줘');
  await page.locator('#editClose').click();
  await page.locator('#sadd').fill('오늘 업무회고 제거해줘');
  await page.locator('#saddf button[type=submit]').click();
  assert.equal(await page.locator('#actions .undo').count(), 0, 'a dated occurrence never silently deletes the whole recurring rule');
  assert.equal(await page.locator('#svoiceState').isVisible(), true, 'another pending action cannot hide command feedback');
  assert.match(await page.locator('#svoiceState').innerText(), /반복 전체/);
  await page.locator('#sadd').fill('#7 삭제해줘');
  await page.locator('#saddf button[type=submit]').click();
  assert.equal(await page.locator('#actions .undo[data-k="x|7"]').count(), 1);
  assert.match(await page.locator('#toast').innerText(), /반복 일정 전체/);
});

test('voice input replaces interim speech and only sends after explicit confirmation', async t => {
  const {page, requests} = await open(t, {}, {}, mockSpeech);
  await page.locator('#sadd').fill('내일');
  const mic = page.getByRole('button', {name: '음성으로 일정 입력', exact: true});
  assert.equal(await mic.count(), 1, 'the schedule input has a microphone button');
  await mic.click();
  assert.equal(await page.locator('#svoice').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#saddf button[type=submit]').isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => {
    const r = speechInstances[0];
    return {started: r.started, lang: r.lang, interim: r.interimResults, continuous: r.continuous};
  }), {started: true, lang: 'ko-KR', interim: true, continuous: false});
  await page.evaluate(() => speechInstances[0].emit('오후 세'));
  assert.equal(await page.locator('#sadd').inputValue(), '내일 오후 세');
  await page.evaluate(() => speechInstances[0].emit('오후 3시', '거래처 미팅'));
  assert.equal(await page.locator('#sadd').inputValue(), '내일 오후 3시 거래처 미팅');
  assert.equal(requests.some(r => r.url().includes('ntfy.sh')), false, 'speaking never saves an unreviewed schedule');
  if(process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'mobile-voice-listening.png')});
  await page.locator('#svoice').click();
  assert.equal(await page.evaluate(() => speechInstances[0].stopped), true, 'the same button stops listening');
  await page.evaluate(() => {speechInstances[0].emit('오후 3시', '거래처 미팅 #업무'); speechInstances[0].onend()});
  assert.equal(await page.locator('#svoice').getAttribute('aria-pressed'), 'false');
  await page.locator('#sadd').fill('내일 오후 3시 거래처 미팅 #미팅');
  await page.locator('#saddf button[type=submit]').click();
  await page.locator('#spend').waitFor({state: 'visible'});
  const actions = requests.filter(r => r.url().includes('ntfy.sh'));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].postDataJSON().text, '내일 오후 3시 거래처 미팅 #미팅');
});

test('typing, switching views and locking abort voice input and ignore late results', async t => {
  const {page} = await open(t, {}, {}, mockSpeech);
  await page.locator('#svoice').click();
  await page.evaluate(() => speechInstances[0].emit('중간 결과'));
  await page.locator('#sadd').fill('직접 고친 일정');
  assert.equal(await page.evaluate(() => speechInstances[0].aborted), true);
  await page.evaluate(() => speechInstances[0].emit('늦게 도착한 결과'));
  assert.equal(await page.locator('#sadd').inputValue(), '직접 고친 일정');
  await page.locator('#svoice').click();
  await page.locator('#tabM').click();
  await page.locator('#vMemo').waitFor({state: 'visible'});
  assert.equal(await page.evaluate(() => speechInstances[1].aborted), true);
  await page.evaluate(() => speechInstances[1].emit('다른 화면의 결과'));
  await page.locator('#tabS').click();
  await page.locator('#vSch').waitFor({state: 'visible'});
  assert.equal(await page.locator('#sadd').inputValue(), '직접 고친 일정');
  await page.locator('#svoice').click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {configurable: true, value: true});
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  assert.equal(await page.evaluate(() => speechInstances[2].aborted), true, 'backgrounding the app stops microphone use');
  await page.locator('#svoice').click();
  await page.evaluate(() => showLock());
  assert.equal(await page.evaluate(() => speechInstances[3].aborted), true);
  await page.evaluate(() => speechInstances[3].emit('잠금 뒤 결과'));
  assert.equal(await page.locator('#sadd').inputValue(), '직접 고친 일정');
});

test('voice errors and an unresponsive recognizer release controls without losing text', async t => {
  const {page} = await open(t, {}, {}, mockSpeech);
  await page.locator('#sadd').fill('남겨 둘 내용');
  for(const error of ['not-allowed', 'audio-capture', 'network', 'no-speech']) {
    await page.locator('#svoice').click();
    await page.evaluate(error => speechInstances.at(-1).onerror({error}), error);
    assert.equal(await page.locator('#svoice').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#saddf button[type=submit]').isDisabled(), false);
    assert.equal(await page.locator('#sadd').inputValue(), '남겨 둘 내용');
    assert.ok((await page.locator('#svoiceState').innerText()).length > 0);
  }
  await page.clock.install();
  await page.locator('#svoice').click();
  await page.clock.runFor(61000);
  assert.equal(await page.evaluate(() => speechInstances.at(-1).stopped), true);
  await page.clock.runFor(5500);
  assert.equal(await page.evaluate(() => speechInstances.at(-1).aborted), true);
  assert.equal(await page.locator('#saddf button[type=submit]').isDisabled(), false);
  assert.equal(await page.locator('#sadd').inputValue(), '남겨 둘 내용');
});

test('unsupported browsers and start failures keep manual entry available', async t => {
  for(const init of [
    () => {window.SpeechRecognition = window.webkitSpeechRecognition = undefined},
    () => {window.SpeechRecognition = class {start() {throw new Error('unavailable')} abort() {}}}
  ]) {
    const {page} = await open(t, {}, {}, init);
    await page.locator('#sadd').fill('직접 입력');
    await page.locator('#svoice').click();
    assert.equal(await page.locator('#svoice').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#saddf button[type=submit]').isDisabled(), false);
    assert.equal(await page.locator('#sadd').inputValue(), '직접 입력');
    assert.ok((await page.locator('#svoiceState').innerText()).length > 0);
  }
});

test('CG branding loads locally on the lock screen and app in both themes', async t => {
  const {page, requests} = await open(t);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({colorScheme});
    const logo = page.locator('#app .brand img');
    assert.equal(await logo.getAttribute('alt'), 'CG PLANER');
    assert.equal(await logo.evaluate(img => img.complete && img.naturalWidth > 0), true);
    assert.equal(await page.title(), 'CG PLANER');
  }
  assert.equal(await page.locator('#today').getAttribute('datetime'), today);
  assert.match(await page.locator('#today').getAttribute('aria-label'), /\d+년 \d+월 \d+일 [일월화수목금토]요일/);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'CG PLANER');
  assert.equal(manifest.short_name, 'CG PLANER');
  await page.reload();
  const lockLogo = page.locator('#lock img');
  await lockLogo.waitFor({state: 'visible'});
  assert.equal(await lockLogo.evaluate(img => img.complete && img.naturalWidth > 0), true);
  assert.equal(requests.some(request => request.url().includes('tailab9ee1.ts.net')), false, 'the brand must work without the private portfolio server');
});

test('the logo light flows without moving content and respects reduced motion', async t => {
  const {page} = await open(t);
  const mark = page.locator('.hero-mark');
  assert.equal(await mark.count(), 1, 'the background CG symbol has a light layer');
  assert.equal(await mark.getAttribute('aria-hidden'), 'true');
  const contentBefore = await page.locator('.date-heading').boundingBox();
  assert.ok(await mark.evaluate(el => el.getAnimations({subtree: true}).length) > 0);
  const period = await mark.evaluate(el => el.getAnimations({subtree: true}).find(animation => animation.animationName === 'logo-breeze').effect.getTiming().duration);
  assert.equal(period, 4000, 'the light repeats every four seconds');
  await mark.evaluate(el => el.getAnimations({subtree: true}).forEach(animation => {animation.pause(); animation.currentTime = 0}));
  const before = await mark.evaluate(el => getComputedStyle(el.querySelector('.mark-light'), '::before').transform);
  if (process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'allow', path: join(process.env.UI_SCREENSHOTS, 'mobile-logo-rest.png')});
  await mark.evaluate((el, period) => el.getAnimations({subtree: true}).forEach(animation => {animation.currentTime = period / 2}), period);
  const after = await mark.evaluate(el => getComputedStyle(el.querySelector('.mark-light'), '::before').transform);
  assert.notEqual(after, before, 'the highlight travels across the logo');
  assert.deepEqual(await page.locator('.date-heading').boundingBox(), contentBefore, 'decoration never moves the date or weather');
  if (process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'allow', path: join(process.env.UI_SCREENSHOTS, 'mobile-logo-breeze.png')});
  await page.locator('#wxb').click();
  assert.equal(await page.locator('#wxp').isVisible(), true, 'the decorative light never intercepts taps');
  await page.emulateMedia({reducedMotion: 'reduce'});
  assert.equal(await mark.evaluate(el => el.getAnimations({subtree: true}).length), 0);
  assert.equal(await mark.isVisible(), true, 'reduced motion keeps the static brand mark');
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

test('each schedule keeps its own draft when switching between editors', async t => {
  const {page} = await open(t);
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('첫 일정의 작성 중인 내용');
  await page.locator('#editDate').fill(day(2));
  await page.locator('#editTime').fill('17:30');
  await page.locator('#editCat').selectOption('개인');
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="2"]').click();
  assert.match(await page.locator('#editTitle').innerText(), /#2/);
  await page.locator('#editText').fill('둘째 일정의 작성 중인 내용');
  await page.keyboard.press('Escape');
  await page.locator('#tl .ed[data-id="1"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '첫 일정의 작성 중인 내용');
  assert.equal(await page.locator('#editDate').inputValue(), day(2));
  assert.equal(await page.locator('#editTime').inputValue(), '17:30');
  assert.equal(await page.locator('#editCat').inputValue(), '개인');
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="2"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '둘째 일정의 작성 중인 내용');
});

test('independent edits finish out of order without closing or overwriting another editor', async t => {
  const {page, requests} = await open(t);
  let release;
  const held = new Promise(resolve => {release = resolve});
  t.after(() => release());
  await page.context().route('https://ntfy.sh/**', async route => {
    if(route.request().postDataJSON().id === 1) await held;
    await route.fulfill({status: 200, body: '{}'});
  });
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('첫 번째 수정');
  await page.locator('#editSave').click();
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="2"]').click();
  assert.match(await page.locator('#editTitle').innerText(), /#2/, 'another edit can open while the first POST is still sending');
  await page.locator('#editText').fill('두 번째 수정');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  assert.equal(await page.locator('#actions .edit-resume').count(), 2);
  const commands = Object.fromEntries(requests.filter(r => r.url().includes('ntfy.sh')).map(r => [r.postDataJSON().id, JSON.parse(r.postDataJSON().text)]));
  const updated = structuredClone(fixture);
  updated.items[0].text = '첫 번째 수정';
  updated.edit_results = [{rid: commands[1].rid, id: 1, ok: true}];
  let blob = await encryptFixture(updated);
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.evaluate(() => reload());
  release();
  assert.equal(await page.locator('#editor').isVisible(), true);
  assert.match(await page.locator('#editTitle').innerText(), /#2/);
  assert.equal(await page.locator('#editText').inputValue(), '두 번째 수정');
  assert.equal(await page.locator('#editSave').isDisabled(), true, 'a different success never unlocks the pending editor');
  assert.equal(await page.locator('#actions .edit-resume[data-id="1"]').count(), 0);
  assert.equal(await page.locator('#actions .edit-resume[data-id="2"]').count(), 1);
  updated.items[1].text = '두 번째 수정';
  updated.edit_results.push({rid: commands[2].rid, id: 2, ok: true});
  blob = await encryptFixture(updated);
  await page.evaluate(() => reload());
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.equal(await page.locator('#actions').isVisible(), false);
  assert.match(await page.locator('#tl').innerText(), /첫 번째 수정/);
  assert.match(await page.locator('#tl').innerText(), /두 번째 수정/);
});

test('a rejected inactive edit stays discoverable and cannot alter a different draft', async t => {
  const {page, requests} = await open(t);
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('충돌해도 보관할 첫 일정');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="2"]').click();
  assert.match(await page.locator('#editTitle').innerText(), /#2/);
  await page.locator('#editText').fill('아직 보내지 않은 둘째 일정');
  await page.locator('#editClose').click();
  await page.locator('#tl .dn[data-id="1"]').click();
  assert.match(await page.locator('#editTitle').innerText(), /#1/, 'completion reopens the pending edit for the same schedule');
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 1);
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="2"]').click();
  const command = JSON.parse(requests.find(r => r.url().includes('ntfy.sh')).postDataJSON().text);
  const updated = structuredClone(fixture);
  updated.items[0].text = '텔레그램에서 먼저 수정한 내용';
  updated.items[0].edit.rev = 'd'.repeat(64);
  updated.edit_results = [{rid: command.rid, id: 1, ok: false, code: 'conflict', message: '다른 곳에서 먼저 바뀐 일정이에요.'}];
  const blob = await encryptFixture(updated);
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.evaluate(() => reload());
  assert.equal(await page.locator('#editText').inputValue(), '아직 보내지 않은 둘째 일정');
  assert.equal(await page.locator('#editState').innerText(), '');
  assert.equal(await page.locator('#editLatest').isVisible(), false);
  assert.equal(await page.locator('#editSave').isDisabled(), false);
  await page.locator('#editClose').click();
  await page.locator('#actions .edit-resume[data-id="1"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '충돌해도 보관할 첫 일정');
  assert.match(await page.locator('#editState').innerText(), /먼저 바뀐/);
  assert.equal(await page.locator('#editLatest').isVisible(), true);
  await page.locator('#editLatest').click();
  await page.waitForFunction(() => document.getElementById('editText').value === '텔레그램에서 먼저 수정한 내용');
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="2"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '아직 보내지 않은 둘째 일정');
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

test('each edit times out separately and a late success preserves newer unsent text', async t => {
  const {page, requests} = await open(t);
  await page.clock.install();
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('첫 요청으로 보낸 내용');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  await page.locator('#editClose').click();
  await page.clock.fastForward(61000);
  await page.locator('#tl .ed[data-id="2"]').click();
  await page.locator('#editText').fill('나중에 보낸 둘째 요청');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => document.querySelector('#actions .edit-resume[data-id="1"]').parentElement.textContent.includes('확인 필요'));
  assert.equal(await page.locator('#editSave').isDisabled(), true, 'the newer request keeps waiting for its own result');
  await page.locator('#editClose').click();
  await page.locator('#actions .edit-resume[data-id="1"]').click();
  assert.equal(await page.locator('#editSave').isDisabled(), false);
  await page.locator('#editText').fill(fixture.items[0].text);
  await page.locator('#editSave').click();
  assert.equal(await page.locator('#editor').isVisible(), true, 'reverting the draft cannot discard an unconfirmed request');
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 2);
  await page.locator('#editText').fill('늦은 결과 뒤에도 보관할 새 내용');
  await page.locator('#editClose').click();
  await page.locator('#actions .edit-resume[data-id="2"]').click();
  const first = JSON.parse(requests.find(r => r.url().includes('ntfy.sh')).postDataJSON().text);
  const updated = structuredClone(fixture);
  updated.items[0].text = '첫 요청으로 보낸 내용';
  updated.items[0].edit.rev = 'd'.repeat(64);
  updated.edit_results = [{rid: first.rid, id: 1, ok: true}];
  let blob = await encryptFixture(updated);
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.evaluate(() => reload());
  assert.match(await page.locator('#editTitle').innerText(), /#2/);
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="1"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '늦은 결과 뒤에도 보관할 새 내용');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  const latest = JSON.parse(requests.filter(r => r.url().includes('ntfy.sh')).at(-1).postDataJSON().text);
  assert.equal(latest.rev, updated.items[0].edit.rev, 'a newer draft is compared with the version that was actually saved');
  assert.deepEqual(latest.changes, {text: '늦은 결과 뒤에도 보관할 새 내용'});
  await page.clock.fastForward(121000);
  await page.waitForFunction(() => !document.getElementById('editSave').disabled);
  await page.locator('#editText').fill('열린 창에서 계속 고친 내용');
  updated.items[0].text = latest.changes.text;
  updated.items[0].edit.rev = 'e'.repeat(64);
  updated.edit_results.push({rid: latest.rid, id: 1, ok: true});
  blob = await encryptFixture(updated);
  await page.evaluate(() => reload());
  assert.equal(await page.locator('#editor').isVisible(), true);
  assert.equal(await page.locator('#editText').inputValue(), '열린 창에서 계속 고친 내용', 'a receipt cannot discard text being typed in the open editor');
  assert.equal(await page.locator('#editSave').isDisabled(), false);
  assert.match(await page.locator('#editState').innerText(), /저장 전/);
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

test('a delivery failure for a closed editor preserves its draft and retry identity', async t => {
  const {page, requests} = await open(t);
  let release;
  const held = new Promise(resolve => {release = resolve});
  t.after(() => release());
  await page.context().route('https://ntfy.sh/**', async route => {await held; await route.fulfill({status: 503, body: ''})});
  await page.locator('#tl .ed[data-id="1"]').click();
  await page.locator('#editText').fill('전송 실패해도 보관할 내용');
  await page.locator('#editSave').click();
  await page.locator('#editClose').click();
  await page.locator('#tl .ed[data-id="2"]').click();
  await page.locator('#editText').fill('실패 응답과 무관한 새 초안');
  release();
  await page.waitForFunction(() => document.querySelector('#actions .edit-resume[data-id="1"]').parentElement.textContent.includes('확인 필요'));
  assert.equal(await page.locator('#editState').innerText(), '');
  assert.equal(await page.locator('#editSave').isDisabled(), false);
  assert.equal(await page.locator('#editText').inputValue(), '실패 응답과 무관한 새 초안');
  await page.locator('#editClose').click();
  await page.locator('#actions .edit-resume[data-id="1"]').click();
  assert.match(await page.locator('#editState').innerText(), /전송을 확인하지 못/);
  assert.equal(await page.locator('#editText').inputValue(), '전송 실패해도 보관할 내용');
  const first = JSON.parse(requests.find(r => r.url().includes('ntfy.sh')).postDataJSON().text);
  await page.context().route('https://ntfy.sh/**', route => route.fulfill({status: 200, body: '{}'}));
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  const retried = JSON.parse(requests.filter(r => r.url().includes('ntfy.sh')).at(-1).postDataJSON().text);
  assert.equal(retried.rid, first.rid);
});

test('a stalled data refresh cannot leave independent editors locked indefinitely', async t => {
  const {page, requests} = await open(t);
  await page.clock.install();
  for(const id of [1, 2]) {
    await page.locator('#tl .ed[data-id="' + id + '"]').click();
    await page.locator('#editText').fill('연결이 끊겨도 남을 내용 ' + id);
    await page.locator('#editSave').click();
    await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
    await page.locator('#editClose').click();
  }
  if(process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'multiple-edits-waiting.png')});
  let release;
  const held = new Promise(resolve => {release = resolve});
  t.after(() => release());
  const blob = await encryptFixture(fixture);
  await page.context().route('**/data.enc.json?*', async route => {await held; await route.fulfill({contentType: 'application/json', body: blob})});
  const loading = page.waitForRequest('**/data.enc.json?*');
  await page.clock.runFor(3100);
  await loading;
  await page.clock.runFor(16000);
  await page.clock.fastForward(125000);
  await page.clock.runFor(16000);
  await page.waitForFunction(() => [...document.querySelectorAll('#actions .edit-resume')].every(el => el.parentElement.textContent.includes('확인 필요')), null, {timeout: 1500});
  for(const id of [1, 2]) {
    await page.locator('#actions .edit-resume[data-id="' + id + '"]').click();
    assert.equal(await page.locator('#editText').inputValue(), '연결이 끊겨도 남을 내용 ' + id);
    assert.equal(await page.locator('#editSave').isDisabled(), false);
    await page.locator('#editClose').click();
  }
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 2, 'a refresh timeout never resends edits automatically');
});

test('a stalled unlock offers a clear retry after the data request times out', async t => {
  const {page} = await open(t);
  await page.reload();
  await page.locator('#lock').waitFor({state: 'visible'});
  await page.clock.install();
  let release;
  const held = new Promise(resolve => {release = resolve});
  t.after(() => release());
  const blob = await encryptFixture(fixture);
  await page.context().route('**/data.enc.json?*', async route => {await held; await route.fulfill({contentType: 'application/json', body: blob})});
  await page.locator('#pw').fill('preview');
  const loading = page.waitForRequest('**/data.enc.json?*');
  await page.locator('#go').click();
  await loading;
  await page.clock.runFor(16000);
  await page.waitForFunction(() => !document.getElementById('go').disabled);
  assert.match(await page.locator('#err').innerText(), /연결.*지연/);
  assert.equal(await page.locator('#app').isVisible(), false);
  release();
  await page.context().unroute('**/data.enc.json?*');
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
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
  await page.locator('#tl .ed[data-id="2"]').click();
  await page.locator('#editText').fill('함께 지워야 할 다른 초안');
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
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  for(const id of [1, 2]) {
    await page.locator('#tl .ed[data-id="' + id + '"]').click();
    assert.equal(await page.locator('#editText').inputValue(), fixture.items[id - 1].text, 'unlocking again never restores a discarded draft');
    await page.locator('#editClose').click();
  }
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
  for(const width of [320, 390]) {
    await page.setViewportSize({width, height: 844});
    const heading = await page.locator('#wkl .wd.today .wdh b').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const lines = [...range.getClientRects()];
      const column = el.parentElement.getBoundingClientRect();
      return {lines: lines.length, fits: lines.every(rect => rect.right <= column.right + 1)};
    });
    assert.deepEqual(heading, {lines: 1, fits: true}, 'the current weekday and Today label stay together inside their phone column');
  }
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

test('a late older refresh cannot restore schedules removed by a newer snapshot', async t => {
  const {page} = await open(t);
  const newer = structuredClone(fixture);
  newer.items = newer.items.filter(x => ![1, 2].includes(x.id));
  const oldBlob = await encryptFixture(fixture), newBlob = await encryptFixture(newer);
  let release, started;
  const held = new Promise(resolve => {release = resolve});
  const firstStarted = new Promise(resolve => {started = resolve});
  t.after(() => release());
  let count = 0;
  await page.context().route('**/data.enc.json?*', async route => {
    const first = ++count === 1;
    if(first) {started(); await held}
    await route.fulfill({contentType: 'application/json', body: first ? oldBlob : newBlob});
  });
  await page.evaluate(() => {window.olderRefresh = reload()});
  await firstStarted;
  await page.evaluate(() => reload());
  assert.equal(await page.locator('#tl .dn[data-id="1"], #tl .dn[data-id="2"]').count(), 0);
  release();
  await page.evaluate(() => olderRefresh);
  assert.equal(await page.locator('#tl .dn[data-id="1"], #tl .dn[data-id="2"]').count(), 0, 'a late snapshot cannot resurrect completed or deleted schedules');
});

test('a failed newer refresh does not discard a valid response still on the way', async t => {
  const {page} = await open(t);
  const updated = structuredClone(fixture);
  updated.items = updated.items.filter(x => x.id !== 1);
  const blob = await encryptFixture(updated);
  let release, started;
  const held = new Promise(resolve => {release = resolve});
  const firstStarted = new Promise(resolve => {started = resolve});
  t.after(() => release());
  let count = 0;
  await page.context().route('**/data.enc.json?*', async route => {
    if(++count !== 1) return route.fulfill({status: 503, body: ''});
    started(); await held;
    await route.fulfill({contentType: 'application/json', body: blob});
  });
  await page.evaluate(() => {window.validRefresh = reload()});
  await firstStarted;
  await page.evaluate(() => reload());
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 1, 'a failed refresh leaves the current screen usable');
  release();
  await page.evaluate(() => validRefresh);
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 0, 'a valid response remains usable when a later request failed');
});

test('completion keeps the selected occurrence date across reload and supports legacy servers', async t => {
  for(const supported of [true, false]) {
    const payload = {...fixture, done_dates: supported ? 1 : undefined};
    const {page, requests} = await open(t, {}, {payload});
    await page.clock.install();
    await page.locator('#nl .dn[data-id="4"]').click();
    await page.reload();
    await page.locator('#pw').fill('preview');
    await page.locator('#go').click();
    await page.locator('#app').waitFor({state: 'visible'});
    await page.clock.runFor(5500);
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'));
    const action = requests.find(r => r.url().includes('ntfy.sh')).postDataJSON();
    assert.equal(action.a, 'done');
    assert.equal(action.id, 4);
    assert.equal(action.text || '', supported ? day(1) : '', 'the signed request keeps the date selected before reopening');
  }
});

test('browser completion saves the selected recurring occurrence even with older unfinished work', {skip: !process.env.SCHEDULE_BOT_DIR}, async t => {
  const {execFileSync} = require('node:child_process');
  const bridge = input => JSON.parse(execFileSync('python', [join(__dirname, 'edit_bridge.py')], {input: JSON.stringify({...input, today}), encoding: 'utf8', env: {...process.env, PYTHONIOENCODING: 'utf-8'}}));
  const wd = (new Date(day(1) + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const db = {next_id: 2, items: [{id: 1, kind: 'weekly', wd, text: '회차별 반복 업무', cat: '업무', added: day(-21)}]};
  const initial = bridge({db});
  const payload = {...initial.payload, wx: fixture.wx, done: fixture.done, updated: fixture.updated};
  const {page, requests} = await open(t, {}, {payload});
  assert.equal(await page.locator('#odl .dn[data-id="1"]').count(), 1, 'an older unfinished occurrence exists');
  await page.clock.install();
  await page.locator('#nl .dn[data-id="1"]').click();
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'));
  const body = requests.find(r => r.url().includes('ntfy.sh')).postDataJSON();
  const saved = bridge({db: initial.db, body});
  assert.equal(saved.db.items[0].done_until, day(1), 'the real bot completes the selected tomorrow occurrence');
  assert.equal(saved.db.done_log[0].day, today);
  const blob = await encryptFixture({...payload, ...saved.payload});
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.evaluate(() => reload());
  assert.equal(await page.locator('#nl .dn[data-id="1"]').count(), 0, 'the saved result agrees with the optimistic completion');
});

test('completion can be undone and adding keeps the signed request flow', async t => {
  const {page, requests} = await open(t);
  await page.locator('#tl .dn[data-id="1"]').click();
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 0);
  await page.locator('#actions .undo').click();
  assert.equal(await page.locator('#tl .dn[data-id="1"]').count(), 1);
  await page.locator('#sadd').fill('내일 자료 검토 #업무');
  await page.locator('#saddf button[type=submit]').click();
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
    await page.locator('#' + form + ' button[type=submit]').click();
    if(form === 'saddf') assert.equal(await page.locator('#svoice').isDisabled(), true, 'recognition cannot overwrite an addition that is being sent');
    await page.locator('#' + input).fill('다음에 보낼 내용');
    release();
    await page.waitForFunction(id => !document.querySelector('#' + id + ' button[type=submit]').disabled, form);
    if(form === 'saddf') assert.equal(await page.locator('#svoice').isDisabled(), false);
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

test('accepted completion, snooze and deletion stay visible until a fresh snapshot confirms them', async t => {
  for(const [action, selector] of [['done', '#tl .dn[data-id="1"]'], ['snooze', '#tl .sn[data-id="1"]'], ['del', '#ml2 .rm[data-id="8"]']]) {
    const {page, requests} = await open(t);
    if(action === 'del') await page.locator('#tabM').click();
    await page.clock.install();
    await page.locator(selector).click();
    await page.clock.runFor(5500);
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'));
    assert.equal(await page.locator('#actions').isVisible(), true, 'transport acceptance is not yet a saved result');
    assert.match(await page.locator('#actions').innerText(), /반영 확인 중/);
    assert.equal(await page.locator('#actions .undo').count(), 0, 'a transmitted action cannot be undone locally');
    if(process.env.UI_SCREENSHOTS && action === 'done') await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'pending-confirmation.png')});
    let checks = 0, blob = await encryptFixture(fixture);
    await page.context().route('**/data.enc.json?*', route => {checks++; return route.fulfill({contentType: 'application/json', body: blob})});
    await page.clock.runFor(3500);
    await page.waitForFunction(() => refreshApplied > 0);
    assert.match(await page.locator('#actions').innerText(), /반영 확인 중/, 'an unchanged snapshot does not confirm the action');
    const updated = structuredClone(fixture);
    if(action === 'done') updated.items[0].done = true;
    if(action === 'snooze') updated.items[0].date = day(1);
    if(action === 'del') updated.memos = [];
    blob = await encryptFixture(updated);
    await page.clock.runFor(5500);
    await page.locator('#actions').waitFor({state: 'hidden'});
    const count = checks;
    await page.clock.runFor(12000);
    assert.equal(checks, count, 'confirmation stops the extra polling');
    assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 1, 'confirmation checks never repeat the action');
  }
});

test('accepted actions resume result checks after reload and offer a read-only manual check', async t => {
  const {page, requests} = await open(t);
  await page.clock.install();
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'));
  const other = await page.context().newPage();
  const otherPosts = [];
  other.on('request', r => {if(r.url().includes('ntfy.sh')) otherPosts.push(r)});
  await other.goto(base);
  await other.locator('#pw').fill('preview');
  await other.locator('#go').click();
  await other.locator('#app').waitFor({state: 'visible'});
  assert.match(await other.locator('#actions').innerText(), /변경 반영 확인 중/, 'a new page also explains the locally pending state');
  await page.reload();
  await page.locator('#pw').fill('preview');
  await page.locator('#go').click();
  await page.locator('#app').waitFor({state: 'visible'});
  assert.match(await page.locator('#actions').innerText(), /반영 확인 중/);
  await page.clock.runFor(5500);
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 1);
  const check = page.getByRole('button', {name: '#1 반영 다시 확인', exact: true});
  await check.focus();
  const before = await page.evaluate(() => refreshApplied);
  await check.press('Enter');
  await page.waitForFunction(previous => refreshApplied > previous, before);
  assert.equal(await check.evaluate(el => el === document.activeElement), true, 'an unchanged result check preserves keyboard focus');
  const updated = structuredClone(fixture);
  updated.items = updated.items.filter(x => x.id !== 1);
  const blob = await encryptFixture(updated);
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.getByRole('button', {name: '#1 반영 다시 확인', exact: true}).click();
  await page.locator('#actions').waitFor({state: 'hidden'});
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 1);
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('schedule-actions'))).length), 0);
  await other.getByRole('button', {name: '#1 반영 다시 확인', exact: true}).click();
  await other.locator('#actions').waitFor({state: 'hidden'});
  assert.equal(otherPosts.length, 0);
});

test('finishing an edit does not cancel a different completion result check', async t => {
  const {page, requests} = await open(t);
  await page.clock.install();
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'));
  await page.locator('#tl .ed[data-id="2"]').click();
  await page.locator('#editText').fill('완료와 따로 확인할 수정');
  await page.locator('#editSave').click();
  await page.waitForFunction(() => document.getElementById('editState').textContent.includes('반영 결과'));
  const command = JSON.parse(requests.find(r => r.url().includes('ntfy.sh') && r.postDataJSON().a === 'edit').postDataJSON().text);
  const updated = structuredClone(fixture);
  updated.items[1].text = command.changes.text;
  updated.edit_results = [{rid: command.rid, id: 2, ok: true}];
  let blob = await encryptFixture(updated);
  await page.context().route('**/data.enc.json?*', route => route.fulfill({contentType: 'application/json', body: blob}));
  await page.clock.runFor(3500);
  await page.locator('#editor').waitFor({state: 'hidden'});
  assert.match(await page.locator('#actions').innerText(), /#1 완료 반영 확인 중/);
  updated.items[0].done = true;
  blob = await encryptFixture(updated);
  await page.clock.runFor(5500);
  await page.locator('#actions').waitFor({state: 'hidden'});
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 2);
});

test('delayed confirmation backs off and eventually releases an unconfirmed optimistic state', async t => {
  const {page, requests} = await open(t, {viewport: {width: 320, height: 568}});
  await page.clock.install();
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'));
  let reads = 0;
  await page.context().route('**/data.enc.json?*', route => {reads++; return route.fulfill({status: 503, body: ''})});
  await page.clock.fastForward(121000);
  await page.waitForFunction(() => document.getElementById('actions').textContent.includes('확인 지연'));
  const check = page.getByRole('button', {name: '#1 반영 다시 확인', exact: true});
  const box = await check.boundingBox();
  assert.ok(box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= 320, 'the delayed status keeps its check button usable on phones');
  if(process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'delayed-confirmation.png')});
  const previous = reads;
  await page.clock.runFor(15000);
  assert.equal(reads, previous, 'a delayed confirmation no longer polls every few seconds');
  const polled = page.waitForResponse('**/data.enc.json?*');
  await page.clock.runFor(16000);
  await polled;
  assert.ok(reads > previous);
  await page.clock.fastForward(900000);
  await page.waitForFunction(() => document.getElementById('actions').hidden && document.querySelector('#tl .dn[data-id="1"]'));
  assert.match(await page.locator('#toast').innerText(), /반영을 확인하지 못/);
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 1, 'even a long outage never automatically repeats a completion');
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
  await page.locator('#saddf button[type=submit]').click();
  await sent;
  await page.clock.runFor(16000);
  assert.equal(await page.locator('#saddf button[type=submit]').isDisabled(), false, 'stalled requests do not leave the form locked');
  assert.equal(await page.locator('#sadd').inputValue(), '끊겨도 남아 있어야 할 내용');
  assert.equal(await page.locator('#svoiceState').isVisible(), true);
  assert.match(await page.locator('#svoiceState').innerText(), /이미 등록됐는지/);
});

test('multiple delivery errors stay visible beside another action and survive its success notice', async t => {
  const {page, requests} = await open(t, {viewport: {width: 320, height: 568}});
  await page.clock.install();
  let release;
  const held = new Promise(resolve => {release = resolve});
  t.after(() => release());
  await page.context().route('https://ntfy.sh/**', async route => {
    if(route.request().postDataJSON().id !== 3) return route.fulfill({status: 503, body: ''});
    await held;
    await route.fulfill({status: 200, body: '{}'});
  });
  for(const id of [1, 2, 3]) await page.locator('#tl .dn[data-id="' + id + '"]').click();
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('#2 완료'));
  const notice = page.locator('#actions .action-error');
  assert.equal(await notice.isVisible(), true, 'errors remain readable while the action panel hides the ordinary toast');
  assert.match(await notice.innerText(), /#1 완료/);
  assert.match(await notice.innerText(), /#2 완료/);
  assert.equal(await page.locator('#tl .dn[data-id="1"], #tl .dn[data-id="2"]').count(), 2);
  release();
  await page.waitForFunction(() => document.getElementById('actions').textContent.includes('#3 완료 반영 확인 중'));
  assert.match(await notice.innerText(), /#1 완료/);
  assert.match(await notice.innerText(), /#2 완료/);
  const box = await notice.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 320 && box.y >= 0 && box.y + box.height <= 568, 'the error messages fit the phone viewport');
  if(process.env.UI_SCREENSHOTS) await page.screenshot({animations: 'disabled', path: join(process.env.UI_SCREENSHOTS, 'simultaneous-action-errors.png')});
  await page.clock.runFor(8500);
  assert.equal(await notice.count(), 0, 'the error notice expires without removing the remaining result check');
  assert.match(await page.locator('#actions').innerText(), /#3 완료 반영 확인 중/);
  assert.equal(requests.filter(r => r.url().includes('ntfy.sh')).length, 3);
});

test('an expired result check remains readable beside an unsent edit draft', async t => {
  const {page} = await open(t);
  await page.clock.install();
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('보냈어요'));
  await page.locator('#tl .ed[data-id="2"]').click();
  await page.locator('#editText').fill('오류가 나도 보관할 다른 수정 초안');
  await page.locator('#editClose').click();
  await page.clock.fastForward(900001);
  await page.waitForFunction(() => document.querySelector('#tl .dn[data-id="1"]'));
  assert.equal(await page.locator('#actions .action-error').isVisible(), true);
  assert.match(await page.locator('#actions .action-error').innerText(), /#1.*반영을 확인하지 못/);
  assert.match(await page.locator('#actions').innerText(), /#2 수정 작성 중/);
  await page.locator('#actions .edit-resume[data-id="2"]').click();
  assert.equal(await page.locator('#editText').inputValue(), '오류가 나도 보관할 다른 수정 초안');
});

test('failed action delivery restores the task and clears the pending undo state', async t => {
  const {page} = await open(t);
  await page.clock.install();
  await page.context().route('https://ntfy.sh/**', route => route.fulfill({status: 503, body: ''}));
  await page.locator('#tl .dn[data-id="1"]').click();
  await page.clock.runFor(5500);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('전송을 확인하지 못'), null, {timeout: 1500});
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
        const rgb = color.slice(0, 3).map(x => {
          const n = Number(x) / 255;
          return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      return ['#saddf button[type=submit]', '#svoice', '.date-weekday', '#wxb', '#tl .dn', '#tl .pill'].map(selector => {
        const el = document.querySelector(selector), style = getComputedStyle(el);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(0, 0, 1, 1);
        const layers = [];
        for(let parent = el; parent; parent = parent.parentElement) layers.unshift(parent);
        for(const layer of layers) {context.fillStyle = getComputedStyle(layer).backgroundColor; context.fillRect(0, 0, 1, 1)}
        const a = luminance(style.color.match(/[\d.]+/g).slice(0, 3).map(Number)), b = luminance(Array.from(context.getImageData(0, 0, 1, 1).data));
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

test('audit fixes: short deletion dates follow addition month and year rules', async t => {
  const payload=structuredClone(fixture);
  payload.items=[{id:46,date:'2026-10-20',k:'o',text:'책 반납하기',c:'개인'}, {id:47,date:'2026-11-20',k:'o',text:'책 반납하기',c:'개인'}, {id:48,date:'2027-01-20',k:'o',text:'책 반납하기',c:'개인'}];
  const {page}=await open(t,{}, {payload});
  assert.equal(await page.evaluate(()=>{T='2026-10-21';return deleteTarget('20일 책 반납하기 삭제해줘').id}),47);
  assert.equal(await page.evaluate(()=>deleteTarget('2026년 10월 20일 책 반납하기 삭제해줘').id),46);
  assert.equal(await page.evaluate(()=>{T='2026-12-21';return deleteTarget('20일 책 반납하기 삭제해줘').id}),48);
  assert.equal(await page.evaluate(()=>deleteTarget('1월 20일 책 반납하기 삭제해줘').id),48);
});

test('audit fixes: daily and weekday rules are editable and never overdue', async t => {
  const payload=structuredClone(fixture);
  payload.items=[{id:21,date:day(-1),kind:'daily',k:'d',text:'매일 운동',c:'개인',added:day(-10),edit:{rev:'a'.repeat(64),kind:'daily',memo:false}}, {id:22,date:today,kind:'weekdays',k:'w',text:'평일 업무',c:'업무',added:day(-10),edit:{rev:'b'.repeat(64),kind:'weekdays',memo:false}}, {id:22,date:day(-2),kind:'weekdays',k:'w',text:'평일 업무',c:'업무',added:day(-10)}];
  const {page,requests}=await open(t,{}, {payload});
  assert.equal(await page.locator('#od').isVisible(),false);
  assert.match(await page.locator('#tl').innerText(),/평일/);
  assert.doesNotMatch(await page.locator('#tl .mt').innerText(),/매주/);
  await page.locator('#tl .ed[data-id="22"]').click();
  assert.equal(await page.locator('#editDate').isVisible(),false);
  await page.locator('#editTime').fill('10:30');await page.locator('#editSave').click();
  await page.waitForFunction(()=>document.getElementById('editState').textContent.includes('반영 결과'));
  assert.deepEqual(JSON.parse(requests.find(r=>r.url().includes('ntfy.sh')).postDataJSON().text).changes,{time:'10:30'});
});

test('audit fixes: additions wait for their receipt and keep failures after reload', async t => {
  const payload={...structuredClone(fixture),add_receipts:1,add_results:[]};
  const {page,requests}=await open(t,{}, {payload});
  await page.locator('#sadd').fill('내일 주간 업무 계획 정리');await page.locator('#saddf button[type=submit]').click();
  await page.waitForFunction(()=>!document.querySelector('#saddf button[type=submit]').disabled);
  const body=requests.find(r=>r.url().includes('ntfy.sh')).postDataJSON();assert.equal(body.a,'create');
  const command=JSON.parse(body.text);assert.match(command.rid,/^[a-f0-9-]{36}$/);
  await page.evaluate(()=>render());assert.equal(await page.locator('#spend').isVisible(),true,'old same-title task is not a receipt');
  payload.add_results=[{rid:command.rid,ok:false,message:'날짜를 확인해 주세요.'}];
  let blob=await encryptFixture(payload);
  await page.context().route('**/data.enc.json?*',route=>route.fulfill({contentType:'application/json',body:blob}));
  await page.evaluate(()=>reload());assert.match(await page.locator('#spend').innerText(),/날짜를 확인/);
  await page.reload();await page.locator('#pw').fill('preview');await page.locator('#go').click();await page.locator('#app').waitFor({state:'visible'});
  assert.match(await page.locator('#spend').innerText(),/날짜를 확인/);
  await page.locator('#spend .add-restore').click();assert.equal(await page.locator('#sadd').inputValue(),'내일 주간 업무 계획 정리');
});

test('audit fixes: unconfirmed addition survives timeout and retry keeps identity', async t => {
  const payload={...structuredClone(fixture),add_receipts:1,add_results:[]};
  const {page,requests}=await open(t,{}, {payload});await page.clock.install();
  await page.context().route('https://ntfy.sh/**',route=>route.fulfill({status:503,body:''}));
  await page.locator('#sadd').fill('내일 새 일정');await page.locator('#saddf button[type=submit]').click();
  await page.waitForFunction(()=>!document.querySelector('#saddf button[type=submit]').disabled);
  let posts=requests.filter(r=>r.url().includes('ntfy.sh'));const first=JSON.parse(posts[0].postDataJSON().text);
  await page.clock.fastForward(601000);assert.equal(await page.locator('#spend').isVisible(),true);
  await page.context().route('https://ntfy.sh/**',route=>route.fulfill({status:200,body:'{}'}));
  await page.locator('#saddf button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#saddf button[type=submit]').disabled);
  posts=requests.filter(r=>r.url().includes('ntfy.sh'));assert.equal(JSON.parse(posts.at(-1).postDataJSON().text).rid,first.rid);
  const blob=await encryptFixture({...payload,add_results:[{rid:first.rid,ok:true,id:90}]});
  await page.context().route('**/data.enc.json?*',route=>route.fulfill({contentType:'application/json',body:blob}));
  await page.evaluate(()=>reload());assert.equal(await page.locator('#spend').isVisible(),false);
});

test('audit fixes: failed push registration remains reconnectable until bot confirms', async t => {
  const payload={...fixture,push:{key:'AA',registered:[]}};
  const {page}=await open(t,{}, {payload},()=>{
    let subscription=null;
    const reg={pushManager:{getSubscription:async()=>subscription,subscribe:async()=>subscription={endpoint:'https://push.invalid/test',keys:{p256dh:'fake',auth:'fake'}}}};
    Object.defineProperty(navigator,'serviceWorker',{value:{getRegistration:async()=>reg,register:async()=>reg,ready:Promise.resolve(reg)}});
    Object.defineProperty(window,'PushManager',{value:class {}});
    Object.defineProperty(window,'Notification',{value:class {static permission='granted';static async requestPermission(){return 'granted'}}});
  });
  await page.context().route('https://ntfy.sh/**',route=>route.fulfill({status:503,body:''}));
  await page.locator('#pushb').click();await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('켜지 못'));
  await page.evaluate(()=>pushState());assert.equal(await page.locator('#pushc').isVisible(),true);
  await page.context().route('https://ntfy.sh/**',route=>route.fulfill({status:200,body:'{}'}));
  await page.locator('#pushb').click();await page.evaluate(()=>pushState());assert.equal(await page.locator('#pushc').isVisible(),true);
  const {createHash}=require('node:crypto');payload.push.registered=[createHash('sha256').update('https://push.invalid/test').digest('hex')];
  const blob=await encryptFixture(payload);await page.context().route('**/data.enc.json?*',route=>route.fulfill({contentType:'application/json',body:blob}));
  await page.evaluate(()=>reload());await page.locator('#pushc').waitFor({state:'hidden'});
});

test('audit fixes: stalled weather releases a working retry button', async t => {
  const {page}=await open(t);await page.clock.install();
  await page.context().route('https://api.open-meteo.com/**',()=>{});
  await page.evaluate(()=>{void loadWeather()});await page.clock.runFor(16000);
  assert.equal(await page.locator('#wxb').isDisabled(),false);assert.match(await page.locator('#wxb').innerText(),/다시/);
  await page.context().route('https://api.open-meteo.com/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(weatherFixture)}));
  await page.locator('#wxb').click();await page.waitForFunction(()=>document.getElementById('wxb').textContent.includes('18°'));
});

test('audit fixes: deleting a recurring rule updates hero counts and rule card immediately', async t => {
  const payload=structuredClone(fixture);payload.items.push({id:7,date:today,k:'w',text:'업무 회고',c:'업무'});
  const {page}=await open(t,{}, {payload});await page.clock.install();
  const before=Number(await page.locator('#s1').innerText());
  await page.locator('#sadd').fill('#7 삭제해줘');await page.locator('#saddf button[type=submit]').click();
  assert.equal(Number(await page.locator('#s1').innerText()),before-1);assert.equal(await page.locator('#rn').innerText(),'0');
  assert.doesNotMatch(await page.locator('#rl').textContent(),/#7/);
  await page.locator('#actions .undo').click();assert.equal(Number(await page.locator('#s1').innerText()),before);assert.equal(await page.locator('#rn').innerText(),'1');
});

test('memo weather follows current rain and snow and stays out of the input path', async t => {
  for (const [code, effect] of [[61, 'rain'], [85, 'snow'], [0, ''], [45, '']]) {
    const {page} = await open(t, {}, {fixture: {...weatherFixture, current: {...weatherFixture.current, weather_code: code}}});
    await page.locator('#tabM').click();
    assert.equal(await page.locator('#memoWeather').count(), 1, 'memo weather layer exists');
    assert.equal(await page.locator('#memoWeather').getAttribute('data-weather'), effect);
    assert.equal(await page.locator('#memoWeather').getAttribute('aria-hidden'), 'true');
    await page.locator('#madd').fill('날씨 효과 중에도 메모 입력');
    assert.equal(await page.locator('#madd').inputValue(), '날씨 효과 중에도 메모 입력');
    if (effect) {
      assert.equal(await page.locator('#memoWeather').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
      if (process.env.UI_SCREENSHOTS) await page.screenshot({path: join(process.env.UI_SCREENSHOTS, `memo-${effect}.png`)});
      await page.locator('#memoWeatherToggle').click();
      assert.equal(await page.locator('#memoWeather').isVisible(), false);
      await page.locator('#memoWeatherToggle').click();
      assert.equal(await page.locator('#memoWeather').isVisible(), true);
    }
  }
});

test('memo precipitation stops for reduced motion and clears after weather failure', async t => {
  const {page} = await open(t, {reducedMotion: 'reduce'}, {fixture: {...weatherFixture, current: {...weatherFixture.current, weather_code: 73}}});
  await page.locator('#tabM').click();
  await page.locator('#vMemo').waitFor({state:'visible'});
  assert.equal(await page.locator('#memoWeather').count(), 1, 'memo weather layer exists');
  assert.equal(await page.locator('#memoWeather').isVisible(), false);
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.locator('#memoWeather').waitFor({state:'visible'});
  assert.equal(await page.locator('#memoWeather').isVisible(), true);
  await page.route('https://api.open-meteo.com/**', route => route.fulfill({status: 503}));
  await page.evaluate(() => loadWeather());
  assert.equal(await page.locator('#memoWeather').getAttribute('data-weather'), '');
  assert.equal(await page.locator('#memoWeatherToggle').isVisible(), false);
});

test('schedule weather shares the memo toggle and never blocks schedule controls', async t => {
  const {page}=await open(t,{}, {fixture:{...weatherFixture,current:{...weatherFixture.current,weather_code:61}}});
  assert.equal(await page.locator('#scheduleWeather').count(),1);
  assert.equal(await page.locator('#scheduleWeather').isVisible(),true);
  await page.locator('#sadd').fill('내일 비 오는 날 준비');
  await page.locator('#modeMonth').click();
  assert.equal(await page.locator('#monthPanel').isVisible(),true);
  if(process.env.UI_SCREENSHOTS) await page.screenshot({path:join(process.env.UI_SCREENSHOTS,'schedule-rain.png')});
  await page.locator('#scheduleWeatherToggle').click();
  assert.equal(await page.locator('#scheduleWeather').isVisible(),false);
  await page.locator('#tabM').click();
  assert.equal(await page.locator('#memoWeather').isVisible(),false);
  await page.locator('#memoWeatherToggle').click();
  await page.locator('#tabS').click();
  assert.equal(await page.locator('#scheduleWeather').isVisible(),true);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>getComputedStyle(document.getElementById('scheduleWeather')).display==='none');
  assert.equal(await page.locator('#scheduleWeather').isVisible(),false);
});
