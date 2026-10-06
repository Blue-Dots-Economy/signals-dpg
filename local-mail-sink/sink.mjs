// Local stand-in for the notification service. Signals sends every notification
// as an event to `<endpoint>/v1/notify`: event_type, domain, the contact point and
// plain-text variables, with the CTA url already resolved per recipient. Capturing
// that request proves the per-domain redirect end to end without a mail provider.
// The bearer token is accepted as is — nothing here verifies it.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';

const PORT = 4545;
const OUT = new URL('./mail', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
let n = 0;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/v1/notify' && req.method === 'POST') {
      n += 1;
      let p = {};
      try { p = JSON.parse(body); } catch { /* keep raw */ }
      const v = p.variables ?? {};
      // Every link variable in the event — this is the assertion surface.
      const links = ['ctaUrl', 'siteUrl'].filter((k) => v[k]).map((k) => `${k}=${v[k]}`);
      const line = [
        `#${n}  event=${p.event_type ?? '?'}  domain=${p.domain ?? '(none)'}`,
        `    to=${JSON.stringify(p.to ?? {})}`,
        `    links=${links.length ? links.join('  ') : '(none)'}`,
      ].join('\n');
      console.log(line + '\n');
      appendFileSync(`${OUT}/event-${String(n).padStart(3, '0')}.json`, body);
      appendFileSync(`${OUT}/index.log`, line + '\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, notification_id: `sink-${n}` }));
  });
}).listen(PORT, () => console.log(`notify sink on http://localhost:${PORT} -> ${OUT}`));
