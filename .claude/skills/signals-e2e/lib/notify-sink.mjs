// Notification-service stand-in for e2e runs.
//
// Signals renders the FULL email — subject, html, CTA href already resolved —
// and POSTs it to `<endpoint>/notify`, so capturing that request is a complete
// oracle rather than a template inspection. SMS arrives on the same endpoint
// with channel:'sms' and the DLT template_id; a case whose templateId is empty
// posts NOTHING, and asserting that absence is the correct test.
//
// HMAC headers are accepted and not verified — this is not the auth surface.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.SINK_PORT ?? 4545);
const OUT = new URL('./mail', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

let captured = [];
let failNext = false;

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'POST' && url.pathname === '/notify') {
      if (failNext) {
        // One forced failure: the only way to reach 502 SUPPORT_SEND_FAILED and
        // to prove the best-effort senders never turn a recorded consent into a 500.
        failNext = false;
        return json(res, 500, { error: 'E2E_FORCED_FAILURE' });
      }
      let p = {};
      try { p = JSON.parse(raw); } catch { /* keep raw below */ }
      const v = p.variables ?? {};
      const entry = {
        seq: captured.length + 1,
        at: new Date().toISOString(),
        channel: p.channel ?? '?',
        to: p.to ?? '?',
        templateId: p.template_id ?? '?',
        priority: p.priority,
        dedupeId: p.dedupe_id ?? null,
        subject: v.subject,
        html: v.html,
        attachments: (v.attachments ?? []).map((a) => ({ filename: a.filename, type: a.contentType ?? a.type, bytes: (a.content ?? '').length })),
        variables: v,
      };
      captured.push(entry);
      appendFileSync(`${OUT}/index.jsonl`, `${JSON.stringify(entry)}\n`);
      if (entry.html) writeFileSync(`${OUT}/mail-${String(entry.seq).padStart(3, '0')}.html`, entry.html);
      console.log(`#${entry.seq} ${entry.channel} to=${entry.to} subject=${entry.subject ?? '(sms)'} tmpl=${entry.templateId}`);
      return json(res, 200, { ok: true });
    }

    // The client probes this for per-channel variable schemas; answer so nothing 500s.
    if (req.method === 'GET' && url.pathname === '/providers') {
      return json(res, 200, [{ channel: 'email', templates: ['basic_email'] }, { channel: 'sms', templates: [] }]);
    }

    if (req.method === 'GET' && url.pathname === '/_e2e/mail') {
      const to = url.searchParams.get('to');
      const channel = url.searchParams.get('channel');
      return json(res, 200, captured.filter((m) =>
        (!to || m.to === to) && (!channel || m.channel === channel)));
    }

    if (req.method === 'POST' && url.pathname === '/_e2e/reset') {
      captured = []; return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/_e2e/fail-next') {
      failNext = true; return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'NOT_FOUND' });
  });
}).listen(PORT, () => console.log(`notify sink on http://localhost:${PORT} -> ${OUT}`));
