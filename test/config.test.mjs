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
import { readRouterToken, readStoredKey, writeRouterToken } from "../src/keys.mjs";

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

test("managed config routes Realtime sideband through the authenticated loopback router", () => {
  const original = "[features]\nrealtime_conversation = true\n\n[desktop]\ntheme = \"light\"\n";
  const installed = buildInstalledConfig(original, {
    port: 10110,
    catalogPath: "/tmp/models.json",
    routerToken: ROUTER_TOKEN,
  });

  assert.match(
    installed,
    new RegExp(`experimental_realtime_ws_base_url = "http://127\\.0\\.0\\.1:10110/${ROUTER_TOKEN}/v1/realtime"`),
  );
  assert.equal(stripManagedConfig(installed), original);
});

test("managed config selects an authenticated HTTP-only DSCodex provider", () => {
  const original = [
    'personality = "pragmatic"',
    "",
    "[model_providers.company]",
    'name = "Company Gateway"',
    'base_url = "https://models.example/v1"',
    "",
    "[desktop]",
    'theme = "light"',
    "",
  ].join("\n");
  const installed = buildInstalledConfig(original, {
    port: 10110,
    catalogPath: "/tmp/models.json",
    routerToken: ROUTER_TOKEN,
  });

  assert.ok(installed.indexOf('model_provider = "dscodex"') < installed.indexOf("[model_providers.company]"));
  assert.match(installed, /\[model_providers\.dscodex\]/);
  assert.match(installed, /name = "DSCodex"/);
  assert.match(
    installed,
    new RegExp(`base_url = "http://127\\.0\\.0\\.1:10110/${ROUTER_TOKEN}/v1"`),
  );
  assert.match(installed, /wire_api = "responses"/);
  assert.match(installed, /requires_openai_auth = true/);
  assert.match(installed, /supports_websockets = false/);
  assert.match(installed, /\[model_providers\.company\]\nname = "Company Gateway"/);
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

test("managed router binding upgrades the Realtime-era block and preserves another provider", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-binding-provider-upgrade-"));
  const paths = pathsFor(codexHome);
  const oldToken = "B".repeat(43);
  const original = [
    'personality = "pragmatic"',
    "# DSCodex managed; remove with `dscodex uninstall`",
    `openai_base_url = "http://127.0.0.1:10001/${oldToken}/v1"`,
    `experimental_realtime_ws_base_url = "http://127.0.0.1:10001/${oldToken}/v1/realtime"`,
    `model_catalog_json = ${JSON.stringify(paths.catalog)}`,
    "",
    "[model_providers.company]",
    'name = "Company Gateway"',
    'base_url = "https://models.example/v1"',
    "",
    "[desktop]",
    'theme = "light"',
    "",
  ].join("\n");
  writeFileSync(paths.config, original);

  const result = ensureManagedRouterBinding({ paths, port: 10110 });
  const updated = readFileSync(paths.config, "utf8");

  assert.equal(result.updated, true);
  assert.equal(result.routerToken, oldToken);
  assert.match(updated, /model_provider = "dscodex"/);
  assert.match(updated, /\[model_providers\.dscodex\]/);
  assert.match(
    updated,
    new RegExp(`base_url = "http://127\\.0\\.0\\.1:10110/${oldToken}/v1"`),
  );
  assert.match(updated, /\[model_providers\.company\]\nname = "Company Gateway"/);
  assert.equal(stripManagedConfig(updated), [
    'personality = "pragmatic"',
    "",
    "[model_providers.company]",
    'name = "Company Gateway"',
    'base_url = "https://models.example/v1"',
    "",
    "[desktop]",
    'theme = "light"',
    "",
  ].join("\n"));
});

test("managed router binding refuses a user-owned DSCodex provider before mutation", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-binding-user-provider-"));
  const paths = pathsFor(codexHome);
  const original = [
    "# DSCodex managed; remove with `dscodex uninstall`",
    'openai_base_url = "http://127.0.0.1:10110/v1"',
    `model_catalog_json = ${JSON.stringify(paths.catalog)}`,
    "",
    "[model_providers.dscodex]",
    'name = "User-owned provider"',
    'base_url = "https://user.example/v1"',
    "",
  ].join("\n");
  writeFileSync(paths.config, original);

  assert.throws(
    () => ensureManagedRouterBinding({ paths, port: 10110 }),
    /Refusing to replace user-owned provider: model_providers\.dscodex/,
  );
  assert.equal(readFileSync(paths.config, "utf8"), original);
  assert.equal(existsSync(paths.keyFile), false);
});

