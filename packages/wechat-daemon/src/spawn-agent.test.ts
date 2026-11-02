import { describe, it, expect } from "vitest";

import {
  buildShellLine,
  quoteCmdArg,
  quoteShArg,
  shellEnv,
  spawnAgent,
  spawnEnv,
} from "./spawn-agent.js";

// 下面两个 spawnAgent 用例会真起一个 node 子进程（Windows 上单跑 0.5–0.7s）。全量跑时多个测试文件并发、各自都在起进程，实测会超过 vitest 默认的 5s 而偶发失败。这里是「等确定会退出的子进程」，放宽超时不是掩盖问题；纯字符串拼接的用例仍走默认超时。
const SPAWN_TEST_TIMEOUT_MS = 20_000;

/*
 * 子进程会**继承 NODE_OPTIONS**。在 VS Code 里调试/集成终端下跑时，它带着 js-debug 的 `--require …/bootloader.js`，子 node 启动后会停在「Waiting for the debugger to disconnect…」直到 20s 超时——本用例只想验「引号拼装后参数原样到达」，不该被调试器环境拖死。
 * 故 spawn 时把 NODE_OPTIONS 去掉（只影响本用例起的子进程，不动测试进程自身）。
 */
const CLEAN_ENV = { ...process.env, NODE_OPTIONS: "" };

describe("quoteCmdArg", () => {
  it("裸名不加引号", () => {
    expect(quoteCmdArg("opencode")).toBe("opencode");
    expect(quoteCmdArg("acp")).toBe("acp");
    expect(quoteCmdArg("--trust-all-tools")).toBe("--trust-all-tools");
  });

  it("含空白/空串时加引号", () => {
    expect(quoteCmdArg("C:\\Program Files\\kiro\\kiro-cli.exe")).toBe(
      '"C:\\Program Files\\kiro\\kiro-cli.exe"',
    );
    expect(quoteCmdArg("a b")).toBe('"a b"');
    expect(quoteCmdArg("")).toBe('""');
  });

  it("含 cmd 元字符时加引号（否则 cmd 会自行解释）", () => {
    expect(quoteCmdArg("x&y")).toBe('"x&y"');
    expect(quoteCmdArg("a|b")).toBe('"a|b"');
    expect(quoteCmdArg("a>b")).toBe('"a>b"');
    expect(quoteCmdArg("(a)")).toBe('"(a)"');
    expect(quoteCmdArg("a^b")).toBe('"a^b"');
  });

  it("内部引号与结尾反斜杠按 MS CRT 规则转义", () => {
    expect(quoteCmdArg('a"b')).toBe('"a\\"b"');
    expect(quoteCmdArg("a b\\")).toBe('"a b\\\\"');
    expect(quoteCmdArg("a\\b")).toBe("a\\b"); // 无空白/引号 → 原样
  });
});

describe("quoteShArg", () => {
  it("安全字符集裸写", () => {
    expect(quoteShArg("opencode")).toBe("opencode");
    expect(quoteShArg("@zed-industries/claude-code-acp")).toBe("@zed-industries/claude-code-acp");
  });

  it("含特殊字符时单引号包裹", () => {
    expect(quoteShArg("/opt/my app/bin")).toBe("'/opt/my app/bin'");
    expect(quoteShArg("")).toBe("''");
    expect(quoteShArg("it's")).toBe("'it'\\''s'");
  });
});

describe("buildShellLine", () => {
  it("Windows：逐参数按 cmd 规则加引号", () => {
    expect(buildShellLine("C:\\Program Files\\kiro\\kiro-cli.exe", ["acp", "a b"], "win32")).toBe(
      '"C:\\Program Files\\kiro\\kiro-cli.exe" acp "a b"',
    );
    expect(buildShellLine("opencode", ["acp"], "win32")).toBe("opencode acp");
  });

  it("POSIX：逐参数按 sh 规则加引号", () => {
    expect(buildShellLine("/opt/my app/bin", ["acp"], "linux")).toBe("'/opt/my app/bin' acp");
    expect(buildShellLine("opencode", ["acp"], "darwin")).toBe("opencode acp");
  });
});

describe("shellEnv", () => {
  it("Windows：设置 NoDefaultCurrentDirectoryInExePath，保留调用方环境", () => {
    expect(shellEnv("win32", { FOO: "bar" })).toMatchObject({
      FOO: "bar",
      NoDefaultCurrentDirectoryInExePath: "1",
    });
  });

  it("POSIX：原样返回（不引入 Windows 专用变量）", () => {
    const env = { FOO: "bar" };
    expect(shellEnv("linux", env)).toBe(env);
    expect(shellEnv("darwin", undefined)).toBeUndefined();
  });
});

describe("spawnEnv（ACP 子进程不继承 VS Code 调试引导）", () => {
  it("摘掉 VS Code 的 --require 与 VSCODE_INSPECTOR_OPTIONS，保留其它 NODE_OPTIONS", () => {
    const env = spawnEnv({
      FOO: "bar",
      NODE_OPTIONS:
        "--max-old-space-size=4096 --require /x/ms-vscode.js-debug/src/bootloader.js --trace-warnings",
      VSCODE_INSPECTOR_OPTIONS: '{"deferredMode":true}',
    });
    expect(env.FOO).toBe("bar");
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096 --trace-warnings");
    expect(env.VSCODE_INSPECTOR_OPTIONS).toBeUndefined();
  });

  it("没有注入时原样保留用户环境", () => {
    const env = spawnEnv({ NODE_OPTIONS: "--max-old-space-size=4096" });
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
  });
});

describe("spawnAgent", () => {
  it(
    "shell=true 时经整串 + shell 启动，参数不丢、不触发 DEP0190",
    async () => {
      const seen: string[] = [];
      const onWarning = (w: Error & { code?: string }): void => {
        if (w.code === "DEP0190") seen.push("DEP0190");
      };
      process.on("warning", onWarning);
      try {
        const proc = spawnAgent(
          {
            bin: process.execPath,
            args: ["-e", "process.stdout.write('ok ' + (1 + 1))"],
            shell: true,
          },
          { env: CLEAN_ENV },
        );
        const out = await new Promise<string>((resolve, reject) => {
          let buf = "";
          proc.stdout.on("data", (d) => (buf += d.toString()));
          proc.on("error", reject);
          proc.on("close", (code) =>
            code === 0 ? resolve(buf) : reject(new Error(`exit=${code}`)),
          );
        });
        // 带空格与引号的参数原样到达子进程（引号拼装正确）
        expect(out).toBe("ok 2");
        expect(seen).toEqual([]);
      } finally {
        process.off("warning", onWarning);
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "shell=false 时直接 spawn，同样不触发 DEP0190",
    async () => {
      const seen: string[] = [];
      const onWarning = (w: Error & { code?: string }): void => {
        if (w.code === "DEP0190") seen.push("DEP0190");
      };
      process.on("warning", onWarning);
      try {
        const proc = spawnAgent(
          {
            bin: process.execPath,
            args: ["-e", "process.stdout.write('direct')"],
            shell: false,
          },
          { env: CLEAN_ENV },
        );
        const out = await new Promise<string>((resolve, reject) => {
          let buf = "";
          proc.stdout.on("data", (d) => (buf += d.toString()));
          proc.on("error", reject);
          proc.on("close", (code) =>
            code === 0 ? resolve(buf) : reject(new Error(`exit=${code}`)),
          );
        });
        expect(out).toBe("direct");
        expect(seen).toEqual([]);
      } finally {
        process.off("warning", onWarning);
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
