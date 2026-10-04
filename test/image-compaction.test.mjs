import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ImageTranscodeCache,
  loadWebpEncoder,
  shrinkImagesToBudget,
} from "../src/image-compaction.mjs";
import { DEFAULT_ENCODER_DIRNAME } from "../src/compaction-limits.mjs";

const sizeOf = (body) => Buffer.byteLength(JSON.stringify(body), "utf8");

function imageBody(imageCount, bytesPerImage) {
  const filler = "A".repeat(bytesPerImage);
  return {
    model: "deepseek/deepseek-flash",
    input: Array.from({ length: imageCount }, (_, index) => ({
      type: "function_call_output",
      call_id: `call-${index}`,
      output: [{
        type: "input_image",
        image_url: `data:image/png;base64,${index}${filler}`,
        detail: "high",
      }],
    })),
  };
}

// A stand-in for the real encoder: whatever it returns is what the source would
// become, so a test can decide the outcome in bytes instead of in pixels.
function fixedEncoder(bytes, { skip = () => false, spy } = {}) {
  return async (url, options) => {
    if (spy) spy(url, options);
    return skip(url) ? null : Buffer.alloc(bytes, 7);
  };
}

const blocksOf = (body) => body.input.flatMap((item) => item.output);

test("shrinking covers every picture older than the protected window", async () => {
  const imageCount = 12;
  const keepRecent = 4;
  const body = imageBody(imageCount, 512 * 1024);
  const perImage = sizeOf(body) / imageCount;
  const budget = Math.floor(perImage * 8.5);
  const protectedFrom = imageCount - keepRecent;
  const untouched = blocksOf(body).slice(protectedFrom).map((block) => block.image_url);

  const stats = await shrinkImagesToBudget(body, budget, {
    keepRecent,
    encode: fixedEncoder(1024),
  });

  assert.ok(stats.after <= budget, `expected the body to fit, got ${stats.after} vs ${budget}`);
  assert.equal(stats.images, imageCount);
  assert.equal(stats.transcoded, imageCount - keepRecent,
    "every shrinkable picture is shrunk, so the session keeps real headroom");
  assert.equal(stats.dropped, 0, "no picture should be deleted while shrinking can still fit the body");
  assert.equal(stats.encoder, "webp");

  const blocks = blocksOf(body);
  for (const block of blocks.slice(0, stats.transcoded)) {
    assert.equal(block.type, "input_image", "a shrunk picture is still a picture");
    assert.match(block.image_url, /^data:image\/webp;base64,/);
  }
  // The protected window is byte-identical.
  assert.deepEqual(blocks.slice(protectedFrom).map((block) => block.image_url), untouched);
  // The item that carried a picture keeps its identity and its output array.
  assert.equal(body.input[0].type, "function_call_output");
  assert.equal(body.input[0].call_id, "call-0");
});

test("a body over budget with no encoder falls back to text records", async () => {
  const body = imageBody(12, 512 * 1024);
  const budget = 2 * 1024 * 1024;
  // keepRecent is a hard floor: the newest pictures are never sacrificed, so the
  // budget has to be reachable by dropping the ones in front of them.
  const stats = await shrinkImagesToBudget(body, budget, { keepRecent: 3, encode: null });

  assert.equal(stats.encoder, "unavailable");
  assert.equal(stats.transcoded, 0);
  assert.ok(stats.dropped > 0, "the record path is the last resort and must still run");
  assert.ok(stats.after <= budget);
  assert.equal(blocksOf(body)[0].type, "input_text");
  assert.match(blocksOf(body)[0].text, /image omitted by DSCodex/);
});

test("an image the encoder cannot handle is left alone, the rest still shrink", async () => {
  const body = imageBody(12, 512 * 1024);
  const perImage = sizeOf(body) / 12;
  const stats = await shrinkImagesToBudget(body, Math.floor(perImage * 8.5), {
    keepRecent: 4,
    // The second-oldest picture refuses to encode, like a corrupt file would.
    encode: fixedEncoder(1024, { skip: (url) => url.includes("1AAAA") }),
  });

  const blocks = blocksOf(body);
  assert.equal(blocks[0].type, "input_image");
  assert.match(blocks[0].image_url, /^data:image\/webp;base64,/);
  assert.match(blocks[1].image_url, /^data:image\/png;base64,/, "the rejected picture keeps its bytes");
  assert.ok(stats.transcoded >= 1);
});