test("managed router binding rejects a quoted DSCodex provider table before mutation", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-binding-quoted-provider-"));
  const paths = pathsFor(codexHome);
  const original = [
    "# DSCodex managed; remove with `dscodex uninstall`",
    'openai_base_url = "http://127.0.0.1:10110/v1"',
    `model_catalog_json = ${JSON.stringify(paths.catalog)}`,
    "",
    '["model_providers".dscodex]',
    'name = "User-owned provider"',
    'base_url = "https://user.example/v1"',
    "",
  ].join("\n");
  writeFileSync(paths.config, original);

  assert.throws(
    () => ensureManagedRouterBinding({ paths, port: 10110 }),
    /Refusing to replace user-owned provider: model_providers\.dscodex/,
  );
  assert.equal(readFileSync(paths.config, "utf8"), original);
  assert.equal(existsSync(paths.keyFile), false);
});

test("refuses to replace a user-owned model_provider", () => {
  assert.throws(
    () => buildInstalledConfig('model_provider = "company"\n', {
      port: 10110,
      catalogPath: "/tmp/models.json",
      routerToken: ROUTER_TOKEN,
    }),
    /Refusing to replace user-owned root key: model_provider/,
  );
});

test("legacy migration does not claim a model_provider inserted inside the old managed span", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-binding-interleaved-provider-"));
  const paths = pathsFor(codexHome);
  const original = [
    "# DSCodex managed; remove with `dscodex uninstall`",
    'openai_base_url = "http://127.0.0.1:10110/v1"',
    'experimental_realtime_ws_base_url = "wss://router.example/v1/realtime"',
    'model_provider = "company"',
    `model_catalog_json = ${JSON.stringify(paths.catalog)}`,
    "",
    "[model_providers.company]",
    'name = "Company Gateway"',
    'base_url = "https://models.example/v1"',
    "",
  ].join("\n");
  writeFileSync(paths.config, original);

  assert.throws(
    () => ensureManagedRouterBinding({ paths, port: 10110 }),
    /Refusing to replace user-owned root key: model_provider/,
  );
  assert.equal(readFileSync(paths.config, "utf8"), original);
  assert.equal(existsSync(paths.keyFile), false);
});

for (const placement of ["before", "after"]) {
  test(`managed router binding refuses a user-owned Realtime URL ${placement} a legacy managed block`, () => {
    const codexHome = mkdtempSync(join(tmpdir(), `dscodex-binding-user-realtime-${placement}-`));
    const paths = pathsFor(codexHome);
    const managed = [
      "# DSCodex managed; remove with `dscodex uninstall`",
      'openai_base_url = "http://127.0.0.1:10110/v1"',
      `model_catalog_json = ${JSON.stringify(paths.catalog)}`,
    ];
    const userOwned = 'experimental_realtime_ws_base_url = "wss://user.example/v1/realtime"';
    const original = [
      ...(placement === "before" ? [userOwned] : []),
      ...managed,
      ...(placement === "after" ? [userOwned] : []),
      "",
      "[features]",
      "multi_agent = true",
      "",
    ].join("\n");
    writeFileSync(paths.config, original);

    assert.throws(
      () => ensureManagedRouterBinding({ paths, port: 10110 }),
      /Refusing to replace user-owned root key: experimental_realtime_ws_base_url/,
    );
    assert.equal(readFileSync(paths.config, "utf8"), original);
    assert.equal(existsSync(paths.keyFile), false);
    assert.match(stripManagedConfig(original), /experimental_realtime_ws_base_url = "wss:\/\/user\.example\/v1\/realtime"/);
  });
}

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

