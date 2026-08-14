import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCatalog } from "../src/catalog.mjs";
import {
  buildInstalledConfig,
  ensureManagedRouterBinding,
  install,
  managedRouterConfigMatches,
  readManagedRouterToken,
  stripBridgeCliPath,
  stripManagedConfig,
  uninstall,
} from "../src/config.mjs";
import { pathsFor, VERSION } from "../src/constants.mjs";
import { readRouterToken, readStoredKey } from "../src/keys.mjs";

const TEMPLATE = {
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  description: "native",
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low", description: "fast" }],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  base_instructions: "You are Codex, an agent based on GPT-5.",
  model_messages: { instructions_template: "You are Codex, an agent based on GPT-5." },
};

const ROUTER_TOKEN = "A".repeat(43);

test("runtime version matches package metadata", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, packageJson.version);
});

test("catalog backfills newly required fields on stale native cache entries", () => {
  const staleTemplate = { ...TEMPLATE };
  delete staleTemplate.base_instructions;
  const catalog = buildCatalog({ models: [staleTemplate] });
  const native = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
  assert.equal(native.supports_reasoning_summaries, false);
  assert.equal(native.prefer_websockets, false);
  assert.equal(native.base_instructions, TEMPLATE.model_messages.instructions_template);
  const deepseek = catalog.models.find((model) => model.slug === "deepseek/deepseek-v4-flash");
  assert.equal(deepseek.supports_reasoning_summaries, false);
  assert.equal(deepseek.base_instructions, "You are Codex, powered by DeepSeek V4 Flash.");
});

test("catalog adds distinct whale-labelled V4 Flash and Pro entries", () => {
  const catalog = buildCatalog({ models: [TEMPLATE] });
  const expected = [
    ["deepseek/deepseek-v4-flash", "🐳 V4 Flash", "DeepSeek V4 Flash"],
    ["deepseek/deepseek-v4-pro", "🐳 V4 Pro", "DeepSeek V4 Pro"],
  ];
  for (const [slug, displayName, productName] of expected) {
    const model = catalog.models.find((candidate) => candidate.slug === slug);
    assert.ok(model);
    assert.equal(model.display_name, displayName);
    assert.equal(model.default_reasoning_level, "max");
    assert.deepEqual(model.supported_reasoning_levels.map(({ effort }) => effort), ["high", "max"]);
    assert.equal(model.base_instructions, `You are Codex, powered by ${productName}.`);
    assert.deepEqual(model.input_modalities, ["text", "image"]);
    assert.equal(model.prefer_websockets, false);
  }
});

test("config injection is root-correct, reversible, and preserves user config", () => {
  const original = 'personality = "pragmatic"\n\n[features]\nmulti_agent = true\n\n[desktop]\ntheme = "light"\n';
  const installed = buildInstalledConfig(original, { port: 10110, catalogPath: "/tmp/models.json", routerToken: ROUTER_TOKEN });
  assert.ok(installed.indexOf("openai_base_url") < installed.indexOf("[features]"));
  assert.match(installed, /model_catalog_json = "\/tmp\/models\.json"/);
  assert.match(installed, /enabled-reasoning-efforts = \[.*"max".*\]/);
  assert.equal(readManagedRouterToken(installed), ROUTER_TOKEN);
  assert.equal(managedRouterConfigMatches(installed, {
    port: 10110,
    catalogPath: "/tmp/models.json",
    routerToken: ROUTER_TOKEN,
  }), true);
  assert.equal(stripManagedConfig(installed), original);
});

test("managed router binding upgrades a legacy URL and preserves user config", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-binding-"));
  const paths = pathsFor(codexHome);
  const original = [
    'personality = "pragmatic"',
    "# DSCodex managed; remove with `dscodex uninstall`",
    'openai_base_url = "http://127.0.0.1:10110/v1"',
    `model_catalog_json = ${JSON.stringify(paths.catalog)}`,
    "",
    "[features]",
    "multi_agent = true",
    "",
  ].join("\n");
  writeFileSync(paths.config, original);

  const result = ensureManagedRouterBinding({ paths, port: 10110 });
  const updated = readFileSync(paths.config, "utf8");
  assert.equal(result.updated, true);
  assert.equal(readRouterToken(paths.keyFile), result.routerToken);
  assert.equal(readManagedRouterToken(updated), result.routerToken);
  assert.equal(managedRouterConfigMatches(updated, {
    port: 10110,
    catalogPath: paths.catalog,
    routerToken: result.routerToken,
  }), true);
  assert.match(updated, /personality = "pragmatic"/);
  assert.match(updated, /\[features\]\nmulti_agent = true/);
});

