// [TDD]-foundation_tests — foundation 域五个制品（root/io/yaml/hash/config）的集成验收。
// 覆盖 [FSD]-ait-core-foundation:TEST 第 1~5 条全部断言点。
// 约束：每个用例在 os.tmpdir() 下自建临时目录并 afterEach 清理；用例间零共享状态；
// 不断言平台特定路径分隔符（统一经 toPosixRel 后断言）。

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

import { resolveProjectRoot, ProjectRootError } from "../src/foundation/root.js";
import {
  atomicWriteText,
  atomicWriteBytes,
  ensureWithin,
  toPosixRel,
  stripMdExt,
  PathOutsideProjectError,
} from "../src/foundation/io.js";
import {
  loadYaml,
  loadModel,
  dumpModel,
  saveModel,
  YamlIoError,
} from "../src/foundation/yaml.js";
import { normalize, chunkHash, fileHash } from "../src/foundation/hash.js";
import {
  loadConfig,
  loadLocalConfig,
  loadAcceptanceCommand,
  writeLocalConfig,
  ConfigUnreadableError,
} from "../src/foundation/config.js";

let tmpDirs: string[] = [];

function mkTmp(): string {
  // 临时目录创建失败时用例自然 fail 并带 OS 错误（不重试）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-foundation-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // 清理失败仅告警不 fail（Windows 文件锁容忍）。
      console.warn(`afterEach 清理失败（忽略）: ${dir}`, err);
    }
  }
  tmpDirs = [];
});

/** 在 base 下搭建合法 project-docs 骨架，返回 project-docs 绝对路径。 */
function makeLegalSkeleton(base: string): string {
  const root = path.join(base, "project-docs");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, ".meta"), { recursive: true });
  return root;
}

describe("root_resolve", () => {
  it("合法根返回四路径且均为绝对路径", () => {
    const cwd = mkTmp();
    const expectedRoot = makeLegalSkeleton(cwd);
    const pr = resolveProjectRoot(cwd);
    expect(pr.cwd).toBe(path.resolve(cwd));
    expect(pr.root).toBe(expectedRoot);
    expect(toPosixRel(pr.root, pr.docs)).toBe("docs");
    expect(toPosixRel(pr.root, pr.meta)).toBe(".meta");
    for (const p of [pr.cwd, pr.root, pr.docs, pr.meta]) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });

  it("cwd 下无 project-docs → NOT_AT_PROJECT_ROOT", () => {
    const cwd = mkTmp();
    try {
      resolveProjectRoot(cwd);
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectRootError);
      expect((err as ProjectRootError).code).toBe("NOT_AT_PROJECT_ROOT");
    }
  });

  it("project-docs 骨架缺目录 → PROJECT_DOCS_MALFORMED", () => {
    const cwd = mkTmp();
    fs.mkdirSync(path.join(cwd, "project-docs", "docs"), { recursive: true });
    // 缺 .meta/
    try {
      resolveProjectRoot(cwd);
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectRootError);
      expect((err as ProjectRootError).code).toBe("PROJECT_DOCS_MALFORMED");
    }
  });

  it("从 project-docs 内部（含 docs/ 子目录）运行 → CWD_INSIDE_PROJECT_DOCS", () => {
    const cwd = mkTmp();
    const root = makeLegalSkeleton(cwd);
    for (const inside of [root, path.join(root, "docs")]) {
      try {
        resolveProjectRoot(inside);
        expect.unreachable("应当抛错");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectRootError);
        expect((err as ProjectRootError).code).toBe("CWD_INSIDE_PROJECT_DOCS");
      }
    }
  });

  it("重复调用结果一致（纯函数无副作用）", () => {
    const cwd = mkTmp();
    makeLegalSkeleton(cwd);
    const a = resolveProjectRoot(cwd);
    const b = resolveProjectRoot(cwd);
    expect(a).toEqual(b);
  });
});

