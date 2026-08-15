/**
 * dsh-mobile-adaptive upload backend (host half). Receives chunked uploads over the
 * plugin's generic RPC channel (`/dsh-mobile-adaptive`) and lands each file in the
 * fixed staging directory `<session cwd>/上传/` (PRD 3.4: 固定暂存区，相对
 * 当前工作区，用户后续手动整理).
 *
 * Why chunked RPC instead of a multipart HTTP route: Node has no built-in
 * multipart parser, and a custom route would have to reimplement the /api
 * trust fence (DNS-rebinding + cross-site defense) plus duplicate the
 * deployment's `trustedHosts` config. The generic connection channel
 * (`ctx.connection.rpc.handle`) registers its own webserver route WITH the
 * fence, reusing the deployment authorities — the same transport the harness
 * itself uses. Chunking through RPC also gives real per-file progress (the
 * PRD requires it) without buffering whole files on the wire.
 *
 * Security posture: the write target must be the *current session's* cwd, an
 * existing directory. The client sends the cwd it believes it is working in;
 * the host re-validates that it is a fully-qualified, existing directory and
 * only ever writes inside `<cwd>/上传/`. This adds no new privilege over the
 * session itself (a caller who can reach the app can already start a session
 * and run commands as this process), while refusing garbage paths. File
 * names are sanitized to a single path segment (path separators stripped,
 * control characters removed, byte-capped) so a name can never escape the
 * staging directory.
 *
 * Collision rule (PRD 8 待确认 → 实现时确定): sequence numbers —
 * `报告.txt` → `报告 (1).txt` → `报告 (2).txt` … — computed at commit time
 * against the staging directory, and placed race-free via a no-clobber
 * `link()` (EEXIST retries the next candidate), so two concurrent uploads of
 * the same name cannot overwrite each other. The in-flight bytes live in a
 * `.dsh-upload-<uuid>.part` temp file next to the target; stale parts older
 * than an hour are swept on each begin, and plugin teardown closes and
 * removes everything still in flight.
 */

import { constants } from 'node:fs'
import { copyFile, link, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, posix, win32 } from 'node:path'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'

/** Fixed staging directory name, relative to the session cwd (PRD 3.4). */
export const UPLOAD_DIR = '上传'

/** Per-file ceiling; the client enforces the same bound before enqueueing. */
export const MAX_FILE_BYTES = 2 * 1024 ** 3

/** One chunk's decoded byte ceiling (the client slices at 1 MiB). */
const MAX_CHUNK_BYTES = 3 * 1024 * 1024

/** Concurrent in-flight upload ceiling (a runaway tab cannot pile up handles). */
const MAX_CONCURRENT = 16

/** Temp parts older than this are abandoned uploads (client vanished / session closed). */
const STALE_PART_MS = 60 * 60 * 1000

/** Rename candidate ceiling per name (defense against a directory full of `(n)` files). */
const MAX_RENAME_ATTEMPTS = 999

/** One in-flight upload: the open temp handle plus the accounting the fence checks. */
interface ActiveUpload {
  /** Staging directory (the write scope). */
  dir: string
  /** Sanitized single-segment file name (the collision candidates derive from it). */
  name: string
  /** The `.part` temp path inside `dir`. */
  tmpPath: string
  /** Open append handle on `tmpPath`. */
  handle: FileHandle
  /** Bytes accepted so far. */
  received: number
  /** Declared final size; appends may not exceed it. */
  expected: number
  /** Last accepted chunk sequence; chunks must arrive in strict order (dup/replay refused). */
  seq: number
}

const active = new Map<string, ActiveUpload>()

/** Application-level failure: mapped to the envelope, never thrown across the wire. */
class UploadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isEEXIST(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

/**
 * True when the path names one fixed filesystem location regardless of
 * process state (same rule the directory-picker browse backend applies):
 * POSIX-absolute on POSIX; on Windows only drive-qualified (`C:\…`) or
 * complete UNC (`\\server\share…`) forms. Rooted drive-less forms and
 * incomplete UNC prefixes resolve against the process's current drive and are
 * refused — the host must never rebase a wire value under its own cwd.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/**
 * Reduce a raw client file name to one safe path segment: strip both
 * separator styles by hand (a POSIX host treats `\` as an ordinary character,
 * so path.basename would keep a Windows client's full local path), remove
 * control characters, trim, and byte-cap. A name can never contain a
 * separator after this, so `join(dir, name)` cannot escape `dir`.
 */
function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new UploadError('upload-invalid-name', '文件名无效')
  const leaf = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1)
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new UploadError('upload-invalid-name', '文件名无效')
  }
  // Byte cap (240 ≤ the 255-byte common filesystem limit, leaving room for
  // the rename suffix); truncate on UTF-8 boundaries.
  const cap = 240
  if (Buffer.byteLength(cleaned, 'utf8') > cap) {
    let name = ''
    for (const char of cleaned) {
      if (Buffer.byteLength(name + char, 'utf8') > cap) break
      name += char
    }
    return name
  }
  return cleaned
}

