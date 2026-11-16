// 子进程输出解码。原则:
//   1. 内部统一 UTF-8;Godot 自身输出就是 UTF-8(含中文),合法 UTF-8 直接采用。
//   2. 不盲目把所有字节按 UTF-8 解码:非法序列在 Windows 上回退到 GBK,再退到 windows-1252/latin1,
//      并如实报告实际采用的编码(encoding + hadErrors)。
//   3. BOM 优先:UTF-8 / UTF-16LE / UTF-16BE。
//   4. 流式读取必须先把字节拼接后解码一次;绝不能对每个 chunk 单独 new TextDecoder,
//      否则多字节字符跨 chunk 会被拆成 U+FFFD。
// 本模块零依赖,godot 层与 core 层都可使用。

export interface DecodedText {
  text: string;
  /** 实际采用的编码。 */
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "gbk" | "windows-1252" | "latin1";
  /** true = 不是合法 UTF-8,已按回退编码解码。 */
  hadErrors: boolean;
}

/**
 * 解码一次完整的子进程输出。
 * `truncated=true` 时允许末尾存在被截断的 UTF-8 多字节序列(会先裁掉再试)。
 */
export function decodeProcessOutput(bytes: Buffer, options: { truncated?: boolean } = {}): DecodedText {
  if (bytes.length === 0) return { text: "", encoding: "utf-8", hadErrors: false };

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decode("utf-8", bytes.subarray(3), false) ?? bytes.subarray(3).toString("utf8"), encoding: "utf-8", hadErrors: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decode("utf-16le", bytes.subarray(2), false) ?? "", encoding: "utf-16le", hadErrors: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decode("utf-16be", bytes.subarray(2), false) ?? "", encoding: "utf-16be", hadErrors: false };
  }

  const strict = decode("utf-8", bytes, true);
  if (strict !== undefined) return { text: strict, encoding: "utf-8", hadErrors: false };

  if (options.truncated === true) {
    const trimmed = trimIncompleteUtf8Tail(bytes);
    if (trimmed !== undefined) {
      const text = decode("utf-8", trimmed, true);
      if (text !== undefined) return { text, encoding: "utf-8", hadErrors: false };
    }
  }

  const fallbacks = process.platform === "win32"
    ? (["gbk", "windows-1252", "latin1"] as const)
    : (["windows-1252", "latin1"] as const);
  for (const encoding of fallbacks) {
    const text = decode(encoding, bytes, false);
    if (text !== undefined) return { text, encoding, hadErrors: true };
  }
  return { text: bytes.toString("latin1"), encoding: "latin1", hadErrors: true };
}

/** 兼容 Node 未编译 full-icu 的环境:未知编码返回 undefined,由调用方继续回退。 */
function decode(encoding: string, bytes: Buffer, fatal: boolean): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * 截断发生在 UTF-8 字符中间时,去掉末尾 1–3 个不完整字节。
 * 只有"最后一段确实不完整"才返回新 Buffer;完整序列返回 undefined(交给正常回退)。
 */
export function trimIncompleteUtf8Tail(bytes: Buffer): Buffer | undefined {
  if (bytes.length === 0) return undefined;
  let i = bytes.length - 1;
  let continuation = 0;
  while (i >= 0 && (bytes[i]! & 0xc0) === 0x80 && continuation < 3) { i -= 1; continuation += 1; }
  if (i < 0) return undefined;
  const lead = bytes[i]!;
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (expected === 1) return undefined;
  return bytes.length - i < expected ? bytes.subarray(0, i) : undefined;
}
