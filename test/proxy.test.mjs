import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { buildDeepSeekBody, createProxyServer } from "../src/proxy.mjs";

const ROUTER_TOKEN = "A".repeat(43);

function route(proxyUrl, path = "/v1/responses") {
  return `${proxyUrl}/${ROUTER_TOKEN}${path}`;
}

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

function readSocketUntil(socket, needle, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    let received = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for socket data: ${needle}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk) => {
      received += chunk.toString("utf8");
      if (!received.includes(needle)) return;
      cleanup();
      resolve(received);
    };
    const onEnd = () => {
      cleanup();
      resolve(received);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

function derLength(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derElement(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSequence(...parts) {
  return derElement(0x30, Buffer.concat(parts));
}

function derInteger(value) {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const bytes = Buffer.from(hex, "hex");
  const padded = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return derElement(0x02, padded);
}

function derOid(oid) {
  const numbers = oid.split(".").map(Number);
  const encoded = [40 * numbers[0] + numbers[1]];
  for (const number of numbers.slice(2)) {
    const base128 = [number % 128];
    let remaining = Math.floor(number / 128);
    while (remaining > 0) {
      base128.unshift((remaining % 128) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    encoded.push(...base128);
  }
  return derElement(0x06, Buffer.from(encoded));
}

function derNull() {
  return Buffer.from([0x05, 0x00]);
}

function derBitString(contents) {
  return derElement(0x03, Buffer.concat([Buffer.from([0]), contents]));
}

function derUtcTime(date) {
  const stamp = `${date.toISOString().replace(/[-:T.Z]/g, "").slice(2, 14)}Z`;
  return derElement(0x17, Buffer.from(stamp, "ascii"));
}

function derName(commonName) {
  const cn = derSequence(derOid("2.5.4.3"), derElement(0x0c, Buffer.from(commonName, "utf8")));
  return derSequence(derElement(0x31, cn));
}

function pemEncode(label, der) {
  const wrapped = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

// Builds a throwaway RSA keypair and a self-signed v3 certificate at test time
// so no private-key material has to live in the repository.
function ephemeralTlsPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const rsaAlgorithm = derSequence(derOid("1.2.840.113549.1.1.1"), derNull());
  const signatureAlgorithm = derSequence(derOid("1.2.840.113549.1.1.11"), derNull());
  const subject = derName("api.openai.test");
  const now = new Date();
  const notAfter = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tbsCertificate = derSequence(
    derElement(0xa0, derInteger(2)),
    derInteger(0x01),
    signatureAlgorithm,
    subject,
    derSequence(derUtcTime(now), derUtcTime(notAfter)),
    subject,
    derSequence(rsaAlgorithm, derBitString(publicKey)),
  );
  const signature = sign("sha256", tbsCertificate, privateKey);
  const certificate = derSequence(tbsCertificate, signatureAlgorithm, derBitString(signature));
  return { key: privateKey, cert: pemEncode("CERTIFICATE", certificate) };
}

test("routes V4 Flash and Pro to their native DeepSeek Responses models", async (t) => {
  const observed = [];
  const upstream = http.createServer(async (request, response) => {
    observed.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(await bodyOf(request)),
    });
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
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  for (const [pickerModel, wireModel] of [
    ["deepseek/deepseek-v4-flash", "deepseek-v4-flash"],
    ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
  ]) {
    const codexBody = zstdCompressSync(JSON.stringify({
      model: pickerModel,
      stream: true,
      metadata: { unsupported: true },
      previous_response_id: "unsupported",
      input: [
        { id: "msg_1", type: "agent_message", content: "prior answer" },
        { id: "call_1", type: "function_call_output", call_id: "call_7", output: "done" },
      ],
    }));
    const response = await fetch(route(proxyUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer client-token" },
      body: codexBody,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.match(await response.text(), /response\.completed/);
    const request = observed.at(-1);
    assert.equal(request.path, "/responses");
    assert.equal(request.authorization, "Bearer test-key");
    assert.equal(request.body.model, wireModel);
    assert.deepEqual(request.body.reasoning, { effort: "max" });
    assert.equal(request.body.store, false);
    assert.equal("previous_response_id" in request.body, false);
    assert.equal("metadata" in request.body, false);
    assert.deepEqual(request.body.input[0], { type: "message", role: "assistant", content: "prior answer" });
    assert.deepEqual(request.body.input[1], { type: "function_call_output", call_id: "call_7", output: "done" });
  }
});

test("adapts Codex remote compaction v2 to a DeepSeek summary and restores it on replay", async (t) => {
  const observed = [];
  const summary = "The user approved the router fix; tests and a restart are still pending.";
  const upstream = http.createServer(async (request, response) => {
    observed.push(JSON.parse(await bodyOf(request)));
    if (observed.length === 1) {
      const item = {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summary }],
      };
      const stream = [
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_upstream",
            output: [item],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          },
        })}\n\n`,
      ].join("");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(stream);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const compactResponse = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-pro",
      stream: true,
      tools: [{ type: "function", name: "shell" }],
      parallel_tool_calls: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] },
        { type: "compaction_trigger" },
      ],
    }),
  });
  assert.equal(compactResponse.status, 200);
  const compactStream = await compactResponse.text();
  const events = compactStream
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));
  const compactItem = events.find((event) => event.type === "response.output_item.done")?.item;
  const completed = events.find((event) => event.type === "response.completed")?.response;
  assert.equal(compactItem?.type, "compaction");
  assert.equal(completed?.model, "deepseek-v4-pro");
  assert.match(compactItem.encrypted_content, /^dscodex-compaction-v1:/);
  assert.equal(compactItem.encrypted_content.includes(summary), false);
  assert.equal(observed[0].input.some((item) => item.type === "compaction_trigger"), false);
  assert.equal("tools" in observed[0], false);
  assert.equal("parallel_tool_calls" in observed[0], false);
  assert.equal(observed[0].model, "deepseek-v4-pro");
  assert.match(observed[0].input.at(-1).content[0].text, /compact handoff summary/i);

  const replayResponse = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-pro",
      input: [
        compactItem,
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    }),
  });
  assert.equal(replayResponse.status, 200);
  await replayResponse.text();
  assert.equal(observed[1].input.some((item) => item.type === "compaction"), false);
  const restored = observed[1].input.find((item) => item.role === "assistant");
  assert.match(restored.content[0].text, /Compacted prior context/);
  assert.match(restored.content[0].text, /tests and a restart are still pending/);
});

test("drops compaction items that cannot be decrypted instead of forwarding them", async (t) => {
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
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      input: [
        { type: "compaction", id: "cmp_gpt", encrypted_content: "gpt-sealed-blob" },
        { type: "compaction", id: "cmp_tampered", encrypted_content: "dscodex-compaction-v1:not-valid" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(observed.input.some((item) => item.type === "compaction"), false);
  assert.deepEqual(observed.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
  ]);
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
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await fetch(route(proxyUrl), {
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
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await fetch(route(proxyUrl), {
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
      fedramp: request.headers["x-openai-fedramp"],
      memgen: request.headers["x-openai-memgen-request"],
      residency: request.headers["x-openai-internal-codex-residency"],
      responsesLite: request.headers["x-openai-internal-codex-responses-lite"],
      version: request.headers.version,
      body: JSON.parse(await bodyOf(request)),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const original = { model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "hello" };
  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer oauth-token",
      "chatgpt-account-id": "acct-test",
      "x-openai-fedramp": "true",
      "x-openai-memgen-request": "true",
      "x-openai-internal-codex-residency": "us",
      "x-openai-internal-codex-responses-lite": "true",
      version: "0.test",
    },
    body: JSON.stringify(original),
  });
  assert.equal(response.status, 200);
  assert.equal(observed.path, "/backend-api/codex/responses");
  assert.equal(observed.authorization, "Bearer oauth-token");
  assert.equal(observed.account, "acct-test");
  assert.equal(observed.fedramp, "true");
  assert.equal(observed.memgen, "true");
  assert.equal(observed.residency, "us");
  assert.equal(observed.responsesLite, "true");
  assert.equal(observed.version, "0.test");
  assert.deepEqual(observed.body, original);
});

test("forwards Responses Lite to the remote compaction endpoint", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = {
      path: request.url,
      responsesLite: request.headers["x-openai-internal-codex-responses-lite"],
      body: JSON.parse(await bodyOf(request)),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"output":[{"type":"compaction_summary","encrypted_content":"opaque"}]}');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const original = { model: "gpt-5.6-sol", input: [{ role: "user", content: "compact me" }] };
  const response = await fetch(route(proxyUrl, "/v1/responses/compact"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openai-internal-codex-responses-lite": "true",
    },
    body: JSON.stringify(original),
  });

  assert.equal(response.status, 200);
  assert.equal(observed.path, "/backend-api/codex/responses/compact");
  assert.equal(observed.responsesLite, "true");
  assert.deepEqual(observed.body, original);
  assert.deepEqual(await response.json(), {
    output: [{ type: "compaction_summary", encrypted_content: "opaque" }],
  });
});

test("does not forward ChatGPT authentication metadata to DeepSeek", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = { ...request.headers };
    await bodyOf(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "deepseek-test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: {
      authorization: "Bearer oauth-token",
      "chatgpt-account-id": "acct-test",
      session_id: "session-underscore-test",
      "session-id": "session-test",
      "thread-id": "thread-test",
      "user-agent": "codex-test",
      "x-oai-attestation": "attestation-test",
      "x-codex-turn-metadata": "metadata-test",
    },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hello" }),
  });

  assert.equal(response.status, 200);
  assert.equal(observed.authorization, "Bearer deepseek-test-key");
  assert.equal(observed["user-agent"], "codex-test");
  assert.equal(observed["chatgpt-account-id"], undefined);
  assert.equal(observed.session_id, undefined);
  assert.equal(observed["session-id"], undefined);
  assert.equal(observed["thread-id"], undefined);
  assert.equal(observed["x-oai-attestation"], undefined);
  assert.equal(observed["x-codex-turn-metadata"], undefined);
});

test("keeps pooled loopback connections alive past the Codex client idle timeout", async (t) => {
  const proxy = createProxyServer({ logger: { info() {}, error() {} }, routerToken: ROUTER_TOKEN });
  await listen(proxy);
  t.after(async () => { await close(proxy); });
  // The Codex HTTP client pools connections with a ~90s idle timeout; a shorter
  // server timeout makes the client reuse connections the server just closed.
  assert.ok(proxy.keepAliveTimeout > 90_000);
  assert.ok(proxy.headersTimeout > proxy.keepAliveTimeout);
});

test("requires a router token and rejects oversized compressed bodies", async (t) => {
  assert.throws(() => createProxyServer({ logger: { info() {}, error() {} } }), /routerToken is required/);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    routerToken: ROUTER_TOKEN,
    maxRequestBytes: 256,
    maxDecodedBytes: 32,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });

  const tooLarge = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "x".repeat(1_000) }),
  });
  assert.equal(tooLarge.status, 413);

  const compressed = gzipSync(JSON.stringify({ model: "gpt-5.6-sol", input: "x".repeat(1_000) }));
  const decompressionBomb = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: compressed,
  });
  assert.equal(decompressionBomb.status, 413);
});

test("shutdown requires the per-instance token", async (t) => {
  const shutdownToken = "B".repeat(43);
  let shutdownCalls = 0;
  const proxy = createProxyServer({
    routerToken: ROUTER_TOKEN,
    shutdownToken,
    onShutdown: () => { shutdownCalls += 1; },
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });

  const rejected = await fetch(route(proxyUrl, "/_dscodex/shutdown"), {
    method: "POST",
    headers: { "x-dscodex-shutdown-token": "C".repeat(43) },
  });
  assert.equal(rejected.status, 401);
  const accepted = await fetch(route(proxyUrl, "/_dscodex/shutdown"), {
    method: "POST",
    headers: { "x-dscodex-shutdown-token": shutdownToken },
  });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownCalls, 1);
});

test("returns an explicit error when a DeepSeek model is selected without a key", async (t) => {
  const proxy = createProxyServer({ deepSeekKey: "", logger: { info() {}, error() {} }, routerToken: ROUTER_TOKEN });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });
  for (const model of ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"]) {
    const response = await fetch(route(proxyUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-token" },
      body: JSON.stringify({ model }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /DEEPSEEK_API_KEY/);
  }
});

test("rejects requests without the router token, while OAuth remains optional", async (t) => {
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
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hello" }),
  });
  assert.equal(response.status, 404);
  assert.equal(upstreamHits, 0);
  assert.match((await response.json()).error.message, /not found/i);

  const authorized = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hello" }),
  });
  assert.equal(authorized.status, 200);
  assert.equal(upstreamHits, 1);
});

const shape = (items) =>
  items.map((item) =>
    item.type === "message" ? `${item.role}:${item.content[0].text}`
      : item.type === "reasoning" ? `reasoning:${item.content[0].text}`
        : `${item.type}:${item.call_id}`);

const say = (role, text) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const think = (text) => ({ type: "reasoning", content: [{ type: "reasoning_text", text }] });

test("re-pairs a tool output with its call when hook context is interleaved", () => {
  const body = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      say("user", "u1"),
      think("r1"),
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      say("developer", "GitNexus index is stale"),
      { type: "function_call_output", call_id: "c1", output: "ok" },
      { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: "*** Begin Patch" },
      say("developer", "hook again"),
      { type: "custom_tool_call_output", call_id: "p1", output: "done" },
    ],
  });

  assert.deepEqual(shape(body.input), [
    "user:u1",
    "reasoning:r1",
    "function_call:c1",
    "function_call_output:c1",
    "developer:GitNexus index is stale",
    "custom_tool_call:p1",
    "custom_tool_call_output:p1",
    "developer:hook again",
  ]);
});

test("leaves conversation order alone when a tool call has no output", () => {
  const input = [
    say("user", "u1"),
    think("r1"),
    { type: "function_call", call_id: "orphan", name: "shell", arguments: "{}" },
    say("user", "never mind, do this instead"),
    think("r2"),
    { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "c2", output: "ok" },
    say("user", "u3"),
  ];

  const body = buildDeepSeekBody({ model: "deepseek/deepseek-v4-flash", input });
  assert.deepEqual(shape(body.input), shape(input));
});

test("gives each parallel tool call its own reasoning without leaking it into later turns", () => {
  const parallel = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      say("user", "u1"),
      think("r1"),
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "a" },
      { type: "function_call_output", call_id: "c2", output: "b" },
    ],
  });
  assert.deepEqual(shape(parallel.input), [
    "user:u1",
    "reasoning:r1",
    "function_call:c1",
    "function_call_output:c1",
    "reasoning:r1",
    "function_call:c2",
    "function_call_output:c2",
  ]);
  assert.notEqual(parallel.input[1], parallel.input[4]);

  // Codex emits an assistant preamble between the reasoning and the calls; that
  // message is part of the same turn, so the extra call still needs a copy.
  const withPreamble = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      say("user", "u1"),
      think("r1"),
      say("assistant", "Checking two things"),
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "a" },
      { type: "function_call_output", call_id: "c2", output: "b" },
    ],
  });
  assert.deepEqual(shape(withPreamble.input), [
    "user:u1",
    "reasoning:r1",
    "assistant:Checking two things",
    "function_call:c1",
    "function_call_output:c1",
    "reasoning:r1",
    "function_call:c2",
    "function_call_output:c2",
  ]);

  // A second turn that carries no reasoning of its own must not inherit the first turn's.
  const sequential = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      say("user", "u1"),
      think("r1"),
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "a" },
      { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c2", output: "b" },
    ],
  });
  assert.equal(sequential.input.filter((item) => item.type === "reasoning").length, 1);
});

test("never asks DeepSeek for parallel tool calls", () => {
  const body = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    parallel_tool_calls: true,
    input: [say("user", "u1")],
  });
  assert.equal(body.parallel_tool_calls, false);
});

test("relays authenticated Responses WebSocket upgrades and bytes in both directions", async (t) => {
  let observed;
  let upstreamSocket;
  let resolveClientPayload;
  const clientPayload = new Promise((resolve) => { resolveClientPayload = resolve; });
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket, head) => {
    upstreamSocket = socket;
    observed = {
      path: request.url,
      authorization: request.headers.authorization,
      account: request.headers["chatgpt-account-id"],
      metadata: request.headers["x-codex-turn-metadata"],
      protocol: request.headers["sec-websocket-protocol"],
      host: request.headers.host,
    };
    socket.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("client-payload")) resolveClientPayload();
    });
    if (head.toString("utf8").includes("client-payload")) resolveClientPayload();
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
      + "Sec-WebSocket-Protocol: responses\r\n\r\n"
      + "upstream-ready",
    );
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  const { port } = proxy.address();
  const clientSocket = net.connect(port, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    upstreamSocket?.destroy();
    await close(proxy);
    await close(upstream);
  });
  await once(clientSocket, "connect");
  clientSocket.write(
    `GET /${ROUTER_TOKEN}/v1/responses?conversation=voice HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    + "Sec-WebSocket-Protocol: responses\r\n"
    + "Authorization: Bearer oauth-token\r\n"
    + "ChatGPT-Account-Id: acct-test\r\n"
    + "X-Codex-Turn-Metadata: metadata-test\r\n\r\n",
  );

  const handshake = await readSocketUntil(clientSocket, "upstream-ready");
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(handshake, /Sec-WebSocket-Protocol: responses/i);
  assert.equal(observed.path, "/backend-api/codex/responses?conversation=voice");
  assert.equal(observed.authorization, "Bearer oauth-token");
  assert.equal(observed.account, "acct-test");
  assert.equal(observed.metadata, "metadata-test");
  assert.equal(observed.protocol, "responses");
  assert.notEqual(observed.host, `127.0.0.1:${port}`);

  clientSocket.write("client-payload");
  await clientPayload;
});

test("relays authenticated Realtime sideband WebSockets through the dedicated upstream", async (t) => {
  let observed;
  let upstreamSocket;
  let resolveClientPayload;
  const clientPayload = new Promise((resolve) => { resolveClientPayload = resolve; });
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket, head) => {
    upstreamSocket = socket;
    observed = {
      path: request.url,
      authorization: request.headers.authorization,
      account: request.headers["chatgpt-account-id"],
      alpha: request.headers["openai-alpha"],
      session: request.headers["x-session-id"],
      scopedSession: request.headers["x-openai-scoped-session-id"],
      thread: request.headers["x-openai-thread-id"],
      attestation: request.headers["x-oai-attestation"],
      host: request.headers.host,
    };
    socket.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("client-sideband-payload")) resolveClientPayload();
    });
    if (head.toString("utf8").includes("client-sideband-payload")) resolveClientPayload();
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"
      + "sideband-ready",
    );
  });
  const upstreamUrl = await listen(upstream);
  const infoLogs = [];
  const proxy = createProxyServer({
    chatGptBaseUrl: "http://unused.example/backend-api/codex",
    realtimeApiBaseUrl: `${upstreamUrl}/v1`,
    logger: { info(message) { infoLogs.push(message); }, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  const clientSocket = net.connect(port, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    upstreamSocket?.destroy();
    await close(proxy);
    await close(upstream);
  });
  await once(clientSocket, "connect");
  clientSocket.write(
    `GET /${ROUTER_TOKEN}/v1/live/rtc_voice-123?source=voice HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    + "Authorization: Bearer oauth-token\r\n"
    + "ChatGPT-Account-Id: acct-test\r\n"
    + "OpenAI-Alpha: quicksilver=v2\r\n"
    + "X-Session-Id: realtime-session\r\n"
    + "X-OpenAI-Scoped-Session-Id: codex-session\r\n"
    + "X-OpenAI-Thread-Id: codex-thread\r\n"
    + "X-OAI-Attestation: attestation-test\r\n\r\n",
  );

  const handshake = await readSocketUntil(clientSocket, "sideband-ready");
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.equal(observed.path, "/v1/live/rtc_voice-123?source=voice");
  assert.equal(observed.authorization, "Bearer oauth-token");
  assert.equal(observed.account, "acct-test");
  assert.equal(observed.alpha, "quicksilver=v2");
  assert.equal(observed.session, "realtime-session");
  assert.equal(observed.scopedSession, "codex-session");
  assert.equal(observed.thread, "codex-thread");
  assert.equal(observed.attestation, "attestation-test");
  assert.notEqual(observed.host, `127.0.0.1:${port}`);
  assert.equal(infoLogs.join("\n").includes("rtc_voice-123"), false);

  clientSocket.write("client-sideband-payload");
  await clientPayload;
});

test("routes HTTPS Realtime sideband WebSockets through the configured CONNECT proxy", { timeout: 10_000 }, async (t) => {
  const { key, cert } = ephemeralTlsPair();
  let upstreamSocket;
  let observed;
  const upstream = https.createServer({ key, cert });
  upstream.on("upgrade", (request, socket) => {
    upstreamSocket = socket;
    observed = {
      path: request.url,
      authorization: request.headers.authorization,
    };
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"
      + "connect-proxy-ready",
    );
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;

  const tunnelSockets = new Set();
  const connectTargets = [];
  const connectProxy = http.createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  connectProxy.on("connect", (request, clientSocket, head) => {
    connectTargets.push(request.url);
    const targetSocket = net.connect(upstreamPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) targetSocket.write(head);
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });
    tunnelSockets.add(clientSocket);
    tunnelSockets.add(targetSocket);
    clientSocket.on("error", () => {});
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.once("close", () => tunnelSockets.delete(clientSocket));
    targetSocket.once("close", () => tunnelSockets.delete(targetSocket));
  });
  const connectProxyUrl = await listen(connectProxy);

  const proxyModuleUrl = new URL("../src/proxy.mjs", import.meta.url).href;
  const childSource = `
    import { once } from "node:events";
    const { createProxyServer } = await import(${JSON.stringify(proxyModuleUrl)});
    const server = createProxyServer({
      realtimeApiBaseUrl: process.env.TEST_REALTIME_BASE_URL,
      logger: { info() {}, error() {} },
      routerToken: ${JSON.stringify(ROUTER_TOKEN)},
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    console.log(server.address().port);
    process.on("SIGTERM", () => {
      server.closeUpgradeConnections?.();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1_000).unref();
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
    env: {
      ...process.env,
      NODE_OPTIONS: "--use-env-proxy",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      HTTPS_PROXY: connectProxyUrl,
      https_proxy: connectProxyUrl,
      HTTP_PROXY: connectProxyUrl,
      http_proxy: connectProxyUrl,
      NO_PROXY: "",
      no_proxy: "",
      ALL_PROXY: "",
      all_proxy: "",
      TEST_REALTIME_BASE_URL: `https://api.openai.test:${upstreamPort}/v1`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childStderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { childStderr += chunk; });
  const routerPort = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`timed out starting proxy child: ${childStderr}`)), 3_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n")[0].trim();
      if (!/^\d+$/.test(line)) return;
      clearTimeout(timer);
      resolve(Number(line));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy child exited ${code}: ${childStderr}`));
    });
  });

  const clientSocket = net.connect(routerPort, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    upstreamSocket?.destroy();
    for (const socket of tunnelSockets) socket.destroy();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await close(connectProxy);
    await close(upstream);
  });
  await once(clientSocket, "connect");
  clientSocket.write(
    `GET /${ROUTER_TOKEN}/v1/live/rtc_connect-123 HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${routerPort}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    + "Authorization: Bearer oauth-through-connect\r\n\r\n",
  );

  const handshake = await readSocketUntil(clientSocket, "connect-proxy-ready", 3_000);
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.deepEqual(connectTargets, [`api.openai.test:${upstreamPort}`]);
  assert.equal(observed.path, "/v1/live/rtc_connect-123");
  assert.equal(observed.authorization, "Bearer oauth-through-connect");
});

test("relays legacy Realtime sideband call_id upgrades to the Realtime endpoint", async (t) => {
  let observedPath;
  let upstreamSocket;
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket) => {
    upstreamSocket = socket;
    observedPath = request.url;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
    );
  });
  const upstreamUrl = await listen(upstream);
  const infoLogs = [];
  const proxy = createProxyServer({
    realtimeApiBaseUrl: `${upstreamUrl}/v1`,
    logger: { info(message) { infoLogs.push(message); }, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  const clientSocket = net.connect(port, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    upstreamSocket?.destroy();
    await close(proxy);
    await close(upstream);
  });
  await once(clientSocket, "connect");
  clientSocket.write(
    `GET /${ROUTER_TOKEN}/v1/realtime?intent=quicksilver&call_id=rtc_voice-legacy HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    + "Authorization: Bearer oauth-token\r\n"
    + "OpenAI-Alpha: quicksilver=v2\r\n\r\n",
  );

  const handshake = await readSocketUntil(clientSocket, "\r\n\r\n");
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.equal(observedPath, "/v1/realtime?intent=quicksilver&call_id=rtc_voice-legacy");
  assert.equal(infoLogs.join("\n").includes("rtc_voice-legacy"), false);
});

test("rejects invalid or duplicate Realtime call IDs without leaking them to logs", async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer();
  upstream.on("upgrade", (_request, socket) => {
    upstreamHits += 1;
    socket.destroy();
  });
  const upstreamUrl = await listen(upstream);
  const infoLogs = [];
  const proxy = createProxyServer({
    realtimeApiBaseUrl: `${upstreamUrl}/v1`,
    logger: { info(message) { infoLogs.push(message); }, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await close(proxy);
    await close(upstream);
  });

  const requestUpgrade = async (path) => {
    const socket = net.connect(port, "127.0.0.1");
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    await once(socket, "connect");
    socket.write(
      `GET /${ROUTER_TOKEN}${path} HTTP/1.1\r\n`
      + `Host: 127.0.0.1:${port}\r\n`
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Version: 13\r\n"
      + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    return readSocketUntil(socket, "\r\n\r\n");
  };

  const invalidCallId = "rtc.secret.invalid";
  const invalid = await requestUpgrade(`/v1/live/${invalidCallId}`);
  const duplicate = await requestUpgrade("/v1/realtime?call_id=first-secret&call_id=second-secret");
  assert.match(invalid, /^HTTP\/1\.1 426 Upgrade Required/);
  assert.match(duplicate, /^HTTP\/1\.1 426 Upgrade Required/);
  assert.equal(upstreamHits, 0);
  const logs = infoLogs.join("\n");
  assert.equal(logs.includes(invalidCallId), false);
  assert.equal(logs.includes("first-secret"), false);
  assert.equal(logs.includes("second-secret"), false);
});

test("rejects an unauthenticated Responses WebSocket before contacting upstream", async (t) => {
  let upstreamHits = 0;
  const infoLogs = [];
  const invalidToken = "B".repeat(43);
  const upstream = http.createServer();
  upstream.on("upgrade", (_request, socket) => {
    upstreamHits += 1;
    socket.destroy();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info(message) { infoLogs.push(message); }, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  const clientSocket = net.connect(port, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    await close(proxy);
    await close(upstream);
  });
  await once(clientSocket, "connect");
  clientSocket.write(
    `GET /${invalidToken}/v1/responses HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );

  const response = await readSocketUntil(clientSocket, "\r\n\r\n");
  assert.match(response, /^HTTP\/1\.1 404 Not Found/);
  assert.equal(upstreamHits, 0);
  assert.equal(infoLogs.join("\n").includes(invalidToken), false);
});

