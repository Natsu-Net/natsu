import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
p.on('console', m => console.log('  [browser]', m.text()));
p.on('pageerror', e => console.log('  [pageerror]', e.message));
await p.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });

const first = await p.textContent('#online');
console.log('initial online:', first);

// server pushes bump() every 300ms; wait for the text to change with no reload
await p.waitForFunction(
  (prev) => document.getElementById('online').textContent !== prev,
  first, { timeout: 5000 }
);
const second = await p.textContent('#online');
console.log('after server push:', second, '->', Number(second) > Number(first) ? 'PASS' : 'FAIL');

// client-initiated action: click bump (args [5])
const before = Number(await p.textContent('#online'));
await p.click('#bump');
await p.waitForFunction((n) => Number(document.getElementById('online').textContent) >= n + 5, before, { timeout: 5000 });
console.log('after client action:  PASS (jumped >= +5 from', before + ')');

// confirm no full reload happened: mark the document and re-check
await p.evaluate(() => (window.__marker = 'alive'));
await p.waitForTimeout(700);
const marker = await p.evaluate(() => window.__marker);
console.log('no reload during patches:', marker === 'alive' ? 'PASS' : 'FAIL');

// writable field enforcement: topic is writable, online is not
await p.evaluate(() => window.__uwu.socket.send(JSON.stringify({t:'set', store:'room', key:'topic', value:'changed-by-client'})));
await p.waitForFunction(() => document.getElementById('topic').textContent === 'changed-by-client', null, { timeout: 5000 });
console.log('writable field accepted: PASS');

const onlineBefore = await p.textContent('#online');
await p.evaluate(() => window.__uwu.socket.send(JSON.stringify({t:'set', store:'room', key:'online', value:99999})));
await p.waitForTimeout(600);
const onlineAfter = Number(await p.textContent('#online'));
console.log('read-only field refused:', onlineAfter !== 99999 ? 'PASS' : 'FAIL', `(${onlineBefore} -> ${onlineAfter})`);

await b.close();
