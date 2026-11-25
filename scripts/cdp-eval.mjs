// Usage: node scripts/cdp-eval.mjs <url> <awaitable-expression>
const base = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [url, expr] = process.argv.slice(2);

const list = await (await fetch(base + '/json/list')).json();
let target = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:4181')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const my = ++id; ws.send(JSON.stringify({ id: my, method, params })); return new Promise((res) => pending.set(my, res)); };
await send('Runtime.enable');
if (url) await send('Page.enable'), await send('Page.navigate', { url }), await sleep(2500);
const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true, timeout: 60000 });
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? r, null, 2));
ws.close();
process.exit(0);
