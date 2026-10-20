// [TDD]-hashing: 文本归一化与内容指纹（chunk 哈希、文件哈希）。
// 归一化先行：一切字符串哈希输入先经 normalize（CRLF→LF + 首尾 strip），
// 保证同一语义内容在任何平台得到同一指纹；哈希输入编码固定 utf-8。
// 本文件不做版本语义判断——哈希只描述内容，不描述新旧。
import { createHash } from "node:crypto";

/** CRLF/CR → LF，再去首尾空白。 */
export function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function sha256hex(data: string | Buffer): string {
  // 一次性 update：假设输入为 chunk/规格文件级文本（MB 量级以内），无需流式。
  return createHash("sha256").update(data).digest("hex");
}

/** normalize 后 SHA-256 取前 8 位 hex。空字符串为合法输入。 */
export function chunkHash(content: string): string {
  return sha256hex(normalize(content)).slice(0, 8);
}

/**
 * 完整 SHA-256 hex。
 * string 输入先 normalize（跨平台语义指纹）；
 * Buffer 输入按原始字节直接哈希，不做任何归一——字节指纹必须忠实于实际内容，
 * 供落盘校验场景使用。
 */
export function fileHash(content: string | Buffer): string {
  return sha256hex(typeof content === "string" ? normalize(content) : content);
}
