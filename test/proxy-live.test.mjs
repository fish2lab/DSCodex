import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createProxyServer } from "../src/proxy.mjs";

const ROUTER_TOKEN = "A".repeat(43);

function route(proxyUrl, path = "/v1/responses") {
  return `${proxyUrl}/${ROUTER_TOKEN}${path}`;
}

async function listen(server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections?.();
  await closed;
}

test("forwards POST /v1/live bodies to the upstream without JSON parsing", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      path: request.url,
      contentType: request.headers["content-type"],
      openaiAlpha: request.headers["openai-alpha"],
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      custom: request.headers["x-codex-test-header"],
      userAgent: request.headers["user-agent"],
      body: Buffer.concat(chunks),
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
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const payload = Buffer.from([0x2d, 0x00, 0x01, 0xff]);
  const response = await fetch(route(proxyUrl, "/v1/live"), {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      authorization: "Bearer oauth-token",
      cookie: "session=abc",
      "x-codex-test-header": "custom-value",
      "user-agent": "codex-test",
    },
    body: payload,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(observed.path, "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
  assert.equal(observed.openaiAlpha, "quicksilver=v2");
  assert.equal(observed.contentType, "application/octet-stream");
  assert.equal(observed.authorization, "Bearer oauth-token");
  assert.equal(observed.cookie, "session=abc");
  assert.equal(observed.custom, "custom-value");
  assert.equal(observed.userAgent, "codex-test");
  assert.deepEqual(observed.body, payload);
});

test("posts live calls only to the official realtime/calls route without probing candidates", async (t) => {
  const observed = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({ path: request.url, body: Buffer.concat(chunks) });
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"detail":"Not Found"}');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const payload = Buffer.from([0x2d, 0x00, 0x01, 0xff]);
  const response = await fetch(route(proxyUrl, "/v1/live"), {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: payload,
  });

  assert.equal(response.status, 404);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].path, "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
  assert.deepEqual(observed[0].body, payload);
});

test("converts the live call multipart into the official realtime/calls JSON", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      path: request.url,
      contentType: request.headers["content-type"],
      openaiAlpha: request.headers["openai-alpha"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, {
      "content-type": "application/sdp",
      location: "/v1/realtime/calls/call_test",
    });
    response.end("v=0\r\nanswer-sdp");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=test";
  const session = { model: "gpt-5.6", voice: "alloy" };
  const multipart = [
    "--codex-realtime-call-boundary",
    'Content-Disposition: form-data; name="sdp"',
    "Content-Type: application/sdp",
    "",
    sdp,
    "--codex-realtime-call-boundary",
    'Content-Disposition: form-data; name="session"',
    "Content-Type: application/json",
    "",
    JSON.stringify(session),
    "--codex-realtime-call-boundary--",
    "",
  ].join("\r\n");

  const response = await fetch(route(proxyUrl, "/v1/live"), {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=codex-realtime-call-boundary", authorization: "Bearer oauth-token" },
    body: multipart,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/sdp");
  assert.equal(await response.text(), "v=0\r\nanswer-sdp");
  assert.equal(observed.path, "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
  assert.equal(observed.openaiAlpha, "quicksilver=v2");
  assert.equal(observed.contentType, "application/json");
  assert.equal(observed.body.sdp, sdp);
  assert.deepEqual(observed.body.session, session);
});