test("managed router binding updates both managed URLs when the port changes", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-binding-port-"));
  const paths = pathsFor(codexHome);
  const userConfig = '[desktop]\ntheme = "light"\n';
  writeFileSync(paths.config, buildInstalledConfig(userConfig, {
    port: 10001,
    catalogPath: paths.catalog,
    routerToken: ROUTER_TOKEN,
  }));

  const result = ensureManagedRouterBinding({ paths, port: 10110 });
  const updated = readFileSync(paths.config, "utf8");

  assert.equal(result.updated, true);
  assert.equal(updated.includes("127.0.0.1:10001"), false);
  assert.equal(managedRouterConfigMatches(updated, {
    port: 10110,
    catalogPath: paths.catalog,
    routerToken: ROUTER_TOKEN,
  }), true);
  assert.equal(stripManagedConfig(updated), userConfig);
});

test("managed router binding updates every managed URL when the persisted token changes", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-binding-token-"));
  const paths = pathsFor(codexHome);
  const replacementToken = "B".repeat(43);
  const userConfig = '[desktop]\ntheme = "light"\n';
  writeFileSync(paths.config, buildInstalledConfig(userConfig, {
    port: 10110,
    catalogPath: paths.catalog,
    routerToken: ROUTER_TOKEN,
  }));
  writeRouterToken(paths.keyFile, replacementToken);

  const result = ensureManagedRouterBinding({ paths, port: 10110 });
  const updated = readFileSync(paths.config, "utf8");

  assert.equal(result.updated, true);
  assert.equal(updated.includes(ROUTER_TOKEN), false);
  assert.equal(managedRouterConfigMatches(updated, {
    port: 10110,
    catalogPath: paths.catalog,
    routerToken: replacementToken,
  }), true);
  assert.equal(stripManagedConfig(updated), userConfig);
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

test("uninstall removes only the managed DSCodex provider", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-uninstall-provider-"));
  const paths = pathsFor(codexHome);
  const original = [
    'personality = "pragmatic"',
    "",
    "[model_providers.company]",
    'name = "Company Gateway"',
    'base_url = "https://models.example/v1"',
    "",
    "[desktop]",
    'theme = "light"',
    "",
  ].join("\n");
  writeFileSync(paths.config, buildInstalledConfig(original, {
    port: 10110,
    catalogPath: paths.catalog,
    routerToken: ROUTER_TOKEN,
  }));

  uninstall({ paths });

  assert.equal(readFileSync(paths.config, "utf8"), original);
});

test("uninstall is transactional when the managed provider was customized", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-uninstall-customized-provider-"));
  const paths = pathsFor(codexHome);
  const original = '[desktop]\ntheme = "light"\n';
  writeFileSync(paths.config, original);
  writeFileSync(paths.cache, JSON.stringify({ models: [TEMPLATE] }));
  install({ paths, port: 10110 });
  const customized = readFileSync(paths.config, "utf8").replace(
    "supports_websockets = false\n",
    "supports_websockets = false\nrequest_max_retries = 2\n",
  );
  writeFileSync(paths.config, customized);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.selectionState, "{}\n");
  const keyBefore = readFileSync(paths.keyFile, "utf8");
  const catalogBefore = readFileSync(paths.catalog, "utf8");

  assert.throws(
    () => uninstall({ paths }),
    /Refusing to uninstall while the managed DSCodex provider is customized/,
  );
  assert.equal(readFileSync(paths.config, "utf8"), customized);
  assert.equal(readFileSync(paths.keyFile, "utf8"), keyBefore);
  assert.equal(readFileSync(paths.catalog, "utf8"), catalogBefore);
  assert.equal(existsSync(paths.selectionState), true);
});

