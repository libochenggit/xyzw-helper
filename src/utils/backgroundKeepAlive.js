/**
 * 后台保活模块
 *
 * 浏览器对隐藏标签页会施加定时器节流（1次/分钟）与密集节流/页面冻结，
 * 导致定时任务不调度、WebSocket 握手与心跳超时（"连接超时"）。
 * 页面"正在播放音频"时可豁免上述节流。注意：Chrome 只对真正 audible 的音频豁免，
 * 完全静音（gain=0）无效，故本模块播放一段极低电平的非零白噪声（人耳基本不可闻，
 * 标签页会显示喇叭图标属正常）。受 autoplay 策略限制，首次需一次用户手势激活。
 *
 * 所有浏览器 API 均为惰性访问，保证模块可在 Node 环境（单元测试）中安全导入。
 */

const KEEPALIVE_STORAGE_KEY = "backgroundKeepAliveEnabled";
const KEEPALIVE_LEVEL_STORAGE_KEY = "backgroundKeepAliveLevel";

/**
 * 保活音量档位 -> 增益映射。
 * Chrome 仅对"真正可听到(audible)"的音频豁免后台节流，完全静音(gain=0)无效，
 * 需保留极低但非零的音频功率（medium 约 -53dBFS RMS，人耳基本不可闻）。
 */
const LEVEL_GAIN = { low: 0.002, medium: 0.004, high: 0.008 };
const DEFAULT_LEVEL = "medium";

let audioCtx = null;
let gainNode = null;
let sourceNode = null;
let gestureListenerAttached = false;
let visibilityListenerAttached = false;
let wakeLockSentinel = null;
let enabled = true;
let keepAliveLevel = DEFAULT_LEVEL;

/** 解析档位对应的增益值，非法档位回退默认 */
const resolveGain = (level) => LEVEL_GAIN[level] ?? LEVEL_GAIN[DEFAULT_LEVEL];

const getAudioContextCtor = () =>
  (typeof globalThis !== "undefined" &&
    (globalThis.AudioContext || globalThis.webkitAudioContext)) ||
  null;

const getDocument = () =>
  (typeof globalThis !== "undefined" && globalThis.document) || null;

const getNavigator = () =>
  (typeof globalThis !== "undefined" && globalThis.navigator) || null;

/**
 * 读取保活开关（默认开启），供页面初始化时同步设置
 * @returns {boolean} 是否启用后台保活
 */