test("keeps authenticated non-Responses upgrades on the HTTP fallback path", async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer();
  upstream.on("upgrade", (_request, socket) => {
    upstreamHits += 1;
    socket.destroy();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  const clientSocket = net.connect(port, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    await close(proxy);
    await close(upstream);
  });
  await once(clientSocket, "connect");
  clientSocket.write(
    `GET /${ROUTER_TOKEN}/v1/models HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n\r\n",
  );

  const response = await readSocketUntil(clientSocket, "\r\n\r\n");
  assert.match(response, /^HTTP\/1\.1 426 Upgrade Required/);
  assert.equal(upstreamHits, 0);
});

test("returns 502 when the Responses WebSocket upstream is unavailable", async (t) => {
  const unavailable = http.createServer();
  const unavailableUrl = await listen(unavailable);
  await close(unavailable);
  const errorLogs = [];
  const proxy = createProxyServer({
    chatGptBaseUrl: `${unavailableUrl}/backend-api/codex`,
    logger: { info() {}, error(message) { errorLogs.push(message); } },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  const clientSocket = net.connect(port, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    await close(proxy);
  });
  await once(clientSocket, "connect");
  clientSocket.write(
    `GET /${ROUTER_TOKEN}/v1/responses HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );

  const response = await readSocketUntil(clientSocket, "\r\n\r\n");
  assert.match(response, /^HTTP\/1\.1 502 Bad Gateway/);
  assert.match(errorLogs.join("\n"), /websocket proxy error \(\/v1\/responses\)/);
});

