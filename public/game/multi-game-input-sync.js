(function initializeMultiGameInputSync(root) {
  "use strict";

  const SCOPE_PATTERN = /^mg-[a-f0-9]{32}$/;
  const MOUSE_PHASES = {
    mousedown: "down",
    mousemove: "move",
    mouseup: "up",
  };
  const TOUCH_PHASES = {
    touchstart: "down",
    touchmove: "move",
    touchend: "up",
    touchcancel: "cancel",
  };
  const MOUSE_TYPES = { down: "mousedown", move: "mousemove", up: "mouseup" };
  const TOUCH_TYPES = {
    down: "touchstart",
    move: "touchmove",
    up: "touchend",
    cancel: "touchcancel",
  };

  function validateScope(scope) {
    return SCOPE_PATTERN.test(String(scope || ""));
  }

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  function install(win, scope) {
    if (!validateScope(scope)) throw new Error("Invalid MultiGame scope");
    if (win.__MULTI_GAME_INPUT_SYNC__) {
      throw new Error("MultiGame input sync already installed");
    }
    const canvas = win.document.getElementById("GameCanvas");
    if (!canvas || win.parent === win) {
      throw new Error("MultiGame input sync is not supported");
    }

    let enabled = false;
    let mousePressed = false;

    const post = (type, extra) => {
      win.parent.postMessage(
        { channel: "multi-game", version: 1, type, scope, ...extra },
        win.location.origin,
      );
    };
    const normalizePoint = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return {
        x: clamp01((clientX - rect.left) / rect.width),
        y: clamp01((clientY - rect.top) / rect.height),
      };
    };
    const denormalizePoint = (point) => {
      const rect = canvas.getBoundingClientRect();
      return {
        clientX: rect.left + clamp01(point.x) * rect.width,
        clientY: rect.top + clamp01(point.y) * rect.height,
      };
    };

    const captureMouse = (event) => {
      if (!enabled || !event.isTrusted) return;
      const phase = MOUSE_PHASES[event.type];
      if (phase === "down") mousePressed = true;
      else if (phase === "up") mousePressed = false;
      else if (!mousePressed) return;
      const point = normalizePoint(event.clientX, event.clientY);
      if (!point) return;
      post("input-sync", {
        input: {
          kind: "mouse",
          phase,
          button: event.button || 0,
          buttons: event.buttons || 0,
          points: [{ id: 0, ...point }],
        },
      });
    };
    const captureTouch = (event) => {
      if (!enabled || !event.isTrusted) return;
      const phase = TOUCH_PHASES[event.type];
      if (!phase || !event.changedTouches?.length) return;
      const points = [];
      for (const touch of event.changedTouches) {
        const point = normalizePoint(touch.clientX, touch.clientY);
        if (point) points.push({ id: touch.identifier ?? 0, ...point });
      }
      if (!points.length) return;
      post("input-sync", { input: { kind: "touch", phase, points } });
    };

    const replayMouse = (input) => {
      const point = input.points?.[0];
      if (!point || !MOUSE_TYPES[input.phase]) return;
      const { clientX, clientY } = denormalizePoint(point);
      canvas.dispatchEvent(
        new win.MouseEvent(MOUSE_TYPES[input.phase], {
          bubbles: true,
          cancelable: true,
          view: win,
          clientX,
          clientY,
          button: input.button || 0,
          buttons: input.buttons || 0,
        }),
      );
    };
    const replayTouch = (input) => {
      const type = TOUCH_TYPES[input.phase];
      if (!type || !input.points?.length) return;
      if (typeof win.TouchEvent !== "function" || typeof win.Touch !== "function") {
        replayMouse(input);
        return;
      }
      const changedTouches = input.points.map((point) => {
        const { clientX, clientY } = denormalizePoint(point);
        return new win.Touch({
          identifier: point.id ?? 0,
          target: canvas,
          clientX,
          clientY,
        });
      });
      const active =
        input.phase === "up" || input.phase === "cancel" ? [] : changedTouches;
      canvas.dispatchEvent(
        new win.TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: active,
          targetTouches: active,
          changedTouches,
        }),
      );
    };

    const handleMessage = (event) => {
      if (
        event.origin !== win.location.origin ||
        event.source !== win.parent
      ) {
        return;
      }
      const payload = event.data;
      if (
        payload?.channel !== "multi-game" ||
        payload.version !== 1 ||
        payload.scope !== scope
      ) {
        return;
      }
      if (payload.type === "input-sync-config") {
        enabled = Boolean(payload.enabled);
        if (!enabled) mousePressed = false;
        return;
      }
      if (payload.type === "input-sync-replay" && enabled) {
        const input = payload.input;
        if (input?.kind === "touch") replayTouch(input);
        else if (input?.kind === "mouse") replayMouse(input);
      }
    };

    for (const type of Object.keys(MOUSE_PHASES)) {
      const target = type === "mouseup" ? win : canvas;
      target.addEventListener(type, captureMouse, true);
    }
    for (const type of Object.keys(TOUCH_PHASES)) {
      canvas.addEventListener(type, captureTouch, true);
    }
    win.addEventListener("message", handleMessage);

    win.__MULTI_GAME_INPUT_SYNC__ = { scope };
    return { scope };
  }

  const api = { validateScope, install };
  root.MultiGameInputSync = api;

  if (
    root.window === root &&
    root.document &&
    root.parent &&
    root.parent !== root
  ) {
    const scope = root.__MULTI_GAME_BRIDGE_READY__?.scope;
    if (validateScope(scope)) {
      try {
        install(root, scope);
      } catch {
        // Input sync is optional; the game still runs without it.
      }
    }
  }
})(globalThis);