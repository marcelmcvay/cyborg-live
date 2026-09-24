'use strict';
// Stand-in for api.anthropic.com/v1/messages so the ascii-art pipeline can be
// exercised without a real key. NOT a quality test of the drawings.
//   node tools/fake-claude.js 8798   (env FAKE_MODE=slow|bad|error to test fallbacks)
const http = require('http');
const PORT = Number(process.argv[2]) || 8798;
const MODE = process.env.FAKE_MODE || 'ok';
let hits = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    hits++;
    const j = JSON.parse(body || '{}');
    const prompt = (j.messages && j.messages[0] && j.messages[0].content) || '';
    const phrase = (prompt.match(/wrote it: "([^"]*)"/) || [])[1] || '?';
    console.log(`[fake-claude] #${hits} key=${req.headers['x-api-key'] ? 'yes' : 'no'} model=${j.model} phrase="${phrase}"`);
    if (MODE === 'error') { res.writeHead(529, { 'content-type': 'application/json' }); return res.end('{"error":{"type":"overloaded_error"}}'); }
    const art = MODE === 'bad' ? 'Sure! Here you go.' :
      '```\n      .-""""-.\n     /  o  o  \\\n    |    ^^    |\n    |  \\____/  |\n     \\________/\n    /|  ||  |\\\n   / |  ||  | \\\n```\n' + 'x'.repeat(0);
    const send = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: art }] })); };
    if (MODE === 'slow') setTimeout(send, 20000); else send();
  });
}).listen(PORT, () => console.log(`[fake-claude] :${PORT} mode=${MODE}`));
