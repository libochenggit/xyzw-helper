import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/views/GameMultiPlayer.vue", import.meta.url),
  "utf8",
);

test("multi-game page explains 32-bit OOM and links to the official 64-bit bundle", () => {
  assert.match(source, /页面崩溃？/);
  assert.match(source, /chrome:\/\/version/);
  assert.match(source, /32 位浏览器/);
  assert.match(
    source,
    /https:\/\/support\.google\.com\/chrome\/a\/answer\/7650032\?hl=zh-Hans/,
  );
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
});

test("multi-game page wraps at five panels per row and scrolls vertically", () => {
  assert.match(source, /flex-flow: row wrap/);
  assert.match(source, /flex: 0 0 calc\(\(100% - 48px\) \/ 5\)/);
  assert.match(source, /overflow-y: auto/);
  assert.ok(!source.includes("handleStripWheel"));
});

test("multi-game page keeps the sync click toggle on the left of the toolbar", () => {
  const toggleIndex = source.indexOf("sync-click-toggle");
  const warningIndex = source.indexOf("toolbar-warning");
  assert.ok(toggleIndex > 0);
  assert.ok(warningIndex > toggleIndex);
});
