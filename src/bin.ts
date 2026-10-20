#!/usr/bin/env node
/**
 * [TDD]-cli_bin — 可执行入口薄壳：把 process.argv.slice(2) 交给 runCli，
 * 用其返回值镜像进程退出码。
 *
 * 边界（不负责）：不解析 argv、不做命令路由、不写 stdout、不包装异常——
 * dispatch、单行 JSON 写出与错误包装全部由 ./cli/dispatcher.ts 完成。
 */

const { runCli } = await import("./cli/dispatcher.js");

process.exit(await runCli(process.argv.slice(2)));
