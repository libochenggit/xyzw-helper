/**
 * 定时任务补跑窗口工具
 *
 * 页面处于后台被节流/冻结、或电脑睡眠唤醒后，调度器可能错过任务的执行分钟。
 * 恢复后在最近 N 分钟窗口内回扫，找到错过的执行时间点并补跑一次
 * （仍由调用方的 lastTaskExecution 去重 key 防止重复执行）。
 */

import { matchesCronExpression } from "./batch/cronUtils.js";

/** 格式化为 HH:mm（24小时制） */
export const formatHourMinute = (date) =>
  date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * 判断任务在指定时间点是否应该执行
 * @param {object} task 定时任务（runType: 'daily'|'cron'）
 * @param {Date} time 时间点（分钟精度）
 * @returns {boolean} 该时间点是否应执行
 */
export const shouldTaskRunAt = (task, time) => {
  if (task.runType === "daily") {
    return formatHourMinute(time) === task.runTime;
  }
  if (task.runType === "cron") {
    try {
      return matchesCronExpression(task.cronExpression, time);
    } catch {
      return false;
    }
  }
  return false;
};

/**
 * 在最近 windowMinutes 分钟窗口内（含当前分钟）查找任务的执行时间点。
 * 从当前分钟向过去扫描，返回**最近一次**（≤ now）的计划分钟：
 * 这样高频 cron 任务在补跑时会以“最近应执行分钟”作为去重键，
 * 避免因命中更早、已执行的分钟而漏掉真正错过的那一次。
 * @param {object} task 定时任务
 * @param {Date} now 当前时间
 * @param {number} windowMinutes 补跑窗口（分钟），<=0 时退化为仅匹配当前分钟
 * @returns {Date|null} 最近的匹配时间点（分钟对齐），无匹配返回 null
 */
export const findMissedRunTime = (task, now, windowMinutes = 0) => {
  const window = Math.max(0, Math.floor(windowMinutes) || 0);
  for (let i = 0; i <= window; i++) {
    const candidate = new Date(now.getTime() - i * 60 * 1000);
    candidate.setSeconds(0, 0);
    if (shouldTaskRunAt(task, candidate)) {
      return candidate;
    }
  }
  return null;
};
