import { describe, it, expect } from "vitest";

import { buildShellLine, quoteCmdArg, quoteShArg, spawnAgent } from "./spawn-agent.js";

// 下面两个 spawnAgent 用例会真起一个 node 子进程（Windows 上单跑 0.5–0.7s）。全量跑时多个
// 测试文件并发、各自都在起进程，实测会超过 vitest 默认的 5s 而偶发失败。这里是「等确定会退出的
// 子进程」，放宽超时不是掩盖问题；纯字符串拼接的用例仍走默认超时。
const SPAWN_TEST_TIMEOUT_MS = 20_000;

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
        const proc = spawnAgent({
          bin: process.execPath,
          args: ["-e", "process.stdout.write('ok ' + (1 + 1))"],
          shell: true,
        });
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
        const proc = spawnAgent({
          bin: process.execPath,
          args: ["-e", "process.stdout.write('direct')"],
          shell: false,
        });
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
