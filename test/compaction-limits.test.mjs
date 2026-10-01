import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compactionBudgetSource,
  compactionTunables,
  DEFAULT_IMAGE_MAX_SIDE,
  DEFAULT_KEEP_RECENT_IMAGES,
  DEFAULT_UPSTREAM_BYTE_BUDGET,
  DEFAULT_WEBP_EFFORT,
  DEFAULT_WEBP_QUALITY,
} from "../src/compaction-limits.mjs";

const DEFAULTS = {
  maxUpstreamBytes: DEFAULT_UPSTREAM_BYTE_BUDGET,
  keepRecentImages: DEFAULT_KEEP_RECENT_IMAGES,
  imageMaxSide: DEFAULT_IMAGE_MAX_SIDE,
  webpQuality: DEFAULT_WEBP_QUALITY,
  webpEffort: DEFAULT_WEBP_EFFORT,
  // No paths.stateDir in these fixtures, so no default drop-in directory either.
  webpEncoderDir: "",
};

function withKeyFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), "dscodex-limits-"));
  const keyFile = join(dir, "config.json");
  if (contents !== null) writeFileSync(keyFile, contents);
  return { keyFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("compaction falls back to the built-in budget when nothing is configured", () => {
  const { keyFile, cleanup } = withKeyFile(null);
  try {
    assert.deepEqual(compactionTunables({ keyFile }, {}), DEFAULTS);
    assert.equal(compactionBudgetSource({ keyFile }, {}), "default");
  } finally {
    cleanup();
  }
});

// The autostarted router never sees a shell variable, so the stored config file
// is the setting that has to work — this is the deviation the recheck found.
test("compaction reads the stored config file the router re-reads on start", () => {
  const { keyFile, cleanup } = withKeyFile(JSON.stringify({
    deepseek_api_key: "unused-in-this-test",
    max_upstream_bytes: 12 * 1024 * 1024,
    keep_recent_images: 2,
  }));
  try {
    assert.deepEqual(compactionTunables({ keyFile }, {}), {
      ...DEFAULTS,
      maxUpstreamBytes: 12 * 1024 * 1024,
      keepRecentImages: 2,
    });
    assert.equal(compactionBudgetSource({ keyFile }, {}), "config.json:max_upstream_bytes");
  } finally {
    cleanup();
  }
});

test("a one-off environment variable wins over the stored value", () => {
  const { keyFile, cleanup } = withKeyFile(JSON.stringify({ max_upstream_bytes: 12 * 1024 * 1024 }));
  try {
    const tuned = compactionTunables({ keyFile }, {
      DSCODEX_MAX_UPSTREAM_BYTES: "2048",
      DSCODEX_KEEP_RECENT_IMAGES: "1",
      DSCODEX_IMAGE_MAX_SIDE: "1568",
      DSCODEX_WEBP_QUALITY: "82",
    });
    assert.equal(tuned.maxUpstreamBytes, 2048);
    assert.equal(tuned.keepRecentImages, 1);
    assert.equal(tuned.imageMaxSide, 1568);
    assert.equal(tuned.webpQuality, 82);
    assert.equal(compactionBudgetSource({ keyFile }, { DSCODEX_MAX_UPSTREAM_BYTES: "2048" }), "env");
  } finally {
    cleanup();
  }
});

// A budget below one kilobyte would only ever fire on bodies that cannot be
// sent anyway, so it is clamped rather than accepted as a "disable" in disguise.
test("a sub-kilobyte budget clamps to 1KB instead of disabling the compaction", () => {
  const { keyFile, cleanup } = withKeyFile(JSON.stringify({ max_upstream_bytes: 8 }));
  try {
    assert.equal(compactionTunables({ keyFile }, {}).maxUpstreamBytes, 1024);
  } finally {
    cleanup();
  }
});

test("a budget of zero disables the compaction from either source", () => {
  const fromEnv = withKeyFile(null);
  const fromFile = withKeyFile(JSON.stringify({ max_upstream_bytes: 0 }));
  const cleanups = [fromEnv.cleanup, fromFile.cleanup];
  try {
    for (const paths of [fromEnv, fromFile]) {
      const tuned = paths === fromEnv
        ? compactionTunables({ keyFile: paths.keyFile }, { DSCODEX_MAX_UPSTREAM_BYTES: "0" })
        : compactionTunables({ keyFile: paths.keyFile }, {});
      assert.equal(tuned.maxUpstreamBytes, Number.POSITIVE_INFINITY);
    }
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
});

test("nonsense values fall back to the default, and a negative window clamps to 1", () => {
  const { keyFile, cleanup } = withKeyFile(JSON.stringify({
    max_upstream_bytes: "not-a-number",
    keep_recent_images: -5,
  }));
  try {
    const tuned = compactionTunables({ keyFile }, { DSCODEX_MAX_UPSTREAM_BYTES: "", DSCODEX_KEEP_RECENT_IMAGES: "banana" });
    assert.equal(tuned.maxUpstreamBytes, DEFAULT_UPSTREAM_BYTE_BUDGET);
    assert.equal(tuned.keepRecentImages, 1);
  } finally {
    cleanup();
  }
});
