import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { createProxyServer } from "../src/proxy.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("routes V4 Flash to native DeepSeek /responses and preserves SSE", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = {
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(await bodyOf(request)),
    };
    const stream = "event: response.output_text.delta\ndata: {\"delta\":\"ok\"}\n\n"
      + "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n";
    const compressed = gzipSync(stream);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "content-length": compressed.length,
    });
    response.end(compressed);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    chatGptBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const codexBody = zstdCompressSync(JSON.stringify({
    model: "deepseek/deepseek-v4-flash",
      stream: true,
      metadata: { unsupported: true },
    previous_response_id: "unsupported",
    input: [
      { id: "msg_1", type: "agent_message", content: "prior answer" },
      { id: "call_1", type: "function_call_output", call_id: "call_7", output: "done" },
    ],
  }));
  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer client-token" },
    body: codexBody,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.match(await response.text(), /response\.completed/);
  assert.equal(observed.path, "/responses");
  assert.equal(observed.authorization, "Bearer test-key");
  assert.equal(observed.body.model, "deepseek-v4-flash");
  assert.deepEqual(observed.body.reasoning, { effort: "max" });
  assert.equal(observed.body.store, false);
  assert.equal("previous_response_id" in observed.body, false);
  assert.equal("metadata" in observed.body, false);
  assert.deepEqual(observed.body.input[0], { type: "message", role: "assistant", content: "prior answer" });
  assert.deepEqual(observed.body.input[1], { type: "function_call_output", call_id: "call_7", output: "done" });
});

test("preserves explicit High reasoning", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = JSON.parse(await bodyOf(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-token" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", reasoning: { effort: "high", summary: "auto" } }),
  });
  assert.deepEqual(observed.reasoning, { effort: "high" });
});

test("maps stale lower Codex efforts onto DeepSeek High", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = JSON.parse(await bodyOf(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-token" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", reasoning: { effort: "medium" } }),
  });
  assert.deepEqual(observed.reasoning, { effort: "high" });
});

test("forwards native GPT models to ChatGPT Codex with OAuth headers", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = {
      path: request.url,
      authorization: request.headers.authorization,
      account: request.headers["chatgpt-account-id"],
      body: JSON.parse(await bodyOf(request)),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const original = { model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "hello" };
  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer oauth-token",
      "chatgpt-account-id": "acct-test",
    },
    body: JSON.stringify(original),
  });
  assert.equal(response.status, 200);
  assert.equal(observed.path, "/backend-api/codex/responses");
  assert.equal(observed.authorization, "Bearer oauth-token");
  assert.equal(observed.account, "acct-test");
  assert.deepEqual(observed.body, original);
});

test("keeps pooled loopback connections alive past the Codex client idle timeout", async (t) => {
  const proxy = createProxyServer({ logger: { info() {}, error() {} } });
  await listen(proxy);
  t.after(async () => { await close(proxy); });
  // The Codex HTTP client pools connections with a ~90s idle timeout; a shorter
  // server timeout makes the client reuse connections the server just closed.
  assert.ok(proxy.keepAliveTimeout > 90_000);
  assert.ok(proxy.headersTimeout > proxy.keepAliveTimeout);
});

test("returns an explicit error when V4 Flash is selected without a key", async (t) => {
  const proxy = createProxyServer({ deepSeekKey: "", logger: { info() {}, error() {} } });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });
  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-token" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash" }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /DEEPSEEK_API_KEY/);
});

test("rejects DeepSeek requests without a client authorization header", async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (request, response) => {
    upstreamHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hello" }),
  });
  assert.equal(response.status, 401);
  assert.equal(upstreamHits, 0);
  assert.match((await response.json()).error.message, /authorization header/i);
});