for (const [description, original] of [
  ["quoted root model_provider", '"model_provider" = "company"\n'],
  ["quoted DSCodex provider table", '["model_providers".dscodex]\nname = "User"\n'],
  ["dotted DSCodex provider assignment", 'model_providers.dscodex = { name = "User" }\n'],
  ["inline model_providers table", 'model_providers = { company = { name = "User" } }\n'],
  ["parent-table DSCodex assignment", '[model_providers]\n"dscodex" = { name = "User" }\n'],
]) {
  test(`install rejects ${description} without publishing state`, () => {
    const codexHome = mkdtempSync(join(tmpdir(), "dscodex-install-toml-conflict-"));
    const paths = pathsFor(codexHome);
    writeFileSync(paths.config, original);
    writeFileSync(paths.cache, JSON.stringify({ models: [TEMPLATE] }));

    assert.throws(
      () => install({ paths, port: 10110 }),
      /Refusing to replace user-owned (?:root key|provider)/,
    );
    assert.equal(readFileSync(paths.config, "utf8"), original);
    assert.equal(existsSync(paths.keyFile), false);
    assert.equal(existsSync(paths.catalog), false);
    assert.equal(existsSync(paths.backup), false);
  });
}

test("TOML ownership ignores key and table lookalikes inside multiline strings", () => {
  const original = [
    'developer_instructions = """',
    'model_provider = "this is documentation, not a key"',
    "[model_providers.dscodex]",
    'name = "also documentation"',
    "[desktop]",
    'enabled-reasoning-efforts = ["not", "configuration"]',
    '"""',
    "",
    "[desktop]",
    'theme = "light"',
    "",
  ].join("\n");

  const installed = buildInstalledConfig(original, {
    port: 10110,
    catalogPath: "/tmp/models.json",
    routerToken: ROUTER_TOKEN,
  });

  assert.equal(stripManagedConfig(installed), original);
});

for (const delimiter of ['"""', "'''"]) {
  test(`managed-block removal ignores exact snippets inside ${delimiter} strings`, () => {
    const original = [
      `developer_instructions = ${delimiter}`,
      "# DSCodex managed; remove with `dscodex uninstall`",
      'openai_base_url = "http://127.0.0.1:10110/not-config/v1"',
      'experimental_realtime_ws_base_url = "http://127.0.0.1:10110/not-config/v1/realtime"',
      'model_provider = "dscodex"',
      'model_catalog_json = "/not/config.json"',
      "# DSCodex managed; remove with `dscodex uninstall`",
      "[model_providers.dscodex]",
      'name = "DSCodex"',
      'base_url = "http://127.0.0.1:10110/not-config/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "supports_websockets = false",
      "[desktop]",
      "# DSCodex managed; remove with `dscodex uninstall`",
      'enabled-reasoning-efforts = ["low", "max"]',
      delimiter,
      "",
      "[desktop]",
      'theme = "light"',
      "",
    ].join("\n");

    assert.equal(stripManagedConfig(original), original);
    const installed = buildInstalledConfig(original, {
      port: 10110,
      catalogPath: "/tmp/models.json",
      routerToken: ROUTER_TOKEN,
    });
    assert.equal(stripManagedConfig(installed), original);
  });
}

test("TOML ownership ignores table lookalikes inside multiline arrays", () => {
  const original = [
    "allowed_values = [",
    "  [true],",
    '  ["desktop"]',
    "]",
    'personality = "pragmatic"',
    "",
    "[desktop]",
    'theme = "light"',
    "",
  ].join("\n");

  const installed = buildInstalledConfig(original, {
    port: 10110,
    catalogPath: "/tmp/models.json",
    routerToken: ROUTER_TOKEN,
  });

  assert.ok(installed.indexOf("openai_base_url") > installed.indexOf('\n]\npersonality = "pragmatic"'));
  assert.equal(stripManagedConfig(installed), original);
});

test("root conflicts after multiline arrays still refuse before installation", () => {
  const original = [
    "allowed_values = [",
    "  [true],",
    '  ["desktop"]',
    "]",
    '"model_provider" = "company"',
    "",
  ].join("\n");

  assert.throws(
    () => buildInstalledConfig(original, {
      port: 10110,
      catalogPath: "/tmp/models.json",
      routerToken: ROUTER_TOKEN,
    }),
    /Refusing to replace user-owned root key: model_provider/,
  );
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