test("a second turn reuses the cache instead of encoding again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dscodex-image-cache-"));
  try {
    const source = () => imageBody(12, 512 * 1024);
    const budget = Math.floor((sizeOf(source()) / 12) * 8.5);
    let calls = 0;
    const encode = fixedEncoder(1024, { spy: () => { calls += 1; } });

    const first = await shrinkImagesToBudget(source(), budget, {
      keepRecent: 4, encode, cache: new ImageTranscodeCache(directory),
    });
    const afterFirst = calls;
    assert.equal(first.fromCache, 0);
    assert.equal(afterFirst, first.transcoded, "every transcoded picture was a fresh encode");

    const second = await shrinkImagesToBudget(source(), budget, {
      keepRecent: 4, encode, cache: new ImageTranscodeCache(directory),
    });
    assert.equal(second.transcoded, first.transcoded);
    assert.equal(second.fromCache, second.transcoded, "the second turn must be all cache hits");
    assert.equal(calls, afterFirst, "the encoder must not run again");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a body that already fits is never touched", async () => {
  const body = imageBody(3, 1024);
  const before = JSON.stringify(body);
  let calls = 0;
  const stats = await shrinkImagesToBudget(body, 8 * 1024 * 1024, {
    encode: fixedEncoder(512, { spy: () => { calls += 1; } }),
  });
  assert.equal(stats.transcoded, 0);
  assert.equal(stats.dropped, 0);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(body), before);
});

test("the real encoder produces a WebP DeepSeek can read", async (t) => {
  // The checkout ships no encoder, so this looks where the router looks: the
  // configured directory, then the documented drop-in location under the user's
  // DSCodex state directory.
  const directory = process.env.DSCODEX_WEBP_ENCODER_DIR
    || join(homedir(), ".codex", "dscodex", DEFAULT_ENCODER_DIRNAME);
  const { encode, source } = await loadWebpEncoder({ directory });
  if (!encode) {
    t.skip(`no encoder available (${source})`);
    return;
  }
  // A real 800x600 RGBA PNG, built with the encoder's own library so the fixture
  // cannot be the thing that is wrong. The pixels are noisy on purpose: a flat
  // image compresses so well as PNG that WebP could not beat it, and the code is
  // explicitly forbidden from making a picture bigger.
  const sharp = createRequire(join(directory, "dscodex-encoder.cjs"))("sharp");
  const width = 800;
  const height = 600;
  const pixels = Buffer.alloc(width * height * 4);
  let seed = 12345;
  for (let i = 0; i < pixels.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = seed & 0xff;
    pixels[i + 1] = (seed >> 8) & 0xff;
    pixels[i + 2] = (seed >> 16) & 0xff;
    pixels[i + 3] = (i / 4) % width < width / 2 ? 255 : 0;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  const body = {
    model: "deepseek/deepseek-flash",
    input: [
      { type: "function_call_output", call_id: "call-0", output: [{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" }] },
      { type: "function_call_output", call_id: "call-1", output: [{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" }] },
    ],
  };
  // A budget the original cannot meet but a WebP comfortably can.
  const budget = Math.floor(sizeOf(body) * 0.6);
  const stats = await shrinkImagesToBudget(body, budget, { keepRecent: 1, encode });

  assert.ok(stats.after <= budget, `${stats.after} should fit ${budget}`);
  assert.equal(stats.transcoded, 1, "only the oldest of two pictures needs to shrink");
  const shrunk = blocksOf(body)[0];
  assert.match(shrunk.image_url, /^data:image\/webp;base64,/);
  const decoded = await sharp(Buffer.from(shrunk.image_url.split(",")[1], "base64")).metadata();
  assert.equal(decoded.format, "webp");
  assert.equal(decoded.width, Math.min(width, 1024));
  assert.ok(decoded.hasAlpha, "WebP keeps the alpha channel JPEG would have to flatten");

  const untouched = blocksOf(body)[1];
  assert.match(untouched.image_url, /^data:image\/png;base64,/, "the newest picture is untouched");
});
