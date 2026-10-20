import fs from "node:fs";
import { YAMLParseError, parse, stringify } from "yaml";
import { z } from "zod";
import { atomicWriteText } from "./io.js";

export type YamlIoErrorCode = "YAML_PARSE_ERROR" | "SCHEMA_VALIDATION_ERROR";

export class YamlIoError extends Error {
  readonly code: YamlIoErrorCode;

  constructor(code: YamlIoErrorCode, message: string) {
    super(message);
    this.name = "YamlIoError";
    this.code = code;
  }
}

/** 块状风格常量集：块状集合、width=120、键序保持插入序、无锚点/别名。 */
const yamlDumpOptions = {
  collectionStyle: "block",
  lineWidth: 120,
  minContentWidth: 0,
  defaultStringType: "PLAIN",
  defaultKeyType: "PLAIN",
} as const;

/** 归一为纯 JSON-able 结构：Date→ISO 字符串（微秒+00:00）、Map→plain object、null 显式保留。 */
function toPlainJsonable(value: unknown): unknown {
  if (value instanceof Date) {
    // Python format: 2024-01-01T12:00:00.123456+00:00 (微秒)
    // JS toISOString: 2024-01-01T12:00:00.123Z (毫秒)
    // 转换: 补零到微秒，Z → +00:00
    const iso = value.toISOString();
    const withMicros = iso.replace(/(\.\d{3})Z$/, "$1000+00:00");
    return withMicros;
  }
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value) {
      obj[String(k)] = toPlainJsonable(v);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toPlainJsonable(item));
  }
  if (value !== null && typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = toPlainJsonable(v);
    }
    return obj;
  }
  return value;
}

/** 从 YAMLParseError 提取行号（兼容 linePos 的多种形态，message 正则兜底）。 */
function extractErrorLine(err: YAMLParseError): number | undefined {
  const lp: unknown = err.linePos;
  const from = (v: unknown): number | undefined => {
    if (typeof v === "number") return v;
    if (Array.isArray(v) && typeof v[0] === "number") return v[0];
    if (v !== null && typeof v === "object" && "line" in v) {
      const line = (v as { line: unknown }).line;
      if (typeof line === "number") return line;
    }
    return undefined;
  };
  const direct = Array.isArray(lp) && lp.length > 0 && typeof lp[0] !== "number"
    ? from(lp[0])
    : from(lp);
  if (direct !== undefined) return direct;
  const m = /at line (\d+)/.exec(err.message);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

/**
 * safe 解析 YAML 文本为 unknown。文件不存在时原始 ENOENT 上抛（不包装）；
 * 语法损坏抛 YamlIoError(YAML_PARSE_ERROR) 且含行号。
 */
export function loadYaml(path: string): unknown {
  const text = fs.readFileSync(path, "utf8");
  try {
    return parse(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const line = extractErrorLine(err);
      const loc = line !== undefined ? `:${line}` : "";
      throw new YamlIoError(
        "YAML_PARSE_ERROR",
        `YAML 解析失败 (${path}${loc}): ${err.message}`,
      );
    }
    throw err;
  }
}

/** 加载并按 schema 校验（严格与否由 schema 自身声明，本函数不强行改写）；失败抛 YamlIoError(SCHEMA_VALIDATION_ERROR)。 */
export function loadModel<S extends z.ZodType>(path: string, schema: S): z.infer<S> {
  const data = loadYaml(path);
  try {
    return schema.parse(data) as z.infer<S>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      const issuePath =
        first && first.path.length > 0 ? first.path.join(".") : "(root)";
      throw new YamlIoError(
        "SCHEMA_VALIDATION_ERROR",
        `schema 校验失败 (${path}) 于 ${issuePath}: ${first?.message ?? err.message}`,
      );
    }
    throw err;
  }
}

/** 归一后按稳定块状风格序列化；同一 model 连续 dump 两次字节一致。 */
export function dumpModel(model: unknown): string {
  return stringify(toPlainJsonable(model), yamlDumpOptions);
}

/** dumpModel 后经原子写落盘。 */
export function saveModel(path: string, model: unknown): void {
  atomicWriteText(path, dumpModel(model));
}
