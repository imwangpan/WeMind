// 摘掉 VS Code 集成终端注入的调试引导——只用于**脱离式/常驻**的 spawn（见 watchdog-runner.ts）。
//
// VS Code 的「智能自动附加」会给终端里每个 node 进程注入两个变量：
//   NODE_OPTIONS=--require <…>/ms-vscode.js-debug/bootloader.js
//   VSCODE_INSPECTOR_OPTIONS={"deferredMode":true,"autoAttachMode":"smart","aaPatterns":["d:/workspace/projects/WeMind/**",…],…}
// 被注入的进程会**等调试器接上才执行主脚本**。终端里前台的命令 VS Code 会接上，所以看着一切正常；但 `wemind start` 脱离出去的看护进程/daemon 不会被接——进程活着却一行 JS 都不跑：`daemon.log` 不更新、`wrapper.pid` 不写、daemon 根本起不来，答复却说「已启动」（2026-10-29 实测）。
//
// 修法：脱离式 spawn 时把 VS Code 自己注入的那段 `--require` 摘掉，其余 `NODE_OPTIONS` 原样保留（用户可能设了 `--max-old-space-size` 之类）；`VSCODE_INSPECTOR_OPTIONS` 一并删——它只对那个 bootloader 有意义。

/** 匹配 VS Code 注入的 `--require <路径>/ms-vscode.js-debug/…/bootloader.js`（兼容 `--require=` 写法与带引号的路径）。 */
const VSCODE_REQUIRE =
  /--require(?:=|\s+)(?:"[^"]*ms-vscode\.js-debug[^"]*bootloader\.js"|'[^']*ms-vscode\.js-debug[^']*bootloader\.js'|[^\s"']*ms-vscode\.js-debug[^\s"']*bootloader\.js)/gi;

/** 返回摘掉 VS Code 调试引导的**新**环境对象（不修改入参；没有注入时原样返回一份拷贝）。 */
export function stripVscodeDebugEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const opts = out.NODE_OPTIONS;
  if (opts) {
    const next = opts.replace(VSCODE_REQUIRE, " ");
    if (next !== opts) {
      // 只有真摘过东西才规整空白，其余情况保留用户原文（避免动到带空格的引号参数）。
      const kept = next.trim().replace(/\s+/g, " ");
      if (kept) out.NODE_OPTIONS = kept;
      else delete out.NODE_OPTIONS;
    }
  }
  delete out.VSCODE_INSPECTOR_OPTIONS;
  return out;
}