export function loadKeepAliveEnabled() {
  try {
    const raw = globalThis.localStorage?.getItem(KEEPALIVE_STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

/**
 * 持久化保活开关
 * @param {boolean} value
 */
export function setKeepAliveEnabled(value) {
  enabled = Boolean(value);
  try {
    globalThis.localStorage?.setItem(KEEPALIVE_STORAGE_KEY, String(enabled));
  } catch {
    // localStorage 不可用时仅保留内存状态
  }
  if (enabled) {
    startKeepAlive();
  } else {
    stopKeepAlive();
  }
}

/**
 * 读取保活音量档位（默认 medium）
 * @returns {string} 档位标识：low/medium/high
 */
export function loadKeepAliveLevel() {
  try {
    const raw = globalThis.localStorage?.getItem(KEEPALIVE_LEVEL_STORAGE_KEY);
    return raw && LEVEL_GAIN[raw] !== undefined ? raw : DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL;
  }
}

/**
 * 设置并持久化保活音量档位；若音频正在运行则即时更新增益
 * @param {string} level - low/medium/high
 */
export function setKeepAliveLevel(level) {
  keepAliveLevel = LEVEL_GAIN[level] !== undefined ? level : DEFAULT_LEVEL;
  try {
    globalThis.localStorage?.setItem(
      KEEPALIVE_LEVEL_STORAGE_KEY,
      keepAliveLevel,
    );
  } catch {
    // localStorage 不可用时仅保留内存状态
  }
  if (gainNode) {
    gainNode.gain.value = resolveGain(keepAliveLevel);
  }
}

/** 创建并启动微弱非零噪声循环音频，返回是否成功进入 running 状态 */
function startKeepAliveAudio() {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return false; // 环境不支持，静默降级
  try {
    if (!audioCtx) {
      audioCtx = new Ctor();
      gainNode = audioCtx.createGain();
      // 必须为非零增益：Chrome 只对真正 audible 的音频豁免后台节流，gain=0 无效
      gainNode.gain.value = resolveGain(keepAliveLevel);
      gainNode.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") {
      // 无用户手势时 resume 可能失败，交给手势监听兜底
      audioCtx.resume().catch(() => {});
    }
    if (!sourceNode && audioCtx.state === "running") {
      const buffer = audioCtx.createBuffer(
        1,
        audioCtx.sampleRate,
        audioCtx.sampleRate,
      );
      // 填充低电平白噪声（非零功率），配合 gain 得到约 -53dBFS RMS 输出
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.loop = true;
      sourceNode.connect(gainNode);
      sourceNode.start(0);
    }
    return audioCtx.state === "running";
  } catch (error) {
    console.warn("[keepAlive] 保活音频启动失败:", error?.message || error);
    return false;
  }
}

/** 首次用户手势时重试激活音频（autoplay 策略要求手势） */
let gestureHandler = null;

function attachGestureListener() {
  const doc = getDocument();
  if (!doc || gestureListenerAttached) return;
  gestureListenerAttached = true;
  gestureHandler = () => {
    if (enabled && startKeepAliveAudio()) {
      detachGestureListener();
    }
  };
  doc.addEventListener?.("pointerdown", gestureHandler);
  doc.addEventListener?.("keydown", gestureHandler);
}

function detachGestureListener() {
  const doc = getDocument();
  if (doc && gestureHandler) {
    doc.removeEventListener?.("pointerdown", gestureHandler);
    doc.removeEventListener?.("keydown", gestureHandler);
  }
  gestureHandler = null;
}

/** 页面可见时申请屏幕 Wake Lock，防止熄屏/系统休眠（尽力而为） */
async function requestWakeLock() {
  const nav = getNavigator();
  const doc = getDocument();
  if (!nav?.wakeLock?.request || !doc || doc.visibilityState !== "visible")
    return;
  try {
    wakeLockSentinel = await nav.wakeLock.request("screen");
    wakeLockSentinel.addEventListener?.("release", () => {
      wakeLockSentinel = null;
    });
  } catch {
    wakeLockSentinel = null; // 浏览器拒绝（如省电模式），忽略
  }
}

function attachVisibilityListener() {
  const doc = getDocument();
  if (!doc || visibilityListenerAttached) return;
  visibilityListenerAttached = true;
  doc.addEventListener?.("visibilitychange", () => {
    if (!enabled) return;
    if (doc.visibilityState === "visible") {
      // 浏览器可能在隐藏期间挂起 AudioContext，恢复可见时重新拉起
      if (audioCtx?.state === "suspended") {
        audioCtx.resume().catch(() => {});
      } else if (!audioCtx) {
        startKeepAliveAudio();
      }
      requestWakeLock();
    }
  });
}

/**
 * 启动后台保活。需在用户手势上下文中调用才能立即生效；
 * 若无手势导致 AudioContext 挂起，会自动在首次交互时重试。
 * @returns {boolean} 是否已处于 running 状态
 */
export function startKeepAlive() {
  if (!enabled) return false;
  const running = startKeepAliveAudio();
  attachGestureListener();
  attachVisibilityListener();
  requestWakeLock();
  return running;
}

/**
 * 确保保活处于激活状态（AudioContext 被挂起时尝试恢复）。
 * 供连接重试等关键路径调用。
 * @returns {boolean} 激活后是否处于 running 状态
 */
export function ensureKeepAliveActive() {
  if (!enabled) return false;
  if (audioCtx?.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  if (!audioCtx) {
    return startKeepAliveAudio();
  }
  return audioCtx.state === "running";
}

/**
 * 停止后台保活并释放音频资源
 */
export function stopKeepAlive() {
  try {
    sourceNode?.stop?.();
  } catch {
    // 已停止或未启动，忽略
  }
  sourceNode = null;
  gainNode?.disconnect?.();
  gainNode = null;
  audioCtx?.close?.().catch(() => {});
  audioCtx = null;
  wakeLockSentinel?.release?.().catch(() => {});
  wakeLockSentinel = null;
  detachGestureListener();
}

/**
 * 获取当前保活状态，供 UI 展示
 * @returns {{ enabled: boolean, supported: boolean, audioState: string, wakeLock: boolean, level: string, gain: number }} 保活状态快照
 */
export function getKeepAliveState() {
  return {
    enabled,
    supported: Boolean(getAudioContextCtor()),
    audioState: audioCtx ? audioCtx.state : "none",
    wakeLock: Boolean(wakeLockSentinel),
    level: keepAliveLevel,
    gain: resolveGain(keepAliveLevel),
  };
}

/**
 * 重置模块内部状态（仅用于单元测试）
 */
export function __resetKeepAliveForTest() {
  stopKeepAlive();
  enabled = true;
  keepAliveLevel = DEFAULT_LEVEL;
  gestureListenerAttached = false;
  visibilityListenerAttached = false;
  gestureHandler = null;
}
