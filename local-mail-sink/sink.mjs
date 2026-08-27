// Local stand-in for the notification service. Signals renders the FULL email
// (subject + html, CTA href already resolved) and POSTs it to `<endpoint>/notify`,
// so capturing that request proves the per-domain redirect end to end without a
// mail provider. HMAC headers are ignored — nothing here verifies them.
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
    if (req.url === '/notify' && req.method === 'POST') {
      n += 1;
      let p = {};
      try { p = JSON.parse(body); } catch { /* keep raw */ }
      const v = p.variables ?? {};
      const html = v.html ?? '';
      // Every href in the rendered mail — this is the assertion surface.
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      const line = [
        `#${n}  to=${p.to ?? '?'}`,
        `    subject=${v.subject ?? '?'}`,
        `    hrefs=${hrefs.length ? hrefs.join('  ') : '(none)'}`,
      ].join('\n');
      console.log(line + '\n');
      appendFileSync(`${OUT}/mail-${String(n).padStart(3, '0')}.html`, html || body);
      appendFileSync(`${OUT}/index.log`, line + '\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(PORT, () => console.log(`mail sink on http://localhost:${PORT} -> ${OUT}`));