test("managed router binding refuses a running legacy router before mutation", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-binding-legacy-router-"));
  const paths = pathsFor(codexHome);
  const original = [
    "# DSCodex managed; remove with `dscodex uninstall`",
    'openai_base_url = "http://127.0.0.1:10110/v1"',
    `model_catalog_json = ${JSON.stringify(paths.catalog)}`,
    "",
  ].join("\n");
  writeFileSync(paths.config, original);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.pid, `${JSON.stringify({ pid: process.pid, port: 10110 })}\n`);

  assert.throws(
    () => ensureManagedRouterBinding({ paths, port: 10110 }),
    /older or untrusted DSCodex state is still running/,
  );
  assert.equal(readFileSync(paths.config, "utf8"), original);
  assert.equal(existsSync(paths.keyFile), false);
});

test("managed router binding adopts the installed URL token when state is missing", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-binding-"));
  const paths = pathsFor(codexHome);
  writeFileSync(paths.config, `${buildInstalledConfig("", {
    port: 10110,
    catalogPath: paths.catalog,
    routerToken: ROUTER_TOKEN,
  })}\n`);

  const result = ensureManagedRouterBinding({ paths, port: 10110 });
  assert.equal(result.updated, false);
  assert.equal(result.routerToken, ROUTER_TOKEN);
  assert.equal(readRouterToken(paths.keyFile), ROUTER_TOKEN);
});

test("install and uninstall touch only DSCodex-owned files and lines", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-test-"));
  const paths = pathsFor(codexHome);
  const original = '[features]\nmulti_agent = true\n\n[desktop]\ntheme = "light"\n';
  writeFileSync(paths.config, original);
  writeFileSync(paths.cache, JSON.stringify({ models: [TEMPLATE] }));

  const result = install({ paths, port: 10110 });
  assert.equal(result.catalog.models.length, 3);
  assert.match(result.routerToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(readRouterToken(paths.keyFile), result.routerToken);
  assert.match(readFileSync(paths.config, "utf8"), new RegExp(`127\\.0\\.0\\.1:10110/${result.routerToken}/v1`));
  assert.equal(existsSync(paths.backup), true);
  assert.equal(existsSync(paths.catalog), true);
  assert.match(readFileSync(paths.config, "utf8"), /DSCodex managed/);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.selectionState, "{}\n");
  writeFileSync(paths.bridgeShim, "#!/bin/sh\n");

  uninstall({ paths });
  assert.equal(existsSync(paths.catalog), false);
  assert.equal(existsSync(paths.selectionState), false);
  assert.equal(existsSync(paths.bridgeShim), false);
  assert.equal(readFileSync(paths.config, "utf8"), original);
  assert.equal(readFileSync(paths.backup, "utf8"), original);
});

test("refuses to replace a user-owned openai_base_url", () => {
  assert.throws(
    () => buildInstalledConfig('openai_base_url = "https://example.test/v1"\n', { port: 10110, catalogPath: "/tmp/models.json", routerToken: ROUTER_TOKEN }),
    /user-owned root key/,
  );
});

test("does not install an unauthenticated loopback base URL", () => {
  assert.throws(
    () => buildInstalledConfig("", { port: 10110, catalogPath: "/tmp/models.json" }),
    /requires a router token/,
  );
});

