import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createProxyServer } from "../src/proxy.mjs";

const IMAGE_A = `data:image/png;base64,${"A".repeat(64)}`;
const IMAGE_B = `data:image/png;base64,${"B".repeat(64)}`;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
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

function sseBody(text) {
  return "event: response.output_text.delta\n"
    + `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`
    + "event: response.completed\n"
    + `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ content: [{ type: "output_text", text }] }] } })}\n\n`;
}

// A fake ChatGPT Codex backend: describes images (150ms each, so concurrent
// describes are observable) and records every call it gets.
function createFakeChatGpt(calls, { fail = false } = {}) {
  return http.createServer(async (request, response) => {
    const parsed = JSON.parse(await bodyOf(request));
    if (typeof parsed.instructions === "string") {
      const dataUrl = parsed.input[0].content[0].image_url;
      calls.push({ kind: "describe", authorization: request.headers.authorization, dataUrl });
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (fail) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":"boom"}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sseBody(`desc:${dataUrl.slice(-8)}`));
      return;
    }
    calls.push({ kind: "passthrough", body: parsed });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
}

function createFakeDeepSeek(received) {
  return http.createServer(async (request, response) => {
    received.push(JSON.parse(await bodyOf(request)));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
}

function deepSeekRequest(images) {
  return {
    model: "deepseek/deepseek-v4-flash",
    input: [
      { type: "message", role: "user", content: [
        { type: "input_text", text: "what do you see" },
        { type: "input_image", image_url: images[0] },
      ] },
      ...(images[1] ? [{ type: "function_call_output", call_id: "call_1", output: [
        { type: "input_image", image_url: images[1] },
      ] }] : []),
      ...(images[2] ? [{ type: "message", role: "user", content: [
        { type: "input_image", image_url: images[2] },
      ] }] : []),
    ],
  };
}

function collectText(body) {
  const texts = [];
  for (const item of body.input) {
    for (const key of ["content", "output"]) {
      if (!Array.isArray(item[key])) continue;
      for (const part of item[key]) if (part.type === "input_text") texts.push(part.text);
    }
  }
  return texts;
}

function countImages(body) {
  let count = 0;
  for (const item of body.input) {
    for (const key of ["content", "output"]) {
      if (!Array.isArray(item[key])) continue;
      for (const part of item[key]) if (part.type === "input_image") count += 1;
    }
  }
  return count;
}

test("rewrites DeepSeek-bound images into GPT descriptions, concurrent and cached", async (t) => {
  const chatGptCalls = [];
  const deepSeekReceived = [];
  const chatGpt = createFakeChatGpt(chatGptCalls);
  const deepSeek = createFakeDeepSeek(deepSeekReceived);
  const chatGptUrl = await listen(chatGpt);
  const deepSeekUrl = await listen(deepSeek);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: deepSeekUrl,
    chatGptBaseUrl: chatGptUrl,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(chatGpt); await close(deepSeek); });

  const startedAt = Date.now();
  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-token" },
    body: JSON.stringify(deepSeekRequest([IMAGE_A, IMAGE_B, IMAGE_A])),
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(response.status, 200);

  // Two unique images, described concurrently: ~150ms, not ~300ms serial.
  const describes = chatGptCalls.filter((call) => call.kind === "describe");
  assert.equal(describes.length, 2);
  assert.ok(elapsed < 280, `describes ran serially (${elapsed}ms)`);
  assert.equal(describes[0].authorization, "Bearer oauth-token");

  const body = deepSeekReceived[0];
  assert.equal(countImages(body), 0);
  const texts = collectText(body);
  const descA = texts.filter((text) => text.includes(`desc:${IMAGE_A.slice(-8)}`));
  assert.equal(descA.length, 2); // the duplicate image reuses the same description
  assert.ok(descA[0].includes("gpt-5.6-sol"));
  assert.ok(texts.some((text) => text.includes(`desc:${IMAGE_B.slice(-8)}`)));
  assert.ok(texts.includes("what do you see"));

  // A later request with the same image hits the cache, not the vision API.
  const cached = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-token" },
    body: JSON.stringify(deepSeekRequest([IMAGE_A])),
  });
  assert.equal(cached.status, 200);
  assert.equal(chatGptCalls.filter((call) => call.kind === "describe").length, 2);
  assert.ok(collectText(deepSeekReceived[1]).some((text) => text.includes(`desc:${IMAGE_A.slice(-8)}`)));
});

test("leaves native GPT passthrough bodies untouched", async (t) => {
  const chatGptCalls = [];
  const chatGpt = createFakeChatGpt(chatGptCalls);
  const chatGptUrl = await listen(chatGpt);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    chatGptBaseUrl: chatGptUrl,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(chatGpt); });

  const original = {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: IMAGE_A }] }],
  };
  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-token" },
    body: JSON.stringify(original),
  });
  assert.equal(response.status, 200);
  assert.equal(chatGptCalls.filter((call) => call.kind === "describe").length, 0);
  assert.deepEqual(chatGptCalls[0].body, original);
});

test("marks images with a placeholder when the vision call fails", async (t) => {
  const chatGptCalls = [];
  const deepSeekReceived = [];
  const chatGpt = createFakeChatGpt(chatGptCalls, { fail: true });
  const deepSeek = createFakeDeepSeek(deepSeekReceived);
  const chatGptUrl = await listen(chatGpt);
  const deepSeekUrl = await listen(deepSeek);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: deepSeekUrl,
    chatGptBaseUrl: chatGptUrl,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(chatGpt); await close(deepSeek); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-token" },
    body: JSON.stringify(deepSeekRequest([IMAGE_A])),
  });
  assert.equal(response.status, 200);
  assert.equal(countImages(deepSeekReceived[0]), 0);
  assert.ok(collectText(deepSeekReceived[0]).some((text) => text.includes("could not analyze")));
});

test("rejects DeepSeek-bound image requests without credentials", async (t) => {
  const chatGptCalls = [];
  const deepSeekReceived = [];
  const chatGpt = createFakeChatGpt(chatGptCalls);
  const deepSeek = createFakeDeepSeek(deepSeekReceived);
  const chatGptUrl = await listen(chatGpt);
  const deepSeekUrl = await listen(deepSeek);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: deepSeekUrl,
    chatGptBaseUrl: chatGptUrl,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(chatGpt); await close(deepSeek); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deepSeekRequest([IMAGE_A])),
  });
  assert.equal(response.status, 401);
  assert.equal(chatGptCalls.length, 0);
  assert.equal(deepSeekReceived.length, 0);
});
