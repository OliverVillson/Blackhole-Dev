#!/usr/bin/env node
// Stands in for mlx_lm.server in tests: same flags, same /v1 endpoints, one token per SSE chunk.
// FAKE_LOAD_MS delays readiness, FAKE_CRASH=oom|nomodule makes it fail like the real thing,
// FAKE_ARGS_FILE records the argv it was started with.
import http from 'node:http';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const model = arg('--model');
const port = Number(arg('--port', '8080'));
const host = arg('--host', '127.0.0.1');
if (process.env.FAKE_ARGS_FILE) fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(argv));

if (process.env.FAKE_CRASH === 'nomodule') {
  console.error("ModuleNotFoundError: No module named 'mlx_lm'");
  process.exit(1);
}

const reply = process.env.FAKE_REPLY ?? 'The answer is **42**.';
const think = process.env.FAKE_THINK ?? 'Let me think.';
const orphan = process.env.FAKE_ORPHAN === '1';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const j = JSON.parse(body);
      if (process.env.FAKE_BODY_FILE) fs.writeFileSync(process.env.FAKE_BODY_FILE, body);
      if (process.env.FAKE_CRASH === 'oom') {
        console.error('libc++abi: terminating due to uncaught exception of type std::runtime_error: [METAL] Command buffer execution failed: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)');
        process.exit(134);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const thinking = j.chat_template_kwargs?.enable_thinking !== false;
      const text = (thinking ? (orphan ? '' : '<think>') + think + '</think>\n\n' : '') + reply;
      const toks = text.match(/<\/?think>|\s*\S+/g);
      let n = 0;
      for (const t of toks) {
        if (res.destroyed) return;
        if (j.max_tokens && n >= j.max_tokens) break;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`);
        n++;
        await new Promise((r) => setTimeout(r, Number(process.env.FAKE_TOKEN_MS ?? 2)));
      }
      const finish = j.max_tokens && n >= j.max_tokens && n < toks.length ? 'length' : 'stop';
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      if (j.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 17, completion_tokens: n } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  res.writeHead(404).end();
});

setTimeout(() => server.listen(port, host, () => console.error(`Starting httpd at ${host} on port ${port}...`)), Number(process.env.FAKE_LOAD_MS ?? 50));
process.on('SIGTERM', () => process.exit(0));
