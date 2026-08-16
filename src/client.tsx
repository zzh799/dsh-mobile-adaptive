/**
 * dsh-mobile-adaptive, browser half. Three registrations:
 *
 *  - `shell.overlay` 的 MobileChrome：窄屏汉堡按钮 + 抽屉关闭交互（P1
 *    3.1）。抽屉的视觉层全部在 mobile.css（侧栏槽位改造成 fixed 抽屉，
 *    开合 = 框架自身的 data-sidebar-collapsed 属性）；这里只负责按钮、
 *    遮罩/菜单项点击关闭、Escape 关闭。
 *  - `conversation.input.left` 的 UploadButton：聊天输入框附件按钮
 *    （P2 3.4），批量选文件。
 *  - `conversation.input.dock` 的 UploadPanel：上传进度面板（批量、
 *    逐文件进度、成功/失败态、重试/移除）。
 *
 * 上传传输：宿主侧的 `/dsh-mobile-adaptive` 通用 RPC 通道（node 半身在
 * upload-host.ts），客户端按 1 MiB 切片 base64 传送 —— 走既有的连接
 * 传输层（自带信任围栏），每片到达即推进真实进度。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { defineStore, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BakedActions, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  IconCheckOutline16, IconLoadingOutline16, IconPaperclipOutline16,
  IconRefreshOutline14, IconTrashOutline16, IconWarningOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import mobileCss from './mobile.css'

export const name = 'dsh-mobile-adaptive'

/** Required client services: slots (registrations), connection (upload RPC), layout (抽屉开关). */
export const inject = ['slots', 'connection', 'layout'] as const

// ── 上传引擎（客户端）───────────────────────────────────────────────

/** 通用 RPC 通道名（与宿主管道的注册一致）。 */
const CHANNEL = '/dsh-mobile-adaptive'
/** 切片大小：1 MiB 二进制 → 约 1.37 MiB base64 每请求，局域网往返无感。 */
const CHUNK_BYTES = 1024 * 1024
/** 与宿主侧一致的逐文件上限（防御性重复声明，宿主才是权威）。 */
const MAX_FILE_BYTES = 2 * 1024 ** 3

/** 应用层信封：传输层 ok 恒为 true（错误码并集是闭的，插件自有错误走 value 槽）。 */
interface AppEnvelope<T = unknown> {
  status: 'ok' | 'error'
  data?: T
  code?: string
  message?: string
}

/** 单个上传条目在 store 中的 UI 状态。 */
export interface UploadItem {
  id: string
  name: string
  size: number
  sent: number
  status: 'uploading' | 'done' | 'error'
  /** 落盘后的最终文件名（重名自动改名后的结果）。 */
  targetName?: string
  error?: string
}

export interface UploadState {
  items: UploadItem[]
}

export interface UploadActionsDecl {
  add: (d: UploadState, item: UploadItem) => void
  patch: (d: UploadState, id: string, patch: Partial<UploadItem>) => void
  dismiss: (d: UploadState, id: string) => void
  clearDone: (d: UploadState) => void
}

type UploadActions = BakedActions<ReturnType<typeof createUploadStore>>

/** 会话级上传 store：按钮与进度面板共享同一句柄，框架按会话实例化。 */
function createUploadStore() {
  return defineStore({
    init: (): UploadState => ({ items: [] }),
    actions: {
      add: (d, item: UploadItem) => { d.items = [...d.items, item] },
      patch: (d, id: string, patch: Partial<UploadItem>) => {
        d.items = d.items.map(item => item.id === id ? { ...item, ...patch } : item)
      },
      dismiss: (d, id: string) => { d.items = d.items.filter(item => item.id !== id) },
      clearDone: (d) => { d.items = d.items.filter(item => item.status === 'uploading') },
    },
  })
}

/** 一次上传任务的运行期元数据（不进 store —— store 只放 UI 状态）。 */
interface JobMeta {
  cwd: string
  file: File
  rpc: ConnectionHandle['rpc']
  actions: UploadActions
  /** 代次号：重试使旧 run 的迟到 patch 失效。 */
  runId: number
}

const jobs = new Map<string, JobMeta>()
let runSeq = 0

