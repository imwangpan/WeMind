/**
 * 连续重复错误的节流：第一次照常报，之后每 every 次带「连续 N 次」报一条，成功时补一条恢复日志。
 * 用于 getUpdates 这类网络失败：断网一小时不能让同一行刷满 10MB 日志，把之前有用的线索顶进轮转文件。
 */
export interface RepeatLog {
  /** 记一次失败；只有第 1 次与每 every 次会真的调用 report。 */
  error(detail: string): void;
  /** 记一次成功；之前连续失败过就补一条恢复日志并清零。 */
  success(): void;
  readonly count: number;
}

/** error = 失败上报（ERROR），recovery = 恢复通知（INFO）；调用方据此选级别，别把恢复也记成错误。 */
export type RepeatLogReport = (line: string, kind: "error" | "recovery") => void;

export function createRepeatLog(report: RepeatLogReport, every = 60): RepeatLog {
  let count = 0;
  return {
    get count() {
      return count;
    },
    error(detail: string) {
      count += 1;
      if (count === 1) {
        report(detail, "error");
      } else if (count % every === 0) {
        report(`${detail}（连续 ${count} 次）`, "error");
      }
    },
    success() {
      if (count > 1) report(`recovered after ${count} consecutive errors`, "recovery");
      count = 0;
    },
  };
}
