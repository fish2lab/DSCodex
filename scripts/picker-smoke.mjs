#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const child = spawn("codex", ["app-server", "--strict-config"], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let stderr = "";
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  console.error(`picker smoke timed out${stderr ? `: ${stderr.trim()}` : ""}`);
  process.exitCode = 1;
}, 8_000);

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

send({
  method: "initialize",
  id: 1,
  params: {
    clientInfo: { name: "dscodex-smoke", title: "DSCodex smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  },
});

child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      send({ method: "initialized" });
      send({ method: "model/list", id: 2, params: { includeHidden: false } });
    }
    if (message.id === 2) {
      assert.ok(
        message.result?.data?.some((item) => item.model.startsWith("gpt-")),
        "native GPT catalog entries were not preserved",
      );
      const expected = [
        ["deepseek/deepseek-flash", "🐳 DeepSeek Flash"],
      ];
      const models = expected.map(([slug, displayName]) => {
        const model = message.result?.data?.find((item) => item.model === slug);
        assert.ok(model, `${displayName} is absent from Codex model/list`);
        assert.equal(model.displayName, displayName);
        assert.equal(model.defaultReasoningEffort, "max");
        assert.deepEqual(model.supportedReasoningEfforts.map((item) => item.reasoningEffort), ["high", "max"]);
        return model;
      });
      console.log(JSON.stringify({
        models: models.map((model) => ({
          model: model.model,
          displayName: model.displayName,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map((item) => item.reasoningEffort),
        })),
        nativeGptPreserved: true,
      }));
      clearTimeout(timer);
      child.kill("SIGTERM");
    }
  }
});

child.once("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