test("relays an upstream WebSocket rejection to the Codex client", async (t) => {
  const upstream = http.createServer();
  upstream.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 401 Unauthorized\r\n"
      + "Connection: close\r\n"
      + "WWW-Authenticate: Bearer\r\n"
      + "Content-Length: 0\r\n\r\n",
    );
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  const clientSocket = net.connect(port, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    await close(proxy);
    await close(upstream);
  });
  await once(clientSocket, "connect");
  clientSocket.write(
    `GET /${ROUTER_TOKEN}/v1/responses HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );

  const response = await readSocketUntil(clientSocket, "\r\n\r\n");
  assert.match(response, /^HTTP\/1\.1 401 Unauthorized/);
  assert.match(response, /WWW-Authenticate: Bearer/i);
});

test("reframes chunked WebSocket rejection bodies for a real HTTP client", async (t) => {
  const upstream = http.createServer();
  upstream.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 401 Unauthorized\r\n"
      + "Connection: close\r\n"
      + "Content-Type: text/plain\r\n"
      + "Transfer-Encoding: chunked\r\n\r\n"
      + "5\r\nhello\r\n0\r\n\r\n",
    );
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const result = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/${ROUTER_TOKEN}/v1/responses`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("upgrade", () => reject(new Error("unexpected WebSocket upgrade")));
    request.on("error", reject);
    request.setTimeout(1_000, () => request.destroy(new Error("timed out reading rejection body")));
    request.end();
  });

  assert.equal(result.statusCode, 401);
  assert.equal(result.headers["transfer-encoding"], undefined);
  assert.equal(result.headers.connection, "close");
  assert.equal(result.body, "hello");
});

