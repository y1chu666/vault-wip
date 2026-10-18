// 本模块收拢文本与字节之间的转换。
//
// 单独成文件是为了让编码方式只有一处：记录内容、导出文件与密钥串都经过这里，
// 将来若要改变编码，只需改这一处，不必在调用方逐个寻找。
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** 把文本编码为 UTF-8 字节。 */
export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

/** 把 UTF-8 字节解码为文本。 */
export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * 把字节解码为路径文本。
 *
 * 与 {@link decodeText} 不同，这里不因非法字节序列报错：路径来自文件系统，
 * 含有非 UTF-8 字节的文件名虽然罕见，但让整次采集因此失败并不值得。
 */
export function decodePaths(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
