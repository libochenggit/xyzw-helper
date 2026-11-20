import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { isTickThrottled } from "../src/utils/schedulerWorker.js";
import {
  findMissedRunTime,
  shouldTaskRunAt,
} from "../src/utils/taskCatchUp.js";

const dailyTask = { id: "t1", runType: "daily", runTime: "08:00" };
const cronTask = { id: "t2", runType: "cron", cronExpression: "*/5 * * * *" };

test("每日任务：窗口内错过后可补跑，窗口外不补跑", () => {
  // 08:05 恢复，10 分钟窗口 → 补跑 08:00
  const missed = findMissedRunTime(
    dailyTask,
    new Date(2026, 10, 19, 8, 5, 30),
    10,
  );
  assert.ok(missed);
  assert.equal(missed.getHours(), 8);
  assert.equal(missed.getMinutes(), 0);

  // 08:20 恢复，10 分钟窗口 → 08:00 已超出窗口，不补跑
  assert.equal(
    findMissedRunTime(dailyTask, new Date(2026, 10, 19, 8, 20, 0), 10),
    null,
  );

  // 窗口为 0 时退化为仅匹配当前分钟（原行为）
  assert.ok(findMissedRunTime(dailyTask, new Date(2026, 10, 19, 8, 0, 59), 0));
  assert.equal(
    findMissedRunTime(dailyTask, new Date(2026, 10, 19, 8, 1, 0), 0),
    null,
  );
});

test("cron 任务：匹配窗口内最近的执行分钟", () => {
  // 10:08 检查，*/5 → 最近匹配 10:05
  const missed = findMissedRunTime(
    cronTask,
    new Date(2026, 10, 19, 10, 8, 0),
    10,
  );
  assert.ok(missed);
  assert.equal(missed.getHours(), 10);
  assert.equal(missed.getMinutes(), 5);

  // 窗口 1 分钟时 10:05 不在范围内
  assert.equal(
    findMissedRunTime(cronTask, new Date(2026, 10, 19, 10, 8, 0), 1),
    null,
  );
});

test("非法 cron 表达式不抛异常", () => {
  const badTask = { id: "t3", runType: "cron", cronExpression: "not a cron" };
  assert.doesNotThrow(() =>
    findMissedRunTime(badTask, new Date(2026, 10, 19, 10, 7, 0), 10),
  );
});

test("shouldTaskRunAt 按分钟精度匹配", () => {
  assert.equal(
    shouldTaskRunAt(dailyTask, new Date(2026, 10, 19, 8, 0, 0)),
    true,
  );
  assert.equal(
    shouldTaskRunAt(dailyTask, new Date(2026, 10, 19, 18, 0, 0)),
    false,
  );
  assert.equal(shouldTaskRunAt({ runType: "unknown" }, new Date()), false);
});

// ==================== Vue schedulerTick 集成（沿用 scheduledTaskRegistry.test.js 的 AST 提取方式） ====================

const source = await readFile(
  new URL("../src/views/BatchDailyTasks.vue", import.meta.url),
  "utf8",
);
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile(
  "BatchDailyTasks.js",
  script,
  ts.ScriptTarget.ES2022,
  true,
);
const declaration = ast.statements.find(
  (node) =>
    ts.isVariableStatement(node) &&
    node.getText().includes("const schedulerTick"),
);
assert.ok(declaration, "schedulerTick declaration should exist");

function createSchedulerContext({ storedKeys = {} }) {
  const store = { ...storedKeys };
  const executed = [];
  const logs = [];
  const context = vm.createContext({
    Date,
    Number,
    console,
    findMissedRunTime,
    isTickThrottled,
    keepAliveThrottled: { value: false },
    lastSchedulerTickTs: 0,
    scheduledTasks: {
      value: [
        {
          id: "t1",
          name: "每日任务",
          enabled: true,
          runType: "daily",
          runTime: "08:00",
        },
      ],
    },
    batchSettings: { catchUpWindowMinutes: 10 },
    localStorage: {
      getItem: (key) => store[key] ?? null,
      setItem: (key, value) => {
        store[key] = value;
      },
    },
    addLog: (entry) => logs.push(entry),
    executeScheduledTask: (task) => executed.push(task),
    lastTaskExecution: null,
  });
  // vm 中 const 声明不会挂到 context 对象上，附加表达式求值取回函数
  const tick = vm.runInContext(
    `${declaration.getText(ast)}\n;schedulerTick;`,
    context,
  );
  return { tick, executed, logs, store };
}

const RealDate = Date;

/**
 * 冻结全局 Date 到指定时刻（无参 new Date() 与 Date.now() 均返回该时刻）。
 * @param {number[]} args 传给 Date 构造函数的参数（如年月日时分秒）
 * @returns {Function} 恢复真实 Date 的函数
 */
function freezeTime(...args) {
  const fixedMs = new RealDate(...args).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...ctorArgs) {
      if (ctorArgs.length === 0) {
        super(fixedMs);
      } else {
        super(...ctorArgs);
      }
    }

    static now() {
      return fixedMs;
    }
  };
  return () => {
    globalThis.Date = RealDate;
  };
}

test("schedulerTick 在窗口内补跑错过的任务且仅执行一次", () => {
  // 冻结当前时间为 08:05:30（任务 08:00 被错过）
  const restore = freezeTime(2026, 10, 19, 8, 5, 30);
  try {
    const { tick, executed, logs, store } = createSchedulerContext({});
    tick();
    assert.equal(executed.length, 1);
    assert.ok(logs.some((l) => l.message.includes("补跑")));
    assert.equal(store.lastTaskExecution_t1, "t1_19_8_0");

    // 同一分钟内再次 tick 不重复执行
    tick();
    assert.equal(executed.length, 1);
  } finally {
    restore();
  }
});

test("schedulerTick 对窗口外/已执行的任务不触发", () => {
  const restore = freezeTime(2026, 10, 19, 8, 20, 0);
  try {
    // 08:20 时 08:00 已超出 10 分钟窗口 → 不执行
    const outside = createSchedulerContext({});
    outside.tick();
    assert.equal(outside.executed.length, 0);

    // 08:05 窗口内但去重 key 已存在 → 不执行
    const restore2 = freezeTime(2026, 10, 19, 8, 5, 10);
    const deduped = createSchedulerContext({
      storedKeys: { lastTaskExecution_t1: "t1_19_8_0" },
    });
    deduped.tick();
    assert.equal(deduped.executed.length, 0);
    restore2();
  } finally {
    restore();
  }
});
