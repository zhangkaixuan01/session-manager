import fsp from 'node:fs/promises'
import fs from 'node:fs'
import readline from 'node:readline'

/** 小于该阈值直接整读，避免两次 seek */
const SMALL_FILE = 16 * 1024

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/**
 * 读取文件头 N 行与尾 M 行（翻译自 cc-switch utils.rs read_head_tail_lines）。
 * 大文件只读头部 16KiB 与末尾 16KiB 窗口；seek 落入行中间产生的残行会被丢弃。
 */
export async function readHeadTailLines(
  p: string,
  headN: number,
  tailN: number
): Promise<{ head: string[]; tail: string[] }> {
  const fh = await fsp.open(p, 'r')
  try {
    const { size } = await fh.stat()
    if (size <= SMALL_FILE) {
      const lines = splitLines((await fh.readFile('utf8')) as string)
      while (lines.length && lines[lines.length - 1] === '') lines.pop()
      return { head: lines.slice(0, headN), tail: lines.slice(-tailN) }
    }

    // 头部
    const headLen = Math.min(SMALL_FILE, size)
    const headBuf = Buffer.alloc(headLen)
    await fh.read(headBuf, 0, headLen, 0)
    const headLines = splitLines(headBuf.toString('utf8'))
    if (headLines.length > headN) headLines.length = headN

    // 尾部（丢弃 seek 残行）
    const tailStart = size - SMALL_FILE
    const tailBuf = Buffer.alloc(SMALL_FILE)
    await fh.read(tailBuf, 0, SMALL_FILE, tailStart)
    let tailLines = splitLines(tailBuf.toString('utf8'))
    tailLines = tailLines.slice(1)
    while (tailLines.length && tailLines[tailLines.length - 1] === '') tailLines.pop()
    return { head: headLines, tail: tailLines.slice(-tailN) }
  } finally {
    await fh.close()
  }
}

/**
 * 读取文件末尾 bytes 字节窗口内的完整行（Claude 的 custom-title/relocated 等
 * 元数据写在末尾 64KiB 内，尾 30 行窗口不够稳）。
 */
export async function readTailBytesLines(p: string, bytes: number): Promise<string[]> {
  const fh = await fsp.open(p, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    let lines = splitLines(buf.toString('utf8'))
    if (start > 0 && lines.length) lines = lines.slice(1)
    return lines.filter((l) => l.length > 0)
  } finally {
    await fh.close()
  }
}

/**
 * 逐行读取文件前 n 行（流式，单行可任意长）。
 * Codex 的 session_meta 行内嵌完整 base_instructions（几十 KB），
 * 字节窗口式读取会把它截成残行，必须按行读。
 */
export async function readFirstLines(p: string, n: number): Promise<string[]> {
  const rl = readline.createInterface({
    input: fs.createReadStream(p, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  const lines: string[] = []
  try {
    for await (const line of rl) {
      lines.push(line)
      if (lines.length >= n) break
    }
  } finally {
    rl.close()
  }
  return lines
}
