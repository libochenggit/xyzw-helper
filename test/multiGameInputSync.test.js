import assert from "node:assert/strict";
import test from "node:test";
import { resolveMultiGameInputSyncMessage } from "../src/utils/gameLauncher.js";

delete globalThis.MultiGameInputSync;
await import("../public/game/multi-game-input-sync.js").catch(() => undefined);
const inputSync = globalThis.MultiGameInputSync || {};

const SCOPE = "mg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SCOPE = "mg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORIGIN = "https://helper.example";

function createMockFrame({
  rect = { left: 10, top: 20, width: 200, height: 400 },
} = {}) {
  const canvasListeners = new Map();
  const windowListeners = new Map();
  const dispatched = [];
  const posted = [];
  const canvas = {
    getBoundingClientRect: () => ({ ...rect }),
    addEventListener(type, listener) {
      canvasListeners.set(type, listener);
    },
    dispatchEvent(event) {
      dispatched.push(event);
      return true;
    },
  };
  class MockMouseEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
      this.isTrusted = false;
    }
  }
  class MockTouch {
    constructor(init) {
      Object.assign(this, init);
    }
  }
  class MockTouchEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
      this.isTrusted = false;
    }
  }
  const win = {
    document: {
      getElementById: (id) => (id === "GameCanvas" ? canvas : null),
    },
    location: { origin: ORIGIN },
    parent: {
      postMessage(payload, origin) {
        posted.push({ payload, origin });
      },
    },
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    MouseEvent: MockMouseEvent,
    Touch: MockTouch,
    TouchEvent: MockTouchEvent,
  };
  win.window = win;

  const fireCanvas = (type, props) =>
    canvasListeners.get(type)?.({ type, isTrusted: true, ...props });
  const fireWindow = (type, props) =>
    windowListeners.get(type)?.({ type, isTrusted: true, ...props });
  const deliver = (data, { origin = ORIGIN, source = win.parent } = {}) =>
    windowListeners.get("message")?.({ data, origin, source });
  const config = (enabled, scope = SCOPE) =>
    deliver({
      channel: "multi-game",
      version: 1,
      type: "input-sync-config",
      scope,
      enabled,
    });
  const replay = (input, overrides = {}) =>
    deliver(
      {
        channel: "multi-game",
        version: 1,
        type: "input-sync-replay",
        scope: SCOPE,
        input,
      },
      overrides,
    );

  return {
    win,
    dispatched,
    posted,
    fireCanvas,
    fireWindow,
    deliver,
    config,
    replay,
    MockMouseEvent,
    MockTouchEvent,
  };
}

test("install rejects invalid scopes and duplicate installation", () => {
  assert.equal(typeof inputSync.install, "function");
  const frame = createMockFrame();
  assert.throws(
    () => inputSync.install(frame.win, "../shared"),
    /Invalid MultiGame scope/,
  );
  inputSync.install(frame.win, SCOPE);
  assert.throws(() => inputSync.install(frame.win, SCOPE), /already installed/);
});

test("trusted mouse input is normalized against the canvas and forwarded", () => {
  const frame = createMockFrame();
  inputSync.install(frame.win, SCOPE);
  frame.config(true);

  frame.fireCanvas("mousemove", { clientX: 110, clientY: 220 });
  assert.deepEqual(frame.posted, []);

  frame.fireCanvas("mousedown", {
    clientX: 110,
    clientY: 220,
    button: 0,
    buttons: 1,
  });
  frame.fireCanvas("mousemove", { clientX: 60, clientY: 120, buttons: 1 });
  frame.fireWindow("mouseup", { clientX: 60, clientY: 120 });

  assert.equal(frame.posted.length, 3);
  for (const message of frame.posted) {
    assert.equal(message.origin, ORIGIN);
    assert.equal(message.payload.channel, "multi-game");
    assert.equal(message.payload.version, 1);
    assert.equal(message.payload.type, "input-sync");
    assert.equal(message.payload.scope, SCOPE);
    assert.equal(message.payload.input.kind, "mouse");
  }
  assert.deepEqual(
    frame.posted.map((message) => message.payload.input.phase),
    ["down", "move", "up"],
  );
  assert.deepEqual(frame.posted[0].payload.input.points, [
    { id: 0, x: 0.5, y: 0.5 },
  ]);
  assert.deepEqual(frame.posted[1].payload.input.points, [
    { id: 0, x: 0.25, y: 0.25 },
  ]);
});