test("closes the client when a WebSocket rejection body is truncated upstream", async (t) => {
  const upstream = http.createServer();
  upstream.on("upgrade", (_request, socket) => {
    socket.write(
      "HTTP/1.1 502 Bad Gateway\r\n"
      + "Connection: close\r\n"
      + "Content-Type: text/plain\r\n"
      + "Content-Length: 10\r\n\r\n"
      + "hello",
    );
    setImmediate(() => socket.destroy());
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  const clientSocket = net.connect(port, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    proxy.closeUpgradeConnections();
    await close(proxy);
    await close(upstream);
  });
  await once(clientSocket, "connect");
  const clientClosed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("client stayed open after the upstream rejection was truncated")), 500);
    clientSocket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  clientSocket.write(
    `GET /${ROUTER_TOKEN}/v1/responses HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );

  const response = await readSocketUntil(clientSocket, "hello");
  assert.match(response, /^HTTP\/1\.1 502 Bad Gateway/);
  await clientClosed;
});

for (const kind of ["HTTP", "upgrade"]) {
  test(`rejects malformed absolute-form ${kind} targets without stopping the router`, async (t) => {
    const proxy = createProxyServer({
      logger: { info() {}, error() {} },
      routerToken: ROUTER_TOKEN,
    });
    const proxyUrl = await listen(proxy);
    const { port } = proxy.address();
    const clientSocket = net.connect(port, "127.0.0.1");
    t.after(async () => {
      clientSocket.destroy();
      await close(proxy);
    });
    await once(clientSocket, "connect");
    clientSocket.write(
      "GET http://[ HTTP/1.1\r\n"
      + `Host: 127.0.0.1:${port}\r\n`
      + (kind === "upgrade" ? "Connection: Upgrade\r\nUpgrade: websocket\r\n" : "Connection: close\r\n")
      + "\r\n",
    );

    const response = await readSocketUntil(clientSocket, "\r\n\r\n");
    assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
    const health = await fetch(route(proxyUrl, "/health"));
    assert.equal(health.status, 200);
  });
}

test("force-closes upgraded sockets so router shutdown can finish", async (t) => {
  let upstreamSocket;
  const upstream = http.createServer();
  upstream.on("upgrade", (_request, socket) => {
    upstreamSocket = socket;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
    );
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  await listen(proxy);
  const { port } = proxy.address();
  const clientSocket = net.connect(port, "127.0.0.1");
  t.after(async () => {
    clientSocket.destroy();
    upstreamSocket?.destroy();
    if (proxy.listening) await close(proxy);
    await close(upstream);
  });
  await once(clientSocket, "connect");
  clientSocket.write(
    `GET /${ROUTER_TOKEN}/v1/responses HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  await readSocketUntil(clientSocket, "\r\n\r\n");

  const clientClosed = once(clientSocket, "close");
  const serverClosed = new Promise((resolve, reject) => {
    proxy.close((error) => error ? reject(error) : resolve());
  });
  proxy.closeUpgradeConnections();
  await Promise.all([clientClosed, serverClosed]);
});

// Regression: the `upgrade` handler used to leave its detached socket without an
// error listener, so a client reset raised an unhandled 'error' event and took
// the whole router down — Codex then sat in "reconnecting" until a manual start.
test("survives a client reset on an upgrade attempt", async (t) => {
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });
  const { port } = proxy.address();

  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    "GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n"
    + "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.resetAndDestroy();
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Still serving: an unhandled 'error' event would have killed this process.
  const response = await fetch(route(proxyUrl, "/v1/models"));
  assert.equal(response.status, 200);
});
