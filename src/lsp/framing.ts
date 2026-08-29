/**
 * L3 lsp — Content-Length 头帧编解码（契约篇 §6.7 手写最小桥的帧层）。
 *
 * LSP stdio 传输帧形态：`Content-Length: <字节数>\r\n\r\n<JSON 正文>`（头与
 * 正文以空行分隔，正文长度以头声明为准——与 MCP 的行帧不同，正文内可含换行）。
 *
 * 纯函数层：encodeFrame 给写面（单 JSON 字符串 → 完整帧文本），createFrameDecoder
 * 给读面（流式状态机——任意分块的 chunk 进、整帧 JSON 字符串出）。坏帧（头缺
 * Content-Length / 长度非数字）抛错交调用方归因连接死——LSP 服务器帧格式极稳定，
 * 防御性重同步是过度设计（架构优雅定律）。
 */

/** 帧头与正文之间的空行分隔符（\r\n\r\n） */
const HEADER_SEPARATOR = '\r\n\r\n';

/**
 * 编一帧（写面）：JSON 字符串 → `Content-Length: n\r\n\r\n` + 正文。
 * Content-Length 按**字节**计（UTF-8）——LSP 协议明文要求；Buffer.byteLength 计。
 */
export function encodeFrame(json: string): string {
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}${HEADER_SEPARATOR}${json}`;
}

/**
 * 流式帧解码器（读面）：返回喂食函数——调用方把子进程 stdout 的 chunk
 * （string | Buffer）逐个喂入，每解出一个完整帧回调 onFrame(json)。
 *
 * 状态机两态：攒头（找 \r\n\r\n 分隔）→ 攒正文（按头声明字节数切割）。
 * 注意正文按字节计数、缓冲按 utf8 解码——解码点必须落在帧边界上（正好
 * 攒满 Content-Length 字节才 toString），否则多字节字符被腰斩出 mojibake。
 */
export function createFrameDecoder(onFrame: (json: string) => void): (chunk: string | Buffer) => void {
  /** 未定形缓冲（头未齐或正文未满——帧边界上才解 utf8） */
  let buffer = Buffer.alloc(0);
  /** 当前帧正文的剩余字节数（undefined = 还在攒头段） */
  let pendingBodyBytes: number | undefined;

  return (chunk: string | Buffer): void => {
    buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk]);
    // 循环解帧：一次 chunk 可能含多个完整帧（服务器批量推送时常见）
    for (;;) {
      if (pendingBodyBytes === undefined) {
        // 攒头段：找 \r\n\r\n（Buffer.indexOf 收子串）
        const sep = buffer.indexOf(HEADER_SEPARATOR);
        if (sep === -1) return; // 头未齐——继续攒
        const header = buffer.subarray(0, sep).toString('utf8');
        // 头内找 Content-Length 行（多行头兼容——只认这一个键，其余行忽略）
        let length: number | undefined;
        for (const line of header.split('\r\n')) {
          const match = /^Content-Length:\s*(\d+)\s*$/i.exec(line);
          if (match !== null) {
            length = Number(match[1]);
            break;
          }
        }
        if (length === undefined) {
          throw new Error(`LSP 帧头缺 Content-Length（坏帧——连接不可信）：${header.slice(0, 200)}`);
        }
        // 头消费掉（含分隔符），切进攒正文段
        buffer = buffer.subarray(sep + HEADER_SEPARATOR.length);
        pendingBodyBytes = length;
      }
      if (buffer.length < pendingBodyBytes) return; // 正文未满——继续攒
      // 正文满：帧边界上解码 utf8（多字节字符安全），回调并进下一帧
      onFrame(buffer.subarray(0, pendingBodyBytes).toString('utf8'));
      buffer = buffer.subarray(pendingBodyBytes);
      pendingBodyBytes = undefined;
    }
  };
}