function itemId(): string {
  return `dshm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** FileReader 读 base64（移动 Safari 对 FileReader 支持最稳）。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(blob)
  })
}

/** 解传输层信封 + 应用层信封；失败统一抛 Error（message 给用户看）。 */
function unwrap(result: { ok: boolean; value?: unknown; error?: { message?: string } }): AppEnvelope {
  if (!result.ok) throw new Error(result.error?.message ?? '上传失败')
  const envelope = result.value as AppEnvelope
  if (envelope.status !== 'ok') throw new Error(envelope.message ?? '上传失败')
  return envelope
}

/** 批量入队（PRD 3.4：支持批量上传）。 */
function enqueue(cwd: string, files: readonly File[], actions: UploadActions, rpc: ConnectionHandle['rpc']): void {
  for (const file of files) {
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
      actions.add({ id: itemId(), name: file.name, size: file.size, sent: 0, status: 'error', error: '文件大小超出允许范围（上限 2 GiB）' })
      continue
    }
    const id = itemId()
    jobs.set(id, { cwd, file, rpc, actions, runId: ++runSeq })
    actions.add({ id, name: file.name, size: file.size, sent: 0, status: 'uploading' })
    void runJob(id)
  }
}

/** 单个文件的上传循环：begin → 逐片 append（进度）→ commit。失败 abort 清理宿主临时文件。 */
async function runJob(id: string): Promise<void> {
  const job = jobs.get(id)
  if (job === undefined) return
  const runId = job.runId
  // 迟到的 patch（被重试代次超越）不得再写 store。
  const patch = (p: Partial<UploadItem>): void => {
    if (jobs.get(id)?.runId === runId) job.actions.patch(id, p)
  }
  try {
    const begin = unwrap(await job.rpc.call(CHANNEL, 'upload/begin', { cwd: job.cwd, name: job.file.name, size: job.file.size }))
    const uploadId = (begin.data as { uploadId: string }).uploadId
    try {
      let seq = 0
      for (let offset = 0; offset < job.file.size; offset += CHUNK_BYTES) {
        const chunk = job.file.slice(offset, Math.min(offset + CHUNK_BYTES, job.file.size))
        const data = await blobToBase64(chunk)
        unwrap(await job.rpc.call(CHANNEL, 'upload/append', { uploadId, seq: seq++, data }))
        patch({ sent: Math.min(offset + chunk.size, job.file.size) })
      }
      const commit = unwrap(await job.rpc.call(CHANNEL, 'upload/commit', { uploadId }))
      patch({ status: 'done', sent: job.file.size, targetName: (commit.data as { name: string }).name })
      // 成功即释放任务的 File 引用（大文件 blob 句柄）；失败保留供重试。
      jobs.delete(id)
    } catch (error) {
      void job.rpc.call(CHANNEL, 'upload/abort', { uploadId }).catch(() => {})
      throw error
    }
  } catch (error) {
    patch({ status: 'error', error: error instanceof Error ? error.message : String(error) })
  }
}

/** 重试一个失败条目：换新代次重新跑完整循环。 */
function retry(id: string): void {
  const job = jobs.get(id)
  if (job === undefined) return
  job.runId = ++runSeq
  job.actions.patch(id, { status: 'uploading', sent: 0, error: undefined })
  void runJob(id)
}

// ── 设置两层导航（移动端）──────────────────────────────────────────

/**
 * 移动端设置两层导航：第一层全屏分区列表（通用设置/模型/插件/…），点
 * 分区进第二层（具体设置项，左上角返回）。
 *
 * 不改 dsh 业务：面板还是 ui-settings 自己的（nav 切换 content 照常），
 * 这里只做三件事 —— ① 面板挂载时往内容区 header 最左注入返回按钮；② 捕
 * 获阶段监听分区按钮点击，在面板上写 data-dshm-settings-level="content"
 * （CSS 借此隐藏列表、显示内容层）；③ 返回按钮移除该属性回到列表层。
 * 每次打开面板 React 都重新挂载（新元素、无属性），天然回到第一层。
 * 桌面端 CSS 不生效、返回按钮隐藏，此模块在桌面无视觉影响。
 */
function setupSettingsDrilldown(): () => void {
  const panelOf = (): HTMLElement | null => document.querySelector('[role="dialog"][aria-labelledby]')

  const backButton = document.createElement('button')
  backButton.type = 'button'
  backButton.className = 'dshm-settings-back'
  backButton.setAttribute('aria-label', '返回分区列表')
  // 产品图标库的 chevron-left（IconChevronLeftOutline14 路径），fill 风格
  // 与图标集一致（插件不引 React 渲染，路径内联）。
  backButton.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M8.5 2.15137L8.07617 2.57617L5.34863 5.30273C5.09294 5.55843 4.86618 5.78438 4.70215 5.98828C4.53117 6.20088 4.38244 6.44405 4.33398 6.75C4.30778 6.91565 4.30778 7.08435 4.33398 7.25C4.38244 7.55595 4.53117 7.79912 4.70215 8.01172C4.86618 8.21561 5.09294 8.44157 5.34863 8.69727L8.07617 11.4238L8.5 11.8486L9.34863 11L8.92383 10.5762L6.19727 7.84863C5.92268 7.57405 5.75151 7.40124 5.6377 7.25977C5.53096 7.12709 5.52187 7.07728 5.51953 7.0625C5.51297 7.02105 5.51297 6.97895 5.51953 6.9375C5.52187 6.92272 5.53096 6.87291 5.6377 6.74023C5.75152 6.59876 5.92268 6.42595 6.19727 6.15137L8.92383 3.42383L9.34863 3L8.5 2.15137Z" fill="currentColor"/></svg><span class="dshm-settings-back-label"></span>'
  const backLabel = backButton.querySelector('.dshm-settings-back-label')
  const showList = (): void => { panelOf()?.removeAttribute('data-dshm-settings-level') }
  backButton.addEventListener('click', showList)

  // 第一层关闭按钮：分区列表层时 content 被 CSS 隐藏，真实关闭按钮
  // （在 content 的 header 里）不可见；注入按钮点击时驱动真实按钮的
  // click() —— React 的 onClose 是唯一关闭路径，不重复实现。第二层时
  // nav 隐藏，此按钮随之隐藏（header 里的真实 × 恢复可用）。
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'dshm-settings-close'
  closeButton.setAttribute('aria-label', '关闭设置')
  // 产品图标库的 ×（IconCloseOutline16 路径），14px 渲染与设置面板原关闭钮一致。
  closeButton.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z" fill="currentColor"/><path d="M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z" fill="currentColor"/></svg>'
  closeButton.addEventListener('click', () => {
    const panel = panelOf()
    if (panel === null) return
    const real = panel.querySelector(':scope > div:last-child > div:first-child > button:last-child')
    if (real instanceof HTMLButtonElement) real.click()
  })

  // 捕获阶段先于 React 的冒泡 onClick：给面板打内容层标记（React 同时
  // 切换 content 渲染，两者不冲突）。
  const onNavClick = (e: MouseEvent): void => {
    const target = e.target as Element | null
    const button = target?.closest('[role="dialog"][aria-labelledby] nav button')
    if (button === null || button === undefined) return
    const panel = panelOf()
    if (panel === null) return
    panel.dataset.dshmSettingsLevel = 'content'
    if (backLabel !== null) backLabel.textContent = (button.textContent ?? '').trim()
  }
  document.addEventListener('click', onNavClick, true)

  // 面板每次打开都重新挂载：注入返回/关闭按钮（同元素移动，旧的随面板
  // 一起移除），新面板无属性 = 第一层。
  let panel: HTMLElement | null = null
  const sync = (): void => {
    const next = panelOf()
    if (next === panel) return
    panel = next
    if (panel === null) return
    const header = panel.querySelector(':scope > div:last-child > div:first-child')
    header?.prepend(backButton)
    const navTitle = panel.querySelector('nav > div:first-child')
    navTitle?.append(closeButton)
  }
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true })
  sync()

  return () => {
    observer.disconnect()
    document.removeEventListener('click', onNavClick, true)
    backButton.remove()
    closeButton.remove()
  }
}

// ── 顶部工具条（移动/平板端）──────────────────────────────────────

/**
 * 移动/平板端（≤1023px）把底部输入栏的权限选择/模型选择搬到会话头部
 * 右侧工具条（替代原 标准模式/sessionlog 的位置）；原头部右侧条目
 * （标准模式标签、sessionlog 导出按钮等）收进工具条 + 号弹出的面板。
 *
 * 纯 DOM 层，不动 dsh 业务。搬移单位经过 React 删除语义校验：React 删
 * 除 fiber 时对"分支最顶层宿主节点"调用其纤维父节点 removeChild，嵌套
 * 节点只跑卸载副作用不碰 DOM —— 所以被搬的必须是【从不被 React 单独删
 * 除】的节点：
 *  - .modes（含权限选择）：InputBar 的无条件 JSX，只随输入条子树整体
 *    删除（此时只移除分支顶层节点）；权限选择 Menu 根 span 有
 *    key={sessionId}（切会话即删除重建），绝不能单独搬 —— 所以搬 .modes
 *    整体，再把 plan 座位锚点放回输入行。
 *  - model/plan 座位锚点、头部 actions/utilities 锚点：SlotOutlet 的无
 *    条件包装器（display:contents），同理从不被单独删除；条目本身删除
 *    发生在锚点内部，仍为其子级，安全。
 * 锚点两级：有框架 titleRow（会话已有消息）→ 工具条进标题行右端；空会话
 * （hero/blank）时框架完全不渲染 titleRow（<header> 也 display:none），此
 * 时工具条进插件自有的 dshm-topbar-standalone 行，插在会话语义列顶部 ——
 * 这样"会话还没有消息"也能把权限/模型选择上移到顶部。发第一条消息后框架
 * titleRow 出现，工具条平滑迁移回 titleRow（跨锚点由单一 sync 驱动，move()
 * 校验父子关系，不重复搬移）。
 * 桌面端（≥1024px）不搬；跨断点回到桌面时全部还原。MutationObserver 兜
 * 底组件重挂（新节点出现在原位）后的再次搬移。
 */
function setupTopbar(): () => void {
  const NARROW = '(max-width: 1023px)'
  const narrow = window.matchMedia(NARROW)
  /** 每个被搬移节点的原位（桌面还原 / 卸载清理用）。 */
  const origins = new WeakMap<Element, { parent: Element; next: Node | null }>()

  // 工具条骨架（插件自有 DOM，React 不管理）。
  const topbar = document.createElement('div')
  topbar.className = 'dshm-topbar'
  topbar.dataset.dshmTopbar = ''

  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'dshm-topbar-more'
  more.dataset.dshmTopbarMore = ''
  more.setAttribute('aria-label', '更多')
  more.setAttribute('aria-haspopup', 'menu')
  more.setAttribute('aria-expanded', 'false')
  // 产品图标库的 +（IconPlusOutline16 路径），与输入行命令按钮同款。
  more.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z" fill="currentColor"/></svg>'

  const pop = document.createElement('div')
  pop.className = 'dshm-topbar-pop'
  pop.dataset.dshmTopbarPop = ''
  pop.hidden = true
  topbar.append(more, pop)

  // 空会话（hero/blank）专用独立工具条行：框架的 header/titleRow 不渲染
  // 时，作为会话语义列顶部一条固定行承载 topbar。仅被 attach() 在
  // titleRow 缺失时挂载；有消息后框架 titleRow 出现，工具条迁移回 titleRow。
  const standalone = document.createElement('div')
  standalone.className = 'dshm-topbar-standalone'
  standalone.dataset.dshmTopbarStandalone = ''

  const toggle = (force?: boolean): void => {
    const open = force ?? pop.hidden
    pop.hidden = !open
    more.setAttribute('aria-expanded', String(!pop.hidden))
  }
  more.addEventListener('click', () => { toggle() })
  const onPointerDown = (e: PointerEvent): void => {
    if (pop.hidden) return
    if (e.target instanceof Node && topbar.contains(e.target)) return
    toggle(false)
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !pop.hidden) toggle(false)
  }
  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('keydown', onKeyDown)

  /** 搬移并记录原位；已在目标处则不动（防抖 MutationObserver 自激）。 */
  const move = (node: Element, to: Element, before: Node | null = null): void => {
    if (node.parentElement === to) return
    origins.set(node, { parent: node.parentElement ?? to, next: node.nextSibling })
    to.insertBefore(node, before)
  }
  const restore = (node: Element): void => {
    const from = origins.get(node)
    if (from === undefined) return
    from.parent.insertBefore(node, from.next)
    origins.delete(node)
  }

  const HEADER_SEL = '[data-slot="conversation.session.header"] > header'
  const TOOLS_SEL = '[data-composer-card] > div:last-child > div:first-child'
  const WRAP_SEL = '[data-composer-card] > div:last-child > div:last-child'
  const MODES_SEL = `${TOOLS_SEL} > div:not([data-slot])`
  const WRAP_KEYS = ['conversation.session.header.actions', 'conversation.session.header.utilities']

  /**
   * 把"当前节点"搬进容器，同时清掉容器里同类的陈旧节点。
   * 会话切换时 React 只在输入行按 key={sessionId} 重建新的 .modes/模型座位，
   * 已被搬到工具条里的旧节点会滞留成为孤儿 —— 若不清理，每切换一次就多一个。
   * 当输入行没有候选节点（node 为 null）时，说明工具条里同类的现存节点就是
   * 当前会话的，必须保留 —— 只有存在新的候选才去重并搬入。
   * @param node 当前会话的搬移候选（输入行里的节点），可为 null。
   * @param isSame 判定容器内某个子节点与当前节点同型（陈旧可清）与否。
   */
  const moveSingle = (node: Element | null, to: Element, before: Node | null, isSame: (child: Element) => boolean): void => {
    if (node === null) return
    for (const child of [...to.children]) {
      if (child === node) continue
      if (isSame(child)) child.remove()
    }
    move(node, to, before)
  }

  /** 空会话工具条行挂载到会话语义列顶部：header 座位（display:contents）之后、scrollBody 之前。 */
  const ensureStandalone = (header: Element): void => {
    const seat = header.closest('[data-slot="conversation.session.header"]') ?? header
    const parent = seat.parentElement
    if (parent === null) return
    if (topbar.parentElement !== standalone) standalone.append(topbar)
    if (standalone.parentElement === parent) return
    parent.insertBefore(standalone, seat.nextSibling)
  }

  /** 把节点插回容器指定下标处（无 origin 时的兜底参照），已在容器则不动。 */
  const placeBack = (node: Element, container: Element | null, index: number): void => {
    if (container === null || node.parentElement === container) return
    const ref = index < container.children.length ? container.children[index] : null
    if (ref === node) return
    if (ref !== null) container.insertBefore(node, ref)
    else container.appendChild(node)
  }

  /** 优先按 origins 原位还原；无 origin（切会话后的新节点）则兜底落到输入行正确位置。 */
  const restoreOrPlace = (node: Element, container: Element | null, index: number): void => {
    if (origins.has(node)) { restore(node); return }
    placeBack(node, container, index)
  }

  /** 还原所有搬移、工具条离场（桌面 / 卸载）。 */
  const detach = (): void => {
    const composer = document.querySelector('[data-composer-card]')
    const tools = composer?.querySelector(TOOLS_SEL) ?? null
    const trailing = composer?.querySelector(WRAP_SEL) ?? null
    // 窄屏期间可能切过会话：顶栏里被搬进来的 .modes/模型座位已脱离输入行，
    // 必须【从顶栏里找】它们并还原（不能只用输入行 querySelector，否则找不到、
    // 顶栏一 remove 就把权限/模型删掉）。顺序：先还原 .modes 到 tools，再还原
    // 其内部的 plan 座位，再还原模型座位到 trailing，最后还原头部槽位锚点。
    const isModesLike = (c: Element): boolean =>
      c instanceof HTMLElement && c.tagName === 'DIV'
      && !c.getAttribute('data-slot') && !c.hasAttribute('data-dshm-topbar-pop')
    const modes = [...topbar.children].find(isModesLike) ?? null
    if (modes !== null) restoreOrPlace(modes, tools, 1)
    const plan = document.querySelector('[data-slot="conversation.input.plan"]')
    if (plan !== null && plan !== modes) restoreOrPlace(plan, modes, 0)
    const model = [...topbar.children].find(c => c.getAttribute('data-slot') === 'conversation.input.model') ?? null
    if (model !== null) restoreOrPlace(model, trailing, 0)
    for (const key of WRAP_KEYS) {
      const wrap = document.querySelector(`[data-slot="${key}"]`)
      if (wrap !== null) restore(wrap)
    }
    // standalone 会连带移除其子级 topbar；topbar.remove() 兜底（已剥离则为 no-op）。
    standalone.remove()
    topbar.remove()
  }

  /**
   * 搬移（窄屏，≤1023px）。
   * 锚点两级：有框架 titleRow（会话已有消息）→ 工具条进标题行右端；titleRow 缺失
   * （空会话，框架完全没渲染 titleRow）→ 工具条进插件自有的 standalone 顶部行。
   * 权限/模型上移，头部条目收进 + 面板。跨锚点迁移只由本次 sync 的单一锚点驱动，
   * move() 显式校验父子关系，不重复搬移。
   */
  const attach = (): void => {
    const header = document.querySelector(HEADER_SEL)
    const composer = document.querySelector('[data-composer-card]')
    const tools = composer?.querySelector(TOOLS_SEL) ?? null
    if (header === null || tools === null) return
    const titleRow = header.querySelector(':scope > div:first-child')
    if (titleRow !== null) {
      // 有标题行：卸下 standalone，工具条进 titleRow 右端。
      standalone.remove()
      if (topbar.parentElement !== titleRow) titleRow.appendChild(topbar)
    } else {
      // 空会话：工具条进 standalone 顶部行。
      ensureStandalone(header)
    }
    // 权限选择所在的 .modes → 工具条（+ 之前）；并清掉切会话后滞留在
    // 工具条里的旧 .modes（同型即认定为陈旧，去重）。modes 的驱逐谓词只认
    // .modes 型（DIV 且无 data-slot/无弹出面板标记），不误伤模型座位锚点。
    const modes = document.querySelector(MODES_SEL)
    moveSingle(modes, topbar, more, child =>
      child instanceof HTMLElement
      && child.tagName === 'DIV'
      && !child.hasAttribute('data-slot')
      && !child.hasAttribute('data-dshm-topbar-pop'))
    // plan 座位放回输入行末尾（plan chip 留在底部，且不插在附件前）。
    const plan = document.querySelector('[data-slot="conversation.input.plan"]')
    if (plan !== null) move(plan, tools)
    // 模型选择座位 → 工具条（+ 之前）；同样去重工具条里滞留的旧模型座位。
    // 用 composer 卡片内查询作为"当前会话"的模型座位来源，避免 document 级
    // querySelector 命中已被搬进工具条的旧实例（搬移后 composer 内不再有，
    // 切会话时 React 会在 composer 内重建新的 —— 那才是要搬的）。
    const model = composer?.querySelector('[data-slot="conversation.input.model"]') ?? null
    moveSingle(model, topbar, more, child =>
      child.hasAttribute('data-slot')
      && child.getAttribute('data-slot') === 'conversation.input.model')
    // 头部右侧槽位锚点（标准模式/sessionlog/… 的容器）→ + 弹出面板。
    // 去重：pop 里同 slot 至多保留一个。切会话后旧锚点若滞留（孤儿），
    // 用当前锚点替换；当前头部位已无该 slot（空会话不渲染 titleRow/这些
    // 座位）则清掉 pop 里的滞留项，避免多次切换后"数量过多"。
    for (const key of WRAP_KEYS) {
      const keySel = `[data-slot="${key}"]`
      const current = document.querySelector(keySel)
      const orphan = pop.querySelector(keySel)
      if (current === null) { orphan?.remove(); continue }
      if (orphan !== null && orphan !== current) orphan.remove()
      move(current, pop)
    }
  }

  const sync = (): void => {
    if (narrow.matches) attach()
    else detach()
  }

  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true })
  // 跨断点（窗口缩放越过 1023px）不产生 DOM 突变，需单独监听。
  narrow.addEventListener('change', sync)
  sync()

  return () => {
    observer.disconnect()
    narrow.removeEventListener('change', sync)
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeyDown)
    detach()
  }
}

// ── 组件 ────────────────────────────────────────────────────────────

/** 会话列表的只读投影（按钮只取当前会话 cwd）。 */
interface SessionListLike {
  current?: string
  byId: Record<string, { cwd?: string }>
}
type UseSessions = (selector: (s: SessionListLike) => string | undefined) => string | undefined

/**
 * 汉堡按钮（shell.overlay）：窄屏可见。抽屉状态以框架的
 * data-sidebar-collapsed 属性为唯一事实源（MutationObserver 镜像），
 * 点击/Escape 只调 ctx.layout.toggleSidebar() —— 窄屏下 toggle 翻转的
 * 正是 narrowExpanded 覆盖位，抽屉视觉由 CSS 跟随该属性。
 */
function MobileChrome({ layout }: { layout: ILayout }) {
  const [open, setOpen] = useState(false)
  const frameOf = (): Element | null => document.querySelector('[data-slot="root"] > div')
  // 抽屉交互只属于窄屏（≤1023px）：桌面端侧栏折叠/展开是它自己的事，
  // 全局点击监听若不设门禁，会在桌面上把刚展开的侧栏又折叠回去
  // （点任意菜单项都触发）——宽屏"展不开"的 bug 就是它。
  const narrow = useRef(window.matchMedia('(max-width: 1023px)'))

  useEffect(() => {
    const sync = (): void => {
      const frame = frameOf()
      setOpen(narrow.current.matches && frame !== null && !frame.hasAttribute('data-sidebar-collapsed'))
    }
    sync()
    const frame = frameOf()
    if (frame === null) return
    const observer = new MutationObserver(sync)
    observer.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
    // 跨断点（窗口缩放）后同步一次抽屉状态。
    const onNarrowChange = (): void => { sync() }
    narrow.current.addEventListener('change', onNarrowChange)
    return () => {
      observer.disconnect()
      narrow.current.removeEventListener('change', onNarrowChange)
    }
  }, [])

  // 关闭交互：点抽屉外遮罩、或抽屉内任一菜单项 → 关抽屉；Escape → 关。
  // 抽屉内自带的"收起"按钮已在 CSS 中隐藏，因此不存在双重翻转。
  // 守卫：toggleSidebar 后框架属性要等下一次 React 渲染才更新，同一事件
  // 循环内的第二次点击（连点）可能翻转两次 —— 用 120ms 时间窗挡住。
  const lastToggleAt = useRef(0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !narrow.current.matches) return
      const frame = frameOf()
      if (frame !== null && !frame.hasAttribute('data-sidebar-collapsed')) layout.toggleSidebar()
    }
    const onClick = (e: globalThis.MouseEvent): void => {
      if (!narrow.current.matches) return
      const target = e.target as Element | null
      if (target !== null && target.closest('[data-dshm-hamburger]') !== null) return
      const now = Date.now()
      if (now - lastToggleAt.current < 120) return
      const frame = frameOf()
      if (frame !== null && !frame.hasAttribute('data-sidebar-collapsed')) {
        lastToggleAt.current = now
        layout.toggleSidebar()
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onClick)
    }
  }, [layout])

  return (
    <button
      type="button"
      data-dshm-hamburger
      aria-label={open ? '关闭菜单' : '打开菜单'}
      aria-expanded={open}
      onClick={() => {
        lastToggleAt.current = Date.now()
        layout.toggleSidebar()
      }}
    >
      {/* 产品图标集没有菜单图标；按图标集惯例重绘为 16 画板 fill 风格三条杠。 */}
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <path d="M2 3.2h12v1.6H2zM2 7.2h12v1.6H2zM2 11.2h12v1.6H2z" fill="currentColor" />
      </svg>
    </button>
  )
}

/** 附件按钮（conversation.input.left）：选文件入队，批量上传。 */
function UploadButton({ useSessions, actions, rpc }: {
  useSessions: UseSessions
  actions: UploadActions
  rpc: ConnectionHandle['rpc']
}) {
  const cwd = useSessions(s => s.byId[s.current]?.cwd)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)

  const onPick = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? [])
    // 清空 value 允许再次选择同一文件。
    e.target.value = ''
    if (files.length === 0 || cwd === undefined) return
    setBusy(true)
    // 入队与上传循环在微任务里跑，先放掉 change 事件。
    queueMicrotask(() => {
      enqueue(cwd, files, actions, rpc)
      setBusy(false)
    })
  }

  return (
    <>
      <button
        type="button"
        className="dshm-attach"
        aria-label="上传文件到工作区 ./上传/"
        title="上传文件到工作区 ./上传/"
        disabled={cwd === undefined || busy}
        onClick={() => { inputRef.current?.click() }}
      >
        <IconPaperclipOutline16 size={14} />
      </button>
      <input ref={inputRef} type="file" multiple hidden onChange={onPick} />
    </>
  )
}

/** 进度面板（conversation.input.dock）：逐文件进度条 + 成功/失败态。 */
function UploadPanel({ useStore, actions }: {
  useStore: SnapshotSelectorHook<UploadState>
  actions: UploadActions
}) {
  const items = useStore(s => s.items)
  if (items.length === 0) return null
  const uploading = items.filter(item => item.status === 'uploading').length
  const done = items.filter(item => item.status === 'done').length
  const failed = items.filter(item => item.status === 'error').length
  // 计数分段用产品同款分隔符（\u2002·\u2002，见 TodoPanel.progressLabel）。
  const hint = [
    ...(uploading > 0 ? [`${uploading} 个上传中`] : []),
    ...(done > 0 ? [`${done} 个完成`] : []),
    ...(failed > 0 ? [`${failed} 个失败`] : []),
  ].join('\u2002·\u2002')

  return (
    <div className="dshm-upload-panel">
      <div className="dshm-upload-head">
        <span className="dshm-upload-lead" aria-hidden><IconPaperclipOutline16 size={14} /></span>
        <span className="dshm-upload-head-title">上传到工作区 ./上传/</span>
        <span className="dshm-upload-head-hint">{hint}</span>
      </div>
      {items.map(item => <UploadRow key={item.id} item={item} actions={actions} />)}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function UploadRow({ item, actions }: { item: UploadItem; actions: UploadActions }) {
  const percent = item.size > 0 ? Math.round(item.sent / item.size * 100) : 0
  return (
    <div className="dshm-upload-item">
      <div className="dshm-upload-row">
        {/* 行首状态字形：与 Todo 行同一位置语义（16×16 格、14 图标）。 */}
        <span className={`dshm-upload-glyph dshm-upload-glyph-${item.status}`} aria-hidden>
          {item.status === 'uploading' && <IconLoadingOutline16 size={14} />}
          {item.status === 'done' && <IconCheckOutline16 size={14} />}
          {item.status === 'error' && <IconWarningOutline16 size={14} />}
        </span>
        <span className="dshm-upload-name" title={item.name}>{item.name}</span>
        <span className="dshm-upload-meta">
          {item.status === 'uploading' ? `${formatBytes(item.sent)} / ${formatBytes(item.size)}` : formatBytes(item.size)}
        </span>
        {item.status === 'done' && (
          <Tooltip label="移除" side="bottom" delayMs={500}>
            <button type="button" className="dshm-upload-action" aria-label="移除" onClick={() => { actions.dismiss(item.id) }}>
              <IconTrashOutline16 size={14} />
            </button>
          </Tooltip>
        )}
        {item.status === 'error' && (
          <>
            <Tooltip label="重试" side="bottom" delayMs={500}>
              <button type="button" className="dshm-upload-action" aria-label="重试" onClick={() => { retry(item.id) }}>
                <IconRefreshOutline14 />
              </button>
            </Tooltip>
            <Tooltip label="移除" side="bottom" delayMs={500}>
              <button type="button" className="dshm-upload-action" aria-label="移除" onClick={() => { actions.dismiss(item.id) }}>
                <IconTrashOutline16 size={14} />
              </button>
            </Tooltip>
          </>
        )}
      </div>
      {item.status === 'uploading' && (
        <div className="dshm-upload-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="dshm-upload-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {item.status === 'done' && (
        <div className="dshm-upload-done">已保存：./上传/{item.targetName ?? item.name}</div>
      )}
      {item.status === 'error' && item.error !== undefined && (
        <div className="dshm-upload-error">{item.error}</div>
      )}
    </div>
  )
}

// ── 挂载 ─────────────────────────────────────────────────────────────

/**
 * Mount the plugin: mobile stylesheet, drawer chrome, upload button + panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle

  // 结构样式：整份 mobile.css 注入 <style>，随插件卸载移除（桌面端规则
  // 不存在于该表内，注入与否都不影响 ≥1024px 渲染）。
  const styleTag = document.createElement('style')
  styleTag.dataset.plugin = name
  styleTag.dataset.pluginCss = `${name}/mobile.css`
  styleTag.textContent = mobileCss as string
  document.head.appendChild(styleTag)
  ctx.effect(() => () => { styleTag.remove() }, 'dsh-mobile-adaptive: mobile css')

  // 抽屉控制：shell.overlay（root 级，整帧浮动层）。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-mobile-adaptive-chrome',
    order: 100,
    inject: () => ({ layout: ctx.layout }),
  }, MobileChrome))

  // 设置两层导航（纯 DOM 层，不占槽位）。
  ctx.effect(() => setupSettingsDrilldown(), 'dsh-mobile-adaptive: settings drilldown')

  // 顶部工具条（纯 DOM 层，不占槽位）：权限/模型选择上移，标准模式/
  // sessionlog 收进 + 弹出面板。
  ctx.effect(() => setupTopbar(), 'dsh-mobile-adaptive: topbar')

  // 上传：按钮 + 进度面板共享同一会话级 store。
  const store = createUploadStore()
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.inject('conversation.input.dock', function* () {
      yield ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-mobile-adaptive-upload-button',
        order: 20,
        store,
        inject: () => ({ rpc: connection.rpc }),
      }, UploadButton)
      yield ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'dsh-mobile-adaptive-upload-panel',
        order: 20,
        store,
        inject: () => ({}),
      }, UploadPanel)
    }))
}
