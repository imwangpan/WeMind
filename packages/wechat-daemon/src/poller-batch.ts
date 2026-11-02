/**
 * 一批消息处理完后的收尾：先唤醒 worker，再持久化状态。
 * 顺序刻意如此——`saveState` 失败（磁盘满/权限）不能把已经入队的消息卡在队列里，否则 worker 会一直睡到用户下一条消息。
 * 返回持久化错误（成功返回 undefined），调用方负责记日志。
 */
export function finishPollBatch(enq: boolean, save: () => void, wake: () => void): unknown {
  if (enq) wake();
  try {
    save();
    return undefined;
  } catch (e) {
    return e;
  }
}
