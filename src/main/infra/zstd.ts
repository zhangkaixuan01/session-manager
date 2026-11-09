import fsp from 'node:fs/promises'
import { Decompress, decompress as zstdDecompress } from 'fzstd'

/**
 * Codex 的 `.jsonl.zst` 为单帧 zstd。流式解压头部若干行：
 * 解出 N 行即停，避免列表扫描时整份解压大文件。
 * （fzstd Decompress 为回调式：new Decompress(ondata) + push(chunk)）
 */
export async function readZstHeadLines(
  p: string,
  n: number,
  maxDecompressed = 512 * 1024
): Promise<string[]> {
  const fh = await fsp.open(p, 'r')
  try {
    const decoder = new TextDecoder()
    const chunk = Buffer.alloc(64 * 1024)
    let carry = ''
    let total = 0
    let done = false

    const d = new Decompress((out: Uint8Array) => {
      if (done || out.length === 0) return
      total += out.length
      carry += decoder.decode(out, { stream: true })
      const parts = carry.split('\n')
      if (parts.length > n) {
        // 已解出 n 个完整行
        carry = parts.slice(0, n).join('\n')
        done = true
      }
    })

    while (!done) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      d.push(chunk.subarray(0, bytesRead))
      if (!done && total > maxDecompressed) break
    }

    // 结尾：flush 剩余字节（或按上限截断）
    carry += decoder.decode()
    const parts = carry.split('\n')
    return parts.length > n ? parts.slice(0, n) : parts.filter((l) => l.length > 0)
  } finally {
    await fh.close()
  }
}

/** 全量解压（预览用），超出上限时截断并标记 */
export async function decompressZstCapped(
  p: string,
  maxBytes = 48 * 1024 * 1024
): Promise<{ text: string; truncated: boolean }> {
  const compressed = await fsp.readFile(p)
  const out = zstdDecompress(compressed)
  const truncated = out.byteLength > maxBytes
  const slice = truncated ? out.subarray(0, maxBytes) : out
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(slice), truncated }
}
