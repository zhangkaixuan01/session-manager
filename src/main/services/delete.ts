import fsp from 'node:fs/promises'
import { shell } from 'electron'
import type { DeleteResult, ProviderId } from '@shared/types'
import { forgetCache } from '../infra/parse-cache'
import { siblingPath } from '../providers/codex'

async function trashIfExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
  } catch {
    return false
  }
  await shell.trashItem(p)
  return true
}

/** 移入回收站：Claude 含 sidecar 目录（子代理记录），Codex 含兄弟双形态（防复活） */
export async function deleteSession(
  providerId: ProviderId,
  sourcePath: string
): Promise<DeleteResult> {
  try {
    let extra = 0
    if (providerId === 'claude') {
      const sidecar = sourcePath.slice(0, -'.jsonl'.length)
      if (sidecar !== sourcePath && (await trashIfExists(sidecar))) extra++
    } else {
      if (await trashIfExists(siblingPath(sourcePath))) extra++
    }
    await shell.trashItem(sourcePath)
    forgetCache(sourcePath)
    forgetCache(siblingPath(sourcePath))
    return { ok: true, extraTrashed: extra }
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) }
  }
}