/** Collision candidates for one name: itself, then `stem (n)ext` up to the ceiling. */
function nameCandidates(name: string): string[] {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const candidates = [name]
  for (let i = 1; i <= MAX_RENAME_ATTEMPTS; i += 1) candidates.push(`${stem} (${i})${ext}`)
  return candidates
}

/** Sweep abandoned `.part` files older than STALE_PART_MS (best effort). */
async function sweepStaleParts(dir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // dir vanished or unreadable: nothing to sweep
  }
  const now = Date.now()
  await Promise.all(entries.map(async (entry) => {
    if (!entry.startsWith('.dsh-upload-') || !entry.endsWith('.part')) return
    const path = join(dir, entry)
    try {
      const info = await stat(path)
      if (now - info.mtimeMs > STALE_PART_MS) await unlink(path)
    } catch {
      // raced with a live upload's unlink (or the file vanished): nothing to do
    }
  }))
}

/**
 * Place the finished temp file under its final name without ever overwriting:
 * `link()` is atomic and fails with EEXIST when the candidate exists, so the
 * exists-check and the place are one step (no TOCTOU window). On filesystems
 * where link is refused (FAT, some network mounts), fall back to
 * `copyFile` with COPYFILE_EXCL — same no-clobber semantics, one extra copy.
 * @returns the final name that won the slot.
 */
async function placeNoClobber(tmpPath: string, dir: string, name: string): Promise<string> {
  for (const candidate of nameCandidates(name)) {
    const target = join(dir, candidate)
    try {
      await link(tmpPath, target)
    } catch (error) {
      if (isEEXIST(error)) continue
      try {
        await copyFile(tmpPath, target, constants.COPYFILE_EXCL)
      } catch (copyError) {
        if (isEEXIST(copyError)) continue
        throw new UploadError('upload-write-failed', `无法写入 "${candidate}": ${messageOf(copyError)}`)
      }
    }
    await unlink(tmpPath).catch(() => {
      // The target is placed; a temp unlink failure leaves only litter.
    })
    return candidate
  }
  throw new UploadError('upload-name-exhausted', `重名候选已用尽（${String(MAX_RENAME_ATTEMPTS)} 个）`)
}

async function beginUpload(payload: unknown): Promise<{ uploadId: string }> {
  const { cwd, name, size } = payload as { cwd?: unknown; name?: unknown; size?: unknown }
  if (typeof cwd !== 'string' || !fullyQualified(cwd)) {
    throw new UploadError('upload-invalid-cwd', '无效的工作区路径')
  }
  let info
  try {
    info = await stat(cwd)
  } catch {
    throw new UploadError('upload-invalid-cwd', `工作区目录不存在：${cwd}`)
  }
  if (!info.isDirectory()) throw new UploadError('upload-invalid-cwd', `工作区路径不是目录：${cwd}`)
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
    throw new UploadError('upload-size-refused', '文件大小超出允许范围')
  }
  const safeName = sanitizeName(name)
  if (active.size >= MAX_CONCURRENT) {
    throw new UploadError('upload-busy', '同时上传的任务过多，请稍后再试')
  }
  const dir = join(cwd, UPLOAD_DIR)
  await mkdir(dir, { recursive: true })
  await sweepStaleParts(dir)
  const uploadId = randomUUID()
  const tmpPath = join(dir, `.dsh-upload-${uploadId}.part`)
  const handle = await open(tmpPath, 'a')
  active.set(uploadId, { dir, name: safeName, tmpPath, handle, received: 0, expected: size, seq: -1 })
  return { uploadId }
}

