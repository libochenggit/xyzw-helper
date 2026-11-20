/**
 * 抗节流调度器
 *
 * 隐藏标签页中主线程 setInterval 会被浏览器节流（1次/分钟，甚至密集节流冻结），
 * 导致定时任务调度器停摆。Web Worker 的定时器不受隐藏页节流影响，
 * 因此主路径用内联 Worker 发 tick 消息驱动主线程执行；
 * Worker 不可用时退回普通 setInterval，并带漂移检测补偿。
 */

const WORKER_SOURCE = `
self.onmessage = function (e) {
  var interval = e.data && e.data.interval;
  if (!interval) return;
  setInterval(function () { self.postMessage('tick'); }, interval);
};
`;

/**
 * 兜底路径：普通 setInterval + 漂移检测
 * 记录期望触发时间，若实际触发比期望晚超过 2 倍间隔（说明被节流），
 * 立即补执行一次并告警。
 * @param {Function} tickFn
 * @param {number} intervalMs
 * @param {Function} [onDrift] 漂移回调（默认 console.warn）
 * @returns {{ stop: Function, mode: string, alive: Function }} 可停止的定时器句柄
 */
export function createDriftAwareInterval(tickFn, intervalMs, onDrift) {
  let nextExpected = Date.now() + intervalMs;
  let stopped = false;
  const warn =
    onDrift ||
    ((msg) => {
      console.warn(`[scheduler] ${msg}`);
    });

  const id = setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    const drift = now - nextExpected;
    nextExpected = now + intervalMs;
    if (drift > intervalMs * 2) {
      warn(`定时器被节流，延迟 ${Math.round(drift / 1000)}s，立即补执行`);
    }
    tickFn();
  }, intervalMs);

  return {
    mode: "interval",
    alive: () => !stopped,
    stop() {
      stopped = true;
      clearInterval(id);
    },
  };
}

/**
 * 创建抗节流定时器
 * @param {Function} tickFn 每次触发执行的回调
 * @param {number} intervalMs 触发间隔（毫秒）
 * @returns {{ stop: Function, mode: 'worker'|'interval', alive: Function }} 可停止的抗节流定时器句柄
 */
export function createThrottleResistantInterval(tickFn, intervalMs) {
  if (typeof tickFn !== "function") {
    throw new TypeError("tickFn must be a function");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("intervalMs must be a positive number");
  }

  // 主路径：内联 Web Worker
  try {
    if (
      typeof Worker !== "undefined" &&
      typeof Blob !== "undefined" &&
      typeof URL !== "undefined" &&
      URL.createObjectURL
    ) {
      const blob = new Blob([WORKER_SOURCE], {
        type: "application/javascript",
      });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      let stopped = false;
      worker.onmessage = () => {
        if (!stopped) tickFn();
      };
      worker.onerror = () => {
        // Worker 异常时终止并忽略，等待 healthCheck 重启调度器
        stopped = true;
        worker.terminate();
      };
      worker.postMessage({ interval: intervalMs });
      return {
        mode: "worker",
        alive: () => !stopped,
        stop() {
          stopped = true;
          worker.terminate();
        },
      };
    }
  } catch (error) {
    console.warn(
      "[scheduler] Worker 调度不可用，退回 setInterval:",
      error?.message || error,
    );
  }

  // 兜底路径
  return createDriftAwareInterval(tickFn, intervalMs);
}

/**
 * 判断后台调度 tick 是否被浏览器节流（用于自检保活是否真正生效）。
 * Worker 每 expectedIntervalMs 发一次 tick，主线程收到后调用本函数：
 * 若页面处于隐藏态且两次 tick 的实际间隔远超预期，说明主线程仍被节流，
 * 即"正在播放音频"豁免未生效（保活音量可能过低或音频未激活）。
 * @param {number} prevTs 上一次 tick 的时间戳（ms），首次为 0/空时不判定
 * @param {number} nowTs 本次 tick 的时间戳（ms）
 * @param {number} expectedIntervalMs 预期 tick 间隔（ms）
 * @param {boolean} isHidden 页面是否处于隐藏态
 * @param {number} [thresholdMs] 判定节流的最小间隔阈值（ms，默认 2500）
 * @returns {boolean} 是否判定为被节流
 */
export function isTickThrottled(
  prevTs,
  nowTs,
  expectedIntervalMs,
  isHidden,
  thresholdMs = 2500,
) {
  if (!isHidden) return false;
  if (!prevTs || !Number.isFinite(nowTs)) return false;
  const limit = Math.max(expectedIntervalMs * 2, thresholdMs);
  return nowTs - prevTs > limit;
}