test("replayed synthetic events are never forwarded again", () => {
  const frame = createMockFrame();
  inputSync.install(frame.win, SCOPE);
  frame.config(true);

  frame.fireCanvas("mousedown", {
    isTrusted: false,
    clientX: 110,
    clientY: 220,
  });
  frame.fireCanvas("touchstart", {
    isTrusted: false,
    changedTouches: [{ identifier: 0, clientX: 110, clientY: 220 }],
  });
  assert.deepEqual(frame.posted, []);
});

test("disabled sync neither forwards nor replays input", () => {
  const frame = createMockFrame();
  inputSync.install(frame.win, SCOPE);

  frame.fireCanvas("mousedown", { clientX: 110, clientY: 220 });
  assert.deepEqual(frame.posted, []);

  frame.config(true);
  frame.config(false);
  frame.fireCanvas("mousedown", { clientX: 110, clientY: 220 });
  assert.deepEqual(frame.posted, []);

  frame.replay({
    kind: "mouse",
    phase: "down",
    button: 0,
    buttons: 1,
    points: [{ id: 0, x: 0.5, y: 0.5 }],
  });
  assert.deepEqual(frame.dispatched, []);
});

test("mouse replay lands at the same relative position on a different canvas", () => {
  const frame = createMockFrame({
    rect: { left: 0, top: 0, width: 100, height: 200 },
  });
  inputSync.install(frame.win, SCOPE);
  frame.config(true);

  frame.replay({
    kind: "mouse",
    phase: "down",
    button: 0,
    buttons: 1,
    points: [{ id: 0, x: 0.5, y: 0.5 }],
  });
  frame.replay({
    kind: "mouse",
    phase: "up",
    button: 0,
    buttons: 0,
    points: [{ id: 0, x: 2, y: -1 }],
  });

  assert.equal(frame.dispatched.length, 2);
  const [down, up] = frame.dispatched;
  assert.ok(down instanceof frame.MockMouseEvent);
  assert.equal(down.type, "mousedown");
  assert.equal(down.clientX, 50);
  assert.equal(down.clientY, 100);
  assert.equal(down.buttons, 1);
  assert.equal(up.type, "mouseup");
  assert.equal(up.clientX, 100);
  assert.equal(up.clientY, 0);
});

test("replay rejects foreign origins, sources, scopes and channels", () => {
  const frame = createMockFrame();
  inputSync.install(frame.win, SCOPE);
  frame.config(true);
  const input = {
    kind: "mouse",
    phase: "down",
    button: 0,
    buttons: 1,
    points: [{ id: 0, x: 0.5, y: 0.5 }],
  };

  frame.replay(input, { origin: "https://evil.example" });
  frame.replay(input, { source: {} });
  frame.deliver({
    channel: "multi-game",
    version: 1,
    type: "input-sync-replay",
    scope: OTHER_SCOPE,
    input,
  });
  frame.deliver({
    channel: "other",
    version: 1,
    type: "input-sync-replay",
    scope: SCOPE,
    input,
  });
  frame.deliver({
    channel: "multi-game",
    version: 1,
    type: "input-sync-config",
    scope: OTHER_SCOPE,
    enabled: false,
  });
  frame.fireCanvas("mousedown", { clientX: 110, clientY: 220 });

  assert.deepEqual(frame.dispatched, []);
  assert.equal(frame.posted.length, 1);
});

test("touch input keeps identifiers and replays through TouchEvent", () => {
  const frame = createMockFrame();
  inputSync.install(frame.win, SCOPE);
  frame.config(true);

  frame.fireCanvas("touchstart", {
    changedTouches: [{ identifier: 7, clientX: 110, clientY: 220 }],
  });
  assert.equal(frame.posted.length, 1);
  assert.deepEqual(frame.posted[0].payload.input, {
    kind: "touch",
    phase: "down",
    points: [{ id: 7, x: 0.5, y: 0.5 }],
  });

  frame.replay({
    kind: "touch",
    phase: "down",
    points: [{ id: 7, x: 0.5, y: 0.5 }],
  });
  frame.replay({
    kind: "touch",
    phase: "up",
    points: [{ id: 7, x: 0.5, y: 0.5 }],
  });

  assert.equal(frame.dispatched.length, 2);
  const [down, up] = frame.dispatched;
  assert.ok(down instanceof frame.MockTouchEvent);
  assert.equal(down.type, "touchstart");
  assert.equal(down.changedTouches.length, 1);
  assert.equal(down.changedTouches[0].identifier, 7);
  assert.equal(down.changedTouches[0].clientX, 110);
  assert.equal(down.changedTouches[0].clientY, 220);
  assert.equal(down.touches.length, 1);
  assert.equal(up.type, "touchend");
  assert.equal(up.changedTouches.length, 1);
  assert.equal(up.touches.length, 0);
});

test("touch replay falls back to mouse events without TouchEvent support", () => {
  const frame = createMockFrame();
  delete frame.win.TouchEvent;
  inputSync.install(frame.win, SCOPE);
  frame.config(true);

  frame.replay({
    kind: "touch",
    phase: "down",
    points: [{ id: 7, x: 0.5, y: 0.5 }],
  });

  assert.equal(frame.dispatched.length, 1);
  assert.ok(frame.dispatched[0] instanceof frame.MockMouseEvent);
  assert.equal(frame.dispatched[0].type, "mousedown");
  assert.equal(frame.dispatched[0].clientX, 110);
  assert.equal(frame.dispatched[0].clientY, 220);
});

function createResolverFixture() {
  const source = {};
  const frames = [{ scopeId: SCOPE }];
  const frameElements = new Map([[SCOPE, { contentWindow: source }]]);
  const input = {
    kind: "mouse",
    phase: "down",
    button: 0,
    buttons: 1,
    points: [{ id: 0, x: 0.5, y: 0.5 }],
  };
  const makeEvent = (overrides = {}) => ({
    origin: ORIGIN,
    source,
    data: {
      channel: "multi-game",
      version: 1,
      type: "input-sync",
      scope: SCOPE,
      input,
    },
    ...overrides,
  });
  const resolve = (event) =>
    resolveMultiGameInputSyncMessage({
      event,
      expectedOrigin: ORIGIN,
      frames,
      frameElements,
    });
  return { input, makeEvent, resolve };
}

test("input sync resolver accepts only verified frames and clamps points", () => {
  const { makeEvent, resolve } = createResolverFixture();

  const resolved = resolve(makeEvent());
  assert.equal(resolved.scopeId, SCOPE);
  assert.deepEqual(resolved.input.points, [{ id: 0, x: 0.5, y: 0.5 }]);

  const clamped = resolve(
    makeEvent({
      data: {
        ...makeEvent().data,
        input: {
          kind: "touch",
          phase: "move",
          points: [{ id: 3, x: 1.5, y: -0.2 }],
        },
      },
    }),
  );
  assert.deepEqual(clamped.input.points, [{ id: 3, x: 1, y: 0 }]);
  assert.equal(clamped.input.button, 0);
});

test("input sync resolver rejects spoofed or malformed messages", () => {
  const { makeEvent, resolve } = createResolverFixture();

  assert.equal(resolve(makeEvent({ origin: "https://evil.example" })), null);
  assert.equal(resolve(makeEvent({ source: {} })), null);
  assert.equal(
    resolve(makeEvent({ data: { ...makeEvent().data, scope: OTHER_SCOPE } })),
    null,
  );
  assert.equal(
    resolve(makeEvent({ data: { ...makeEvent().data, type: "ready" } })),
    null,
  );
  assert.equal(
    resolve(
      makeEvent({
        data: {
          ...makeEvent().data,
          input: { kind: "mouse", phase: "hover", points: [{ x: 0, y: 0 }] },
        },
      }),
    ),
    null,
  );
  assert.equal(
    resolve(
      makeEvent({
        data: {
          ...makeEvent().data,
          input: { kind: "mouse", phase: "down", points: [] },
        },
      }),
    ),
    null,
  );
  assert.equal(
    resolve(
      makeEvent({
        data: {
          ...makeEvent().data,
          input: {
            kind: "mouse",
            phase: "down",
            points: [{ x: "left", y: 0 }],
          },
        },
      }),
    ),
    null,
  );
});