async function appendChunk(payload: unknown): Promise<{ received: number }> {
  const { uploadId, seq, data } = payload as { uploadId?: unknown; seq?: unknown; data?: unknown }
  if (typeof uploadId !== 'string') throw new UploadError('upload-invalid-id', '无效的上传会话')
  const current = active.get(uploadId)
  if (current === undefined) throw new UploadError('upload-unknown', '上传会话不存在或已结束')
  if (typeof seq !== 'number' || seq !== current.seq + 1) {
    throw new UploadError('upload-sequencing', '数据块顺序错误')
  }
  if (typeof data !== 'string') throw new UploadError('upload-invalid-chunk', '数据块无效')
  const buffer = Buffer.from(data, 'base64')
  if (buffer.byteLength === 0) throw new UploadError('upload-invalid-chunk', '数据块为空')
  if (buffer.byteLength > MAX_CHUNK_BYTES) throw new UploadError('upload-chunk-too-large', '数据块过大')
  if (current.received + buffer.byteLength > current.expected) {
    throw new UploadError('upload-size-exceeded', '文件超出声明大小')
  }
  await current.handle.write(buffer)
  current.received += buffer.byteLength
  current.seq = seq
  return { received: current.received }
}

async function commitUpload(payload: unknown): Promise<{ path: string; name: string }> {
  const { uploadId } = payload as { uploadId?: unknown }
  if (typeof uploadId !== 'string') throw new UploadError('upload-invalid-id', '无效的上传会话')
  const current = active.get(uploadId)
  if (current === undefined) throw new UploadError('upload-unknown', '上传会话不存在或已结束')
  active.delete(uploadId)
  // 完整性护栏：分片中途失败/中断的会话不得落盘一个残缺文件（append 的
  // 大小账本已保证 received 不可能超过 expected）。
  if (current.received !== current.expected) {
    await current.handle.close().catch(() => {})
    await unlink(current.tmpPath).catch(() => {})
    throw new UploadError('upload-incomplete', `文件不完整（已收 ${String(current.received)}/${String(current.expected)} 字节）`)
  }
  try {
    await current.handle.close()
  } catch (error) {
    throw new UploadError('upload-write-failed', `无法关闭临时文件：${messageOf(error)}`)
  }
  try {
    const name = await placeNoClobber(current.tmpPath, current.dir, current.name)
    return { path: join(current.dir, name), name }
  } catch (error) {
    await unlink(current.tmpPath).catch(() => {})
    throw error
  }
}

async function abortUpload(payload: unknown): Promise<Record<string, never>> {
  const { uploadId } = payload as { uploadId?: unknown }
  if (typeof uploadId === 'string') {
    const current = active.get(uploadId)
    if (current !== undefined) {
      active.delete(uploadId)
      await current.handle.close().catch(() => {})
      await unlink(current.tmpPath).catch(() => {})
    }
  }
  return {}
}

/** Close every handle and remove every temp part (plugin teardown). */
function disposeUploads(): void {
  for (const [uploadId, current] of [...active]) {
    active.delete(uploadId)
    void current.handle.close().catch(() => {})
    void unlink(current.tmpPath).catch(() => {})
  }
}

/**
 * Create the channel handler. Endpoint dispatch mirrors the RPC naming
 * (`upload/begin`, `upload/append`, `upload/commit`, `upload/abort`); every
 * answer is an application envelope inside a transport-ok result — the
 * transport's error-code union is closed, so plugin-owned failures travel in
 * the value slot and the wire schema never rejects them.
 * @returns the handler plus its teardown.
 */
export function createUploadChannel(): { handler: ConnectionRpcHandler; dispose: () => void } {
  const handler: ConnectionRpcHandler = async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'upload/begin':
          return { ok: true, value: { status: 'ok', data: await beginUpload(payload) } }
        case 'upload/append':
          return { ok: true, value: { status: 'ok', data: await appendChunk(payload) } }
        case 'upload/commit':
          return { ok: true, value: { status: 'ok', data: await commitUpload(payload) } }
        case 'upload/abort':
          return { ok: true, value: { status: 'ok', data: await abortUpload(payload) } }
        default:
          return { ok: true, value: { status: 'error', code: 'upload-unknown-endpoint', message: `未知的上传端点：${endpoint}` } }
      }
    } catch (error) {
      if (error instanceof UploadError) {
        return { ok: true, value: { status: 'error', code: error.code, message: error.message } }
      }
      return { ok: true, value: { status: 'error', code: 'upload-internal', message: messageOf(error) } }
    }
  }
  return { handler, dispose: disposeUploads }
}