describe("atomic_io", () => {
  it("写入后读回内容一致（文本与字节）", () => {
    const dir = mkTmp();
    const textFile = path.join(dir, "a.txt");
    atomicWriteText(textFile, "hello\nworld");
    expect(fs.readFileSync(textFile, "utf8")).toBe("hello\nworld");

    const binFile = path.join(dir, "b.bin");
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x41]);
    atomicWriteBytes(binFile, bytes);
    expect(fs.readFileSync(binFile)).toEqual(bytes);
  });

  it("CRLF 输入落盘为 \\n：写入字节与内容哈希一致（:TEST 第 2 条）", () => {
    const dir = mkTmp();
    const target = path.join(dir, "crlf.txt");
    const content = "line1\r\nline2\r\nline3";
    atomicWriteText(target, content);
    const diskBytes = fs.readFileSync(target);
    // 无 CRLF 残留
    expect(diskBytes.includes(0x0d)).toBe(false);
    // 落盘字节哈希（Buffer 不归一）与内容归一后哈希一致
    expect(fileHash(diskBytes)).toBe(fileHash(content));
  });

  it("写入不存在的目标目录：抛原始 ENOENT 且无 .tmp- 残留", () => {
    const dir = mkTmp();
    const target = path.join(dir, "no-such-dir", "f.txt");
    try {
      atomicWriteText(target, "x");
      expect.unreachable("应当抛错");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    const leftovers = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("ensureWithin 放行根内路径并返回归一化绝对路径", () => {
    const dir = mkTmp();
    const abs = ensureWithin(dir, path.join("docs", "a.md"));
    expect(path.isAbsolute(abs)).toBe(true);
    // 根内路径经 toPosixRel 归一化为 posix 相对路径（:TEST 第 3 条）
    expect(toPosixRel(dir, abs)).toBe("docs/a.md");
  });

  it("ensureWithin 拒绝 .. 逃逸与绝对根外路径 → PathOutsideProjectError", () => {
    const dir = mkTmp();
    const outsideAbs = path.join(path.dirname(dir), "outside.txt");
    for (const target of ["../escape.txt", outsideAbs]) {
      try {
        ensureWithin(dir, target);
        expect.unreachable("应当抛错");
      } catch (err) {
        expect(err).toBeInstanceOf(PathOutsideProjectError);
        expect((err as PathOutsideProjectError).code).toBe(
          "PATH_OUTSIDE_PROJECT",
        );
      }
    }
  });

  it("toPosixRel / stripMdExt 边界：嵌套路径与非 .md 结尾", () => {
    const dir = mkTmp();
    const nested = path.join(dir, "a", "b", "c.md");
    expect(toPosixRel(dir, nested)).toBe("a/b/c.md");
    expect(stripMdExt("a/b/c.md")).toBe("a/b/c");
    expect(stripMdExt("a/b/c.txt")).toBe("a/b/c.txt");
    expect(stripMdExt("a/b/c")).toBe("a/b/c");
  });
});

describe("yaml_schema_io", () => {
  const SCHEMA = z
    .object({
      name: z.string(),
      count: z.number(),
    })
    .strict();

  it("合法 model 往返语义一致，且同一 model 两次 dump 字节相同", () => {
    const dir = mkTmp();
    const file = path.join(dir, "m.yaml");
    const model = { name: "ait", count: 42 };
    saveModel(file, model);
    expect(loadModel(file, SCHEMA)).toEqual(model);
    expect(dumpModel(model)).toBe(dumpModel(model));
  });

  it("未知字段 → SCHEMA_VALIDATION_ERROR", () => {
    const dir = mkTmp();
    const file = path.join(dir, "unknown.yaml");
    fs.writeFileSync(file, "name: ait\ncount: 1\nextra: boom\n", "utf8");
    try {
      loadModel(file, SCHEMA);
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(YamlIoError);
      expect((err as YamlIoError).code).toBe("SCHEMA_VALIDATION_ERROR");
    }
  });

  it("类型错误 → SCHEMA_VALIDATION_ERROR", () => {
    const dir = mkTmp();
    const file = path.join(dir, "type.yaml");
    fs.writeFileSync(file, "name: ait\ncount: not-a-number\n", "utf8");
    try {
      loadModel(file, SCHEMA);
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(YamlIoError);
      expect((err as YamlIoError).code).toBe("SCHEMA_VALIDATION_ERROR");
    }
  });

  it("损坏 YAML → YAML_PARSE_ERROR 且消息含行号", () => {
    const dir = mkTmp();
    const file = path.join(dir, "broken.yaml");
    fs.writeFileSync(file, "ok: 1\nbad: [unclosed\n", "utf8");
    try {
      loadYaml(file);
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(YamlIoError);
      expect((err as YamlIoError).code).toBe("YAML_PARSE_ERROR");
      expect((err as YamlIoError).message).toMatch(/:\d+/);
    }
  });

  it("Date→ISO 字符串、Map→plain object 归一化输出形态", () => {
    const dumped = dumpModel({
      at: new Date("2026-01-02T03:04:05.000Z"),
      m: new Map([["k", "v"]]),
    });
    // YAML 可能输出 ISO 格式（带 Z）或带时区偏移的格式
    expect(dumped).toMatch(/at: 2026-01-02T03:04:05\.000(Z|000\+00:00)/);
    expect(dumped).toMatch(/m:\r?\n\s+k: v/);
  });

  it("文件不存在抛原始 ENOENT 而非 YamlIoError", () => {
    const dir = mkTmp();
    try {
      loadYaml(path.join(dir, "missing.yaml"));
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).not.toBeInstanceOf(YamlIoError);
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});

describe("hashing", () => {
  it("同一内容 CRLF/LF 两形态 chunkHash 相同", () => {
    expect(chunkHash("a\r\nb\r\nc")).toBe(chunkHash("a\nb\nc"));
  });

  it("首尾空白不影响 chunkHash", () => {
    expect(chunkHash("  hello \n")).toBe(chunkHash("hello"));
  });

  it("chunkHash 为 8 位 hex", () => {
    expect(chunkHash("anything")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("fileHash：string 归一，Buffer 按原始字节不归一", () => {
    const raw = "a\r\nb";
    const bytes = Buffer.from(raw, "utf8");
    // Buffer 输入忠实于原始字节
    expect(fileHash(bytes)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    // string 输入先 normalize（CRLF→LF + strip），与 Buffer 结果不同
    expect(fileHash(raw)).toBe(
      createHash("sha256").update(normalize(raw), "utf8").digest("hex"),
    );
    expect(fileHash(bytes)).not.toBe(fileHash(raw));
  });

  it("空字符串为合法输入", () => {
    expect(chunkHash("")).toMatch(/^[0-9a-f]{8}$/);
    expect(fileHash("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("config_store", () => {
  function writeShared(root: string, text: string): void {
    fs.writeFileSync(path.join(root, "config.yaml"), text, "utf8");
  }
  function writeLocal(root: string, text: string): void {
    fs.writeFileSync(path.join(root, "config.local.yaml"), text, "utf8");
  }

  it("双层合并，本地层覆盖共享层机器字段", () => {
    const dir = mkTmp();
    writeShared(dir, "idPrefixSeparator: ':'\nacceptanceCommand: npm test\n");
    writeLocal(dir, "skillDir: /machine/skill\n");
    const cfg = loadConfig(dir);
    expect(cfg.idPrefixSeparator).toBe(":");
    expect(cfg.acceptanceCommand).toBe("npm test");
    expect(cfg.skillDir).toBe("/machine/skill");
  });

  it("本地层覆盖共享层同名字段", () => {
    const dir = mkTmp();
    writeShared(dir, "acceptanceCommand: shared-cmd\n");
    writeLocal(dir, "acceptanceCommand: local-cmd\n");
    expect(loadConfig(dir).acceptanceCommand).toBe("local-cmd");
  });

  it("共享层损坏 → CONFIG_UNREADABLE（不因本地层健康而放行）", () => {
    const dir = mkTmp();
    writeShared(dir, "bad: [unclosed\n");
    writeLocal(dir, "skillDir: /ok\n");
    try {
      loadConfig(dir);
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigUnreadableError);
      expect((err as ConfigUnreadableError).code).toBe("CONFIG_UNREADABLE");
    }
  });

  it("本地层损坏 → CONFIG_UNREADABLE", () => {
    const dir = mkTmp();
    writeShared(dir, "idPrefixSeparator: ':'\n");
    writeLocal(dir, "bad: [unclosed\n");
    try {
      loadConfig(dir);
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigUnreadableError);
      expect((err as ConfigUnreadableError).code).toBe("CONFIG_UNREADABLE");
    }
  });

  it("双层缺失返回空配置（合法）", () => {
    const dir = mkTmp();
    expect(loadConfig(dir)).toEqual({});
    expect(loadLocalConfig(dir)).toEqual({});
  });

  it("acceptance 回退顺序：本地优先、回退共享、皆缺为 null", () => {
    const bothMissing = mkTmp();
    expect(loadAcceptanceCommand(bothMissing)).toBeNull();

    const sharedOnly = mkTmp();
    writeShared(sharedOnly, "acceptanceCommand: shared-cmd\n");
    expect(loadAcceptanceCommand(sharedOnly)).toBe("shared-cmd");

    const localWins = mkTmp();
    writeShared(localWins, "acceptanceCommand: shared-cmd\n");
    writeLocal(localWins, "acceptanceCommand: local-cmd\n");
    expect(loadAcceptanceCommand(localWins)).toBe("local-cmd");
  });

  it("writeLocalConfig 合并 patch（undefined 剔除）并经原子写落盘，读回验证", () => {
    const dir = mkTmp();
    writeLocal(dir, "skillDir: /old\nacceptanceCommand: keep-me\n");
    writeLocalConfig(dir, { skillDir: "/new" });
    const local = loadLocalConfig(dir);
    expect(local.skillDir).toBe("/new");
    expect(local.acceptanceCommand).toBe("keep-me");
    expect("cliPath" in local).toBe(false);
  });

  describe("Python 验收配置兼容性", () => {
    function withoutConfigChanges<T>(root: string, operation: () => T): T {
      const files = ["config.yaml", "config.local.yaml"].map((name) =>
        path.join(root, name),
      );
      const readBytes = () => files.map((file) =>
        fs.existsSync(file) ? fs.readFileSync(file) : null,
      );
      const before = readBytes();
      try {
        return operation();
      } finally {
        expect(readBytes()).toEqual(before);
      }
    }

    function expectUnreadable(
      root: string,
      operation: () => unknown = () => loadAcceptanceCommand(root),
    ): void {
      try {
        withoutConfigChanges(root, operation);
        expect.unreachable("应当抛错");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigUnreadableError);
        expect((err as ConfigUnreadableError).code).toBe("CONFIG_UNREADABLE");
      }
    }

    describe.each([
      ["acceptance_command", "acceptanceCommand"],
      ["acceptanceCommand", "acceptance_command"],
    ] as const)("%s", (key, otherKey) => {
      describe.each(["config.yaml", "config.local.yaml"])("%s", (fileName) => {
        it("读取单键命令并 trim，原始 YAML 字节不变", () => {
          const dir = mkTmp();
          fs.writeFileSync(path.join(dir, fileName),
            `# 保留注释和 CRLF\r\n${key}: '  npm test  '\r\nunknown: [one, two]\r\n`,
            "utf8",
          );
          expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
            .toBe("npm test");
        });

        it.each([
          ["数字", "42"],
          ["数组", "[npm, test]"],
          ["布尔", "true"],
          ["对象", "{ command: npm test }"],
        ])("拒绝%s值，即使另一层有健康命令也不放行", (_kind, value) => {
          const dir = mkTmp();
          writeShared(dir, `${otherKey}: shared-cmd\n`);
          writeLocal(dir, `${otherKey}: local-cmd\n`);
          fs.writeFileSync(path.join(dir, fileName), `${key}: ${value}\n`, "utf8");
          expectUnreadable(dir);
        });
      });

      it("本地命令覆盖共享层的另一拼法", () => {
        const dir = mkTmp();
        writeShared(dir, `${otherKey}: shared-cmd\n`);
        writeLocal(dir, `${key}: local-cmd\n`);
        expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
          .toBe("local-cmd");
      });

      it.each(["''", "'   '", "null"])("本地 %s 回退共享命令", (value) => {
        const dir = mkTmp();
        writeShared(dir, `${otherKey}: shared-cmd\n`);
        writeLocal(dir, `${key}: ${value}\n`);
        expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
          .toBe("shared-cmd");
      });

      it.each(["''", "null"])("两层 %s 都未配置时返回 null", (value) => {
        const dir = mkTmp();
        writeShared(dir, `${otherKey}: ${value}\n`);
        writeLocal(dir, `${key}: ${value}\n`);
        expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
          .toBeNull();
      });

      it("共享 YAML 损坏时拒绝本地健康命令", () => {
        const dir = mkTmp();
        writeShared(dir, "bad: [unclosed\n");
        writeLocal(dir, `${key}: local-cmd\n`);
        expectUnreadable(dir);
      });

      it("writeLocalConfig 替换旧别名，落盘保留未知键且新命令生效", () => {
        const dir = mkTmp();
        writeShared(dir, "acceptance_command: shared-cmd\n");
        writeLocal(dir, `${otherKey}: old-cmd\nunknown:\n  values: [keep-me]\nskillDir: /old\n`);
        const sharedBytes = fs.readFileSync(path.join(dir, "config.yaml"));
        writeLocalConfig(dir, { [key]: "new-cmd" });
        const local = withoutConfigChanges(dir, () =>
          loadYaml(path.join(dir, "config.local.yaml")),
        );
        expect(local).toEqual({
          [key]: "new-cmd",
          unknown: { values: ["keep-me"] },
          skillDir: "/old",
        });
        expect(local).not.toHaveProperty(otherKey);
        expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
          .toBe("new-cmd");
        expect(fs.readFileSync(path.join(dir, "config.yaml"))).toEqual(sharedBytes);
      });

      it("其它 patch 与 undefined 不改原验收字段", () => {
        const dir = mkTmp();
        writeLocal(dir, `${key}: '  keep-me  '\nunknown: preserved\n`);
        writeLocalConfig(dir, { skillDir: "/new", [key]: undefined });
        expect(withoutConfigChanges(dir, () =>
          loadYaml(path.join(dir, "config.local.yaml")),
        )).toEqual({
          [key]: "  keep-me  ",
          unknown: "preserved",
          skillDir: "/new",
        });
        expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
          .toBe("keep-me");
      });
    });

    it.each(["config.yaml", "config.local.yaml"])(
      "%s 同层双键 trim 后相同合法且只读",
      (fileName) => {
        const dir = mkTmp();
        fs.writeFileSync(path.join(dir, fileName),
          "acceptance_command: '  npm test  '\nacceptanceCommand: npm test\n",
          "utf8",
        );
        expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
          .toBe("npm test");
      },
    );

    it.each(["config.yaml", "config.local.yaml"])(
      "%s 同层双键冲突时拒绝，另一层不能遮蔽冲突",
      (fileName) => {
        const dir = mkTmp();
        writeShared(dir, "acceptance_command: shared-cmd\n");
        writeLocal(dir, "acceptanceCommand: local-cmd\n");
        fs.writeFileSync(path.join(dir, fileName),
          "acceptance_command: python-cmd\nacceptanceCommand: node-cmd\n",
          "utf8",
        );
        expectUnreadable(dir);
      },
    );

    it("缺少两层配置返回 null，且不创建配置文件", () => {
      const dir = mkTmp();
      expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
        .toBeNull();
    });

    it("loadConfig/loadLocalConfig 保留原键名和未知字段，不迁移文件", () => {
      const dir = mkTmp();
      writeShared(dir, "acceptance_command: shared-cmd\nsharedUnknown: [one]\n");
      writeLocal(dir, "acceptanceCommand: local-cmd\nlocalUnknown: { keep: true }\n");
      const local = { acceptanceCommand: "local-cmd", localUnknown: { keep: true } };
      expect(withoutConfigChanges(dir, () => loadLocalConfig(dir))).toEqual(local);
      expect(withoutConfigChanges(dir, () => loadConfig(dir))).toEqual({
        acceptance_command: "shared-cmd",
        sharedUnknown: ["one"],
        ...local,
      });
      expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
        .toBe("local-cmd");
    });

    it("双键冲突 patch 在写前拒绝，两层原始字节不变", () => {
      const dir = mkTmp();
      writeShared(dir, "acceptance_command: shared-cmd\n");
      writeLocal(dir, "# 原始格式\r\nacceptance_command: old-cmd\r\nunknown: [keep]\r\n");
      expectUnreadable(dir, () => writeLocalConfig(dir, {
        acceptance_command: "python-cmd",
        acceptanceCommand: "node-cmd",
      }));
      expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
        .toBe("old-cmd");
    });

    it("双键相同 patch 落盘只保留 acceptance_command", () => {
      const dir = mkTmp();
      writeLocal(dir, "acceptanceCommand: old-cmd\nunknown: preserved\n");
      writeLocalConfig(dir, {
        acceptance_command: "new-cmd",
        acceptanceCommand: "new-cmd",
      });
      expect(withoutConfigChanges(dir, () =>
        loadYaml(path.join(dir, "config.local.yaml")),
      )).toEqual({ acceptance_command: "new-cmd", unknown: "preserved" });
      expect(withoutConfigChanges(dir, () => loadAcceptanceCommand(dir)))
        .toBe("new-cmd");
    });
  });
});
