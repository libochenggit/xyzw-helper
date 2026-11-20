import assert from "node:assert/strict";
import test from "node:test";

/** 构造最小浏览器环境 mock，并重新加载保活模块（绕过 ESM 缓存） */
async function loadModuleWithMocks({
  audioSupported = true,
  initialState = "running",
  gestureRequired = false,
} = {}) {
  const listeners = {};
  const sources = [];
  const contexts = [];
  const gains = [];
  const buffers = [];

  class MockAudioContext {
    constructor() {
      this.state = gestureRequired ? "suspended" : initialState;
      this.sampleRate = 44100;
      this.destination = {};
      this.resumeCalls = 0;
      this.closed = false;
      contexts.push(this);
    }

    resume() {
      this.resumeCalls++;
      // gestureRequired 模式下需先标记手势才允许恢复
      if (!gestureRequired || this.gestureSeen) {
        this.state = "running";
      }
      return Promise.resolve();
    }

    close() {
      this.closed = true;
      this.state = "closed";
      return Promise.resolve();
    }

    createGain() {
      const gainNode = { gain: { value: 1 }, connect() {}, disconnect() {} };
      gains.push(gainNode);
      return gainNode;
    }

    createBuffer(channels, length) {
      const data = new Float32Array(length);
      const buffer = {
        channels,
        length,
        getChannelData() {
          return data;
        },
      };
      buffers.push(buffer);
      return buffer;
    }

    createBufferSource() {
      const source = {
        buffer: null,
        loop: false,
        started: false,
        stopped: false,
        connect() {},
        start() {
          this.started = true;
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    }
  }

  const sandbox = {
    console,
    Promise,
    listeners,
    sources,
    contexts,
  };

  globalThis.document = {
    visibilityState: "visible",
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).filter((h) => h !== handler);
    },
  };

  if (audioSupported) {
    globalThis.AudioContext = MockAudioContext;
  } else {
    delete globalThis.AudioContext;
    delete globalThis.webkitAudioContext;
  }

  delete globalThis.navigator;
  sandbox.__listeners = listeners;

  const module = await import(
    `../src/utils/backgroundKeepAlive.js?t=${Math.random()}`
  );
  return { module, sandbox, listeners, sources, contexts, gains, buffers };
}

function cleanupGlobals() {
  delete globalThis.document;
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  delete globalThis.localStorage;
}

test("保活音频立即启动成功时进入 running 状态（非零增益 + 非零噪声）", async () => {
  const { module, sources, contexts, gains, buffers } =
    await loadModuleWithMocks();
  try {
    const running = module.startKeepAlive();
    assert.equal(running, true);
    assert.equal(contexts.length, 1);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].loop, true);
    assert.equal(sources[0].started, true);
    // 关键：增益必须为非零，否则 Chrome 判定为静音而不豁免后台节流
    assert.ok(gains[0].gain.value > 0, "gain must be non-zero");
    assert.equal(gains[0].gain.value, 0.004);
    // buffer 必须填充非零噪声样本
    const data = buffers[0].getChannelData(0);
    assert.ok(
      data.some((v) => v !== 0),
      "buffer must contain non-zero samples",
    );
    const state = module.getKeepAliveState();
    assert.equal(state.enabled, true);
    assert.equal(state.supported, true);
    assert.equal(state.audioState, "running");
    assert.equal(state.level, "medium");
    assert.equal(state.gain, 0.004);
  } finally {
    module.__resetKeepAliveForTest();
    cleanupGlobals();
  }
});

test("无用户手势导致挂起时，首次交互自动激活", async () => {
  const { module, listeners, contexts } = await loadModuleWithMocks({
    gestureRequired: true,
  });
  try {
    const running = module.startKeepAlive();
    assert.equal(running, false);
    assert.equal(contexts[0].state, "suspended");

    // 模拟用户手势：允许 resume 后触发 pointerdown
    contexts[0].gestureSeen = true;
    assert.ok(listeners.pointerdown?.length >= 1);
    listeners.pointerdown[0]();

    assert.equal(contexts[0].state, "running");
    assert.equal(module.getKeepAliveState().audioState, "running");
    // 激活成功后手势监听应被移除
    assert.equal(listeners.pointerdown.length, 0);
  } finally {
    module.__resetKeepAliveForTest();
    cleanupGlobals();
  }
});

test("不支持 AudioContext 的环境静默降级", async () => {
  const { module } = await loadModuleWithMocks({ audioSupported: false });
  try {
    assert.equal(module.startKeepAlive(), false);
    assert.equal(module.ensureKeepAliveActive(), false);
    const state = module.getKeepAliveState();
    assert.equal(state.supported, false);
    assert.equal(state.audioState, "none");
    // 不应抛出异常
    module.stopKeepAlive();
  } finally {
    module.__resetKeepAliveForTest();
    cleanupGlobals();
  }
});

test("stopKeepAlive 释放音频资源", async () => {
  const { module, sources, contexts } = await loadModuleWithMocks();
  try {
    module.startKeepAlive();
    module.stopKeepAlive();
    assert.equal(sources[0].stopped, true);
    assert.equal(contexts[0].closed, true);
    assert.equal(module.getKeepAliveState().audioState, "none");
  } finally {
    module.__resetKeepAliveForTest();
    cleanupGlobals();
  }
});

test("ensureKeepAliveActive 恢复被挂起的 AudioContext", async () => {
  const { module, contexts } = await loadModuleWithMocks();
  try {
    module.startKeepAlive();
    // 模拟浏览器在页面隐藏时挂起音频
    contexts[0].state = "suspended";
    const active = module.ensureKeepAliveActive();
    assert.equal(active, true);
    assert.equal(contexts[0].state, "running");
    assert.ok(contexts[0].resumeCalls >= 1);
  } finally {
    module.__resetKeepAliveForTest();
    cleanupGlobals();
  }
});

test("setKeepAliveLevel 即时更新运行中音频的增益", async () => {
  const { module, gains } = await loadModuleWithMocks();
  try {
    module.startKeepAlive();
    assert.equal(gains[0].gain.value, 0.004);
    module.setKeepAliveLevel("high");
    assert.equal(gains[0].gain.value, 0.008);
    assert.equal(module.getKeepAliveState().level, "high");
    // 非法档位回退默认
    module.setKeepAliveLevel("unknown");
    assert.equal(gains[0].gain.value, 0.004);
    assert.equal(module.getKeepAliveState().level, "medium");
  } finally {
    module.__resetKeepAliveForTest();
    cleanupGlobals();
  }
});

test("loadKeepAliveLevel 无持久化时返回默认 medium", async () => {
  const { module } = await loadModuleWithMocks();
  try {
    assert.equal(module.loadKeepAliveLevel(), "medium");
  } finally {
    module.__resetKeepAliveForTest();
    cleanupGlobals();
  }
});
