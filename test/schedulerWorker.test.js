import assert from "node:assert/strict";
import test from "node:test";
import {
  createDriftAwareInterval,
  createThrottleResistantInterval,
  isTickThrottled,
} from "../src/utils/schedulerWorker.js";

test("createThrottleResistantInterval falls back to interval mode without Worker API", () => {
  // Node 测试环境没有浏览器 Worker，应走兜底路径
  assert.equal(typeof globalThis.Worker, "undefined");
  const handle = createThrottleResistantInterval(() => {}, 60000);
  assert.equal(handle.mode, "interval");
  assert.equal(handle.alive(), true);
  handle.stop();
  assert.equal(handle.alive(), false);
});

test("createThrottleResistantInterval validates arguments", () => {
  assert.throws(() => createThrottleResistantInterval(null, 1000), TypeError);
  assert.throws(() => createThrottleResistantInterval(() => {}, 0), TypeError);
  assert.throws(
    () => createThrottleResistantInterval(() => {}, Number.NaN),
    TypeError,
  );
});

test("drift-aware interval executes tick and reports throttling drift", async (t) => {
  const realNow = Date.now;
  let nowValue = realNow();
  t.mock.method(Date, "now", () => nowValue);

  let ticks = 0;
  const drifts = [];
  const handle = createDriftAwareInterval(
    () => {
      ticks++;
    },
    20,
    (msg) => drifts.push(msg),
  );

  // 正常触发一次
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(ticks >= 1, "tick should fire on schedule");
  assert.equal(drifts.length, 0);

  // 模拟被节流：真实时间流逝但 Date.now 停滞，下一次触发时漂移超过 2 倍间隔
  const before = ticks;
  await new Promise((r) => setTimeout(r, 100));
  nowValue += 5000;
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(ticks > before, "tick should still fire after throttle period");
  assert.ok(drifts.length >= 1, "drift beyond 2x interval should be reported");

  handle.stop();
  const afterStop = ticks;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ticks, afterStop, "no tick after stop");
});

test("isTickThrottled detects background throttling by tick gap", () => {
  // 前台不判定为节流
  assert.equal(isTickThrottled(1000, 70000, 10000, false), false);
  // 首次（prevTs 为 0/空）不判定
  assert.equal(isTickThrottled(0, 70000, 10000, true), false);
  assert.equal(isTickThrottled(null, 70000, 10000, true), false);
  // 隐藏态 + 间隔正常（<= 2x）不判定
  assert.equal(isTickThrottled(1000, 12000, 10000, true), false);
  // 边界：间隔恰等于阈值上限（20000）不判定（严格大于）
  assert.equal(isTickThrottled(1000, 21000, 10000, true), false);
  // 隐藏态 + 间隔远超预期 -> 判定节流
  assert.equal(isTickThrottled(1000, 70000, 10000, true), true);
  // 自定义阈值
  assert.equal(isTickThrottled(1000, 4000, 1000, true, 2500), true);
  assert.equal(isTickThrottled(1000, 3000, 1000, true, 2500), false);
});
