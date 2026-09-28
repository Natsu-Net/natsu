import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
p.on('pageerror', e => console.log('[pageerror]', e.message));
const pass = (n, ok, extra='') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`);

await p.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });
await p.waitForFunction(() => window.__uwu?.status === 'open');

// 1. server push reaches the DOM
const a = await p.textContent('#online');
await p.waitForFunction(v => document.getElementById('online').textContent !== v, a, {timeout:5000});
pass('server push updates the DOM', true, `${a} -> ${await p.textContent('#online')}`);

// 2. PRECISE TARGETING: rename row 1, count what mutates
const report = await p.evaluate(async () => {
  const records = [];
  const obs = new MutationObserver(l => records.push(...l));
  obs.observe(document.getElementById('rows'), {childList:true, subtree:true, attributes:true, characterData:true, characterDataOldValue:true});
  window.__uwu.call('room', 'renameRow', 1, 'BETA!');
  await new Promise(r => setTimeout(r, 600));
  obs.disconnect();
  return {
    types: records.map(r => r.type),
    added: records.reduce((n,r) => n + (r.addedNodes?.length||0), 0),
    removed: records.reduce((n,r) => n + (r.removedNodes?.length||0), 0),
    oldValues: records.filter(r=>r.type==='characterData').map(r=>r.oldValue),
    rows: [...document.querySelectorAll('#rows li')].map(li => li.textContent.trim()),
    attrs: [...document.querySelectorAll('#rows li')].map(li => li.getAttribute('data-name')),
  };
});
pass('one row field -> zero structural churn', report.added === 0 && report.removed === 0,
     `${report.added} added, ${report.removed} removed`);
pass('only characterData + attribute mutations', report.types.every(t => t==='characterData' || t==='attributes'),
     report.types.join(','));
pass('sibling rows untouched', report.rows[0]==='alpha x1' && report.rows[2]==='gamma x3', JSON.stringify(report.rows));
pass('attribute binding followed the same path', report.attrs[1]==='BETA!', JSON.stringify(report.attrs));

// 3. list growth adds one row only
const grow = await p.evaluate(async () => {
  const before = document.querySelectorAll('#rows li').length;
  const firstNode = document.querySelector('#rows li');
  const records = [];
  const obs = new MutationObserver(l => records.push(...l));
  obs.observe(document.getElementById('rows'), {childList:true, subtree:true});
  window.__uwu.call('room','addRow');
  await new Promise(r => setTimeout(r, 600));
  obs.disconnect();
  const after = document.querySelectorAll('#rows li').length;
  return { before, after, sameFirstNode: document.querySelector('#rows li') === firstNode,
           last: document.querySelectorAll('#rows li')[after-1]?.textContent.trim() };
});
pass('adding a row grows the list by one', grow.after === grow.before + 1, `${grow.before} -> ${grow.after}`);
pass('existing rows keep their DOM nodes', grow.sameFirstNode);
pass('new row rendered with its own values', /row-3/.test(grow.last||''), grow.last);

// 4. attribute binding on <body class>
await p.evaluate(() => window.__uwu.call('room','setTheme','vivid'));
await p.waitForFunction(() => document.body.className === 'vivid', null, {timeout:5000});
pass('attribute binding updates its element', true, 'body.class -> vivid');

// 5. two-way input
await p.fill('#topic-input', 'typed-by-user');
await p.waitForFunction(() => document.getElementById('topic').textContent === 'typed-by-user', null, {timeout:5000});
pass('two-way input writes back to the server', true);

// 6. read-only field refused
const before = await p.textContent('#online');
await p.evaluate(() => window.__uwu.stores.room.online = 99999);
await p.waitForTimeout(700);
const after = Number(await p.textContent('#online'));
pass('read-only field refused by the server', after !== 99999, `${before} -> ${after}`);

// 7. partial hydration: static text never touched
const staticMutations = await p.evaluate(async () => {
  let n = 0;
  const obs = new MutationObserver(l => n += l.length);
  obs.observe(document.getElementById('static'), {childList:true, subtree:true, characterData:true});
  await new Promise(r => setTimeout(r, 1200));
  obs.disconnect();
  return n;
});
pass('static region never mutated (partial hydration)', staticMutations === 0, `${staticMutations} mutations`);

// 8. no page reload throughout
await p.evaluate(() => window.__marker = 'alive');
await p.waitForTimeout(700);
pass('no page reload during any of it', await p.evaluate(() => window.__marker) === 'alive');

await b.close();