test("install validates router state before changing config or catalog", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-install-failure-"));
  const paths = pathsFor(codexHome);
  const original = "[features]\nmulti_agent = true\n";
  const sensitiveCorruptState = "sk-FAKE-REVIEW-SECRET";
  writeFileSync(paths.config, original);
  writeFileSync(paths.cache, JSON.stringify({ models: [TEMPLATE] }));
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.keyFile, sensitiveCorruptState);

  assert.throws(
    () => install({ paths, port: 10110 }),
    (error) => {
      assert.match(error.message, /Could not read or parse DSCodex config/);
      assert.doesNotMatch(error.message, /FAKE-REVIEW-SECRET/);
      return true;
    },
  );
  assert.equal(readFileSync(paths.config, "utf8"), original);
  assert.equal(existsSync(paths.catalog), false);
  assert.equal(readFileSync(paths.keyFile, "utf8"), sensitiveCorruptState);
});

test("install refuses a running legacy router before publishing authenticated state", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-install-legacy-router-"));
  const paths = pathsFor(codexHome);
  const original = [
    "# DSCodex managed; remove with `dscodex uninstall`",
    'openai_base_url = "http://127.0.0.1:10110/v1"',
    `model_catalog_json = ${JSON.stringify(paths.catalog)}`,
    "",
  ].join("\n");
  writeFileSync(paths.config, original);
  writeFileSync(paths.cache, JSON.stringify({ models: [TEMPLATE] }));
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.pid, `${JSON.stringify({ pid: process.pid, port: 10110 })}\n`);

  assert.throws(
    () => install({ paths, port: 10110 }),
    /older or untrusted DSCodex state is still running/,
  );
  assert.equal(readFileSync(paths.config, "utf8"), original);
  assert.equal(existsSync(paths.catalog), false);
  assert.equal(existsSync(paths.keyFile), false);
  assert.equal(existsSync(paths.backup), false);
});

test("install migrates a legacy Windows plaintext key before returning", () => {
  if (process.platform !== "win32") return;
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-install-migration-"));
  const paths = pathsFor(codexHome);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.keyFile, `${JSON.stringify({ deepseek_api_key: "legacy-install-key" })}\n`);
  writeFileSync(paths.cache, JSON.stringify({ models: [TEMPLATE] }));

  install({ paths, port: 10110 });
  assert.equal(readStoredKey(paths.keyFile), "legacy-install-key");
  assert.equal(readFileSync(paths.keyFile, "utf8").includes("legacy-install-key"), false);
});

test("stripBridgeCliPath removes DSCodex-owned CODEX_CLI_PATH from MCP env tables", () => {
  const shim = "/Users/x/.codex/dscodex/codex-cli-bridge.sh";
  const wrapper = "/repo/src/codex-wrapper.mjs";
  const content = [
    'model = "gpt-5.6-sol"',
    "",
    "[mcp_servers.node_repl]",
    'command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"',
    "",
    "[mcp_servers.node_repl.env]",
    'NODE_REPL_TRUSTED_CODE_PATHS = "/Users/x/.codex"',
    `CODEX_CLI_PATH = "${shim}"`,
    'CODEX_HOME = "/Users/x/.codex"',
    "",
    "[mcp_servers.other.env]",
    `CODEX_CLI_PATH = "${wrapper}"`,
    "",
    "[desktop]",
    'theme = "light"',
    "",
  ].join("\n");

  const stripped = stripBridgeCliPath(content, [shim, wrapper]);
  assert.equal(stripped.includes("CODEX_CLI_PATH"), false);
  assert.match(stripped, /NODE_REPL_TRUSTED_CODE_PATHS/);
  assert.match(stripped, /CODEX_HOME/);
  assert.match(stripped, /\[mcp_servers\.node_repl\]/);
  assert.match(stripped, /theme = "light"/);
});

test("stripBridgeCliPath keeps user-owned CODEX_CLI_PATH and non-MCP tables", () => {
  const shim = "/Users/x/.codex/dscodex/codex-cli-bridge.sh";
  const content = [
    'CODEX_CLI_PATH = "/usr/local/bin/codex"',
    "",
    "[mcp_servers.node_repl.env]",
    'CODEX_CLI_PATH = "/opt/user-owned/codex"',
    "",
  ].join("\n");

  const stripped = stripBridgeCliPath(content, [shim]);
  assert.equal(stripped, content);
});

test("stripBridgeCliPath with no owned values is a no-op", () => {
  const content = '[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = "/x"\n';
  assert.equal(stripBridgeCliPath(content, []), content);
});
