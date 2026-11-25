// Minimal CDP smoke driver: loads ?smoke=1 in headless Edge and reports.
const base = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(base + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP not available');
}

const wsUrl = await getWs();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push('console.' + m.params.type + ': ' + txt);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
  if (m.method === 'Log.entryAdded') logs.push('log: ' + m.params.entry.text);
};
function send(method, params = {}) {
  const myId = ++id;
  ws.send(JSON.stringify({ id: myId, method, params }));
  return new Promise((res) => pending.set(myId, res));
}
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:4181/?smoke=1' });

let result = '';
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  const title = r.result?.value || '';
  if (title.startsWith('SMOKE_PASS') || title.startsWith('SMOKE_FAIL') || title.startsWith('SMOKE_WEAK')) { result = title; break; }
}
if (!result) {
  const r = await send('Runtime.evaluate', { expression: 'document.getElementById("smoke-out")?.textContent || "none"', returnByValue: true });
  result = 'TIMEOUT last=' + r.result?.value;
}
console.log('RESULT:', result);
console.log(logs.slice(0, 25).join('\n'));
ws.close();
process.exit(result.startsWith('SMOKE_PASS') ? 0 : 2);
