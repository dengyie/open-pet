/**
 * OpenPet 渲染进程 — 桌面小猫的动画、交互与行为逻辑。
 *
 * 为什么是单文件：
 * Electron 沙盒环境下，preload 脚本的 require 路径解析受限，
 * <script type="module"> 在 file:// 协议下有 CORS 问题。
 * 因此所有渲染逻辑内联在此文件中，按依赖顺序组织。
 *
 * 内部模块顺序：DOM & 状态 → 气泡 → 动画 → 散步 → 拖拽 → 右键菜单 → 入口
 */

// ═══════════════════════════════════════════
// 1. DOM 引用 & 全局状态
// ═══════════════════════════════════════════

const pet = document.getElementById('pet')       // 主容器，承载所有指针事件
const catEl = document.getElementById('cat')     // 小猫元素，精灵图渲染目标
const bubble = document.getElementById('bubble') // 头顶气泡
const cursorOverlay = document.getElementById('custom-cursor-overlay') || {
  style: {},
  classList: { add() {}, remove() {}, contains() { return false } },
  removeAttribute() {},
  src: ''
}
const MAX_DISPLAY_SIZE = 260                     // 帧显示最大尺寸（px），超出按比例缩小
const PET_BASE_SCALE = 0.5                       // UI 100% 对应旧版视觉大小的 50%
const BUBBLE_TOP_INSET = 64                      // 给头顶聊天气泡预留窗口空间，避免被宠物裁剪或覆盖。
const MIN_INLINE_BUBBLE_DURATION = 4000          // 兼容旧配置，避免 1 秒级气泡闪退到不可读。
const SINGLE_CLICK_ACTION_DELAY_MS = 220         // 延迟执行单击动作，给原生 dblclick 留出取消窗口。
const FALLBACK_ANIMATION = {
  sprite: '../../cat_anime/sprites/bai_no_bg.png',
  frameWidth: 191,
  frameHeight: 453,
  frameCount: 16,
  frameMs: 95,
  loop: true
}
const cursorStyle = {
  resolvePetCursorStyle: () => '',
  resolvePetCursorOverlayState: () => ({ visible: false, assetUrl: '', nativeCursor: '' }),
  ...(window.OpenPetCursorStyle || {})
}
const petHitbox = window.OpenPetHitbox || {
  getFrameHitbox: () => null,
  getWindowHitbox: ({ windowWidth, windowHeight }) => ({
    left: 0,
    top: 0,
    right: Math.max(0, Number(windowWidth) || 0),
    bottom: Math.max(0, Number(windowHeight) || 0)
  }),
  isPointInHitbox: (point, hitbox) => {
    if (!hitbox) return true
    return point.x >= hitbox.left && point.x <= hitbox.right && point.y >= hitbox.top && point.y <= hitbox.bottom
  }
}

const state = {
  // ── 动画 ──
  action: '',            // 当前播放的动作 id
  defaultAction: '',     // 待机动作 id（循环播放）
  clickAction: '',       // 点击触发的一次性动作 id
  animations: {},        // 动作查找表 { id → { sprite, frameCount, frameMs, … } }
  currentAnimation: null,
  spriteRequest: 0,
  spritePending: false,
  loadedSprites: new Set(),
  frameIndex: 0,         // 当前帧序号
  frameTimer: 0,         // setInterval id，用于播放帧
  scale: PET_BASE_SCALE,
  committedScale: PET_BASE_SCALE,
  scalePreview: false,

  // ── 散步 ──
  walking: false,        // 是否正在移动
  walkGeneration: 0,
  walkReady: false,
  walkDirection: -1,     // 水平方向：-1 左 / 1 右
  walkMoving: false,     // 并发锁，防止 IPC moveBy 请求堆积
  walkTimer: 0,          // setInterval id，每 40ms 触发 tickWalk
  walkSpeed: 2,          // 每次移动像素数（由设置同步）
  walkDuration: 15000,   // 自动停止时长 ms（由设置同步）
  walkDurationTimer: 0,  // setTimeout id，到期后自动结束散步

  // ── 拖拽 ──
  drag: null,
  mousePassthrough: false,
  currentLayout: null,
  customCursor: { enabled: false, assetPath: '', assetUrl: '', fileName: '', width: 0, height: 0, hotspotX: 0, hotspotY: 0 },
  customCursorScope: 'openpet',
  customCursorOverlayVisible: false,
  cursorFocusRequested: false,
  windowFocused: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
  nativeCursor: '',
  lastPointerPoint: null,
  lastMouseDiagnostic: null,
  lastMouseDiagnosticAt: 0,

  // ── 气泡 ──
  bubbleTimer: 0,        // setTimeout id，到期后隐藏气泡
  bubbleDuration: 6000,  // 气泡显示时长 ms（由设置同步）
  clickActionTimer: 0    // 延迟执行单击动作，双击时可取消
}

const roundNumber = (value) => Math.round((Number(value) || 0) * 100) / 100
const normalizePetScale = (scale) => Math.max((Number(scale) || 1) * PET_BASE_SCALE, Number.EPSILON)
const logPetEvent = (event, details = {}, { level = 'debug', actor = 'system', message = event } = {}) => {
  window.petAPI.recordAppLog?.({
    level,
    actor,
    event,
    message,
    details: {
      action: state.action,
      frameIndex: state.frameIndex,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      scale: state.scale,
      ...details
    }
  })
}

const createPointDetails = (event) => ({
  clientX: roundNumber(event.clientX),
  clientY: roundNumber(event.clientY),
  screenX: roundNumber(event.screenX),
  screenY: roundNumber(event.screenY)
})

const maybeLogMouseDiagnostic = (event, diagnostic) => {
  const now = Date.now()
  const previous = state.lastMouseDiagnostic
  const changed = !previous ||
    previous.insideFrame !== diagnostic.insideFrame ||
    previous.insideCursorRegion !== diagnostic.insideCursorRegion ||
    previous.passthrough !== diagnostic.passthrough ||
    previous.cursorApplied !== diagnostic.cursorApplied ||
    previous.cursorOverlayVisible !== diagnostic.cursorOverlayVisible ||
    previous.dragging !== diagnostic.dragging ||
    previous.windowFocused !== diagnostic.windowFocused
  if (!changed && now - state.lastMouseDiagnosticAt < 1000) return
  state.lastMouseDiagnosticAt = now
  state.lastMouseDiagnostic = diagnostic
  logPetEvent('pet.pointer.diagnostic', {
    ...createPointDetails(event),
    ...diagnostic
  }, { actor: 'user', message: 'Pointer hitbox diagnostic' })
}

// ═══════════════════════════════════════════
// 2. 气泡 — 宠物窗口不再承载聊天 UI，统一交给独立 BubbleChatWindow
// ═══════════════════════════════════════════

const hideLegacyBubble = () => {
  window.clearTimeout(state.bubbleTimer)
  bubble.textContent = ''
  bubble.classList.remove('show')
}

const clearPendingClickAction = () => {
  window.clearTimeout(state.clickActionTimer)
  state.clickActionTimer = 0
}

/**
 * 汇总轻量文本到独立气泡聊天框，避免宠物窗口里再出现第二个聊天框。
 * @param {string} text 显示的文本
 * @param {number} [duration] 显示时长 ms，默认取 state.bubbleDuration
 */
const say = (text, duration = state.bubbleDuration) => {
  const normalizedText = String(text || '').trim()
  const displayDuration = Math.max(MIN_INLINE_BUBBLE_DURATION, Number(duration) || state.bubbleDuration)
  hideLegacyBubble()
  if (!normalizedText) return
  try {
    const request = window.petAPI.showBubbleChatMessage?.({
      text: normalizedText,
      ttlMs: displayDuration,
      source: 'pet-renderer'
    })
    request?.catch?.(() => {})
  } catch (_) {
    // Speech is decorative; never let a popup IPC failure break animation input.
  }
}

const openBubbleChat = () => {
  clearPendingClickAction()
  hideLegacyBubble()
  try {
    const request = window.petAPI.openBubbleChat?.()
    request?.catch?.(() => {})
  } catch (_) {
    // Opening chat is best-effort from the renderer; main-process logs cover failures.
  }
}

const scheduleClickAction = () => {
  clearPendingClickAction()
  state.clickActionTimer = window.setTimeout(() => {
    state.clickActionTimer = 0
    setAction(state.clickAction)
  }, SINGLE_CLICK_ACTION_DELAY_MS)
}

const handlePetClick = () => {
  scheduleClickAction()
}

const onPetDoubleClick = (event) => {
  logPetEvent('pet.pointer.double-click-detected', {
    ...createPointDetails(event)
  }, { level: 'info', actor: 'user', message: 'Pet double-click detected' })
  openBubbleChat()
}

// ═══════════════════════════════════════════
// 3. 动画引擎 — 精灵图 background-position 逐帧播放
// ═══════════════════════════════════════════

// 动画引擎内部状态，外部模块不感知
let frameStepX = 0  // 每帧的 background-position-x 偏移量（px）
let frameStepY = 0  // 每帧的 background-position-y 偏移量（px）
let frameColumn = 0 // 当前动作在 atlas 内的起始列
let frameRow = 0    // 当前动作在 atlas 内的行
let frameCount = 0  // 当前动作总帧数

/**
 * 根据原始帧尺寸计算实际 CSS 显示尺寸。
 * 确保宽度不超过 MAX_DISPLAY_SIZE，等比例缩放。
 */
const getDisplayDimensions = (animation) => {
  const s = Math.min(1, MAX_DISPLAY_SIZE / animation.frameWidth, MAX_DISPLAY_SIZE / animation.frameHeight)
  return { width: Math.round(animation.frameWidth * s), height: Math.round(animation.frameHeight * s), fitScale: s }
}

const getActionViewport = (animation, dims) => {
  const viewport = animation.viewport || { x: 0, y: 0, width: animation.frameWidth, height: animation.frameHeight, padding: 8 }
  const fitScale = dims.fitScale || 1
  const padding = Number(viewport.padding ?? 8)
  return {
    x: Math.round((Number(viewport.x) || 0) * fitScale),
    y: Math.round((Number(viewport.y) || 0) * fitScale),
    width: Math.max(1, Math.round((Number(viewport.width) || dims.width) * fitScale)),
    height: Math.max(1, Math.round((Number(viewport.height) || dims.height) * fitScale)),
    padding: Math.max(0, Math.round(padding * fitScale)),
    topInset: BUBBLE_TOP_INSET,
    scale: state.scale
  }
}

const getScaledViewportSize = (viewport) => {
  const padding = Math.max(0, Number(viewport?.padding) || 0)
  const scale = Math.max(Number(viewport?.scale) || state.scale, Number.EPSILON)
  return {
    width: Math.max(1, Math.round(((Number(viewport?.width) || 1) + padding * 2) * scale)),
    height: Math.max(1, Math.round(((Number(viewport?.height) || 1) + padding * 2) * scale) + Math.max(0, Number(viewport?.topInset) || 0))
  }
}

const applyCatPositionForWindowWidth = (layout, windowWidth) => {
  if (!layout?.viewport || !layout?.dims) return
  const { viewport, dims } = layout
  const catLeft = Math.round((windowWidth / 2) - ((viewport.x + viewport.width / 2) * state.scale))
  const catBottom = Math.round((viewport.padding - (dims.height - viewport.y - viewport.height)) * state.scale)

  catEl.style.left = catLeft + 'px'
  catEl.style.bottom = catBottom + 'px'
  layout.catLeft = catLeft
  layout.catBottom = catBottom
}

const applyActionLayout = (animation, dims) => {
  const viewport = getActionViewport(animation, dims)
  state.currentLayout = { viewport, dims, catLeft: 0, catBottom: 0 }
  applyCatPositionForWindowWidth(state.currentLayout, getScaledViewportSize(viewport).width)
  window.petAPI.setViewport?.(viewport)
}

const applySpriteGeometry = (animation, dims) => {
  const scaledWidth = Math.max(1, Math.round(dims.width * state.scale))
  const scaledHeight = Math.max(1, Math.round(dims.height * state.scale))
  catEl.style.width = scaledWidth + 'px'
  catEl.style.height = scaledHeight + 'px'
  frameStepX = Math.max(1, Math.round(animation.frameWidth * dims.fitScale * state.scale))
  frameStepY = Math.max(1, Math.round(animation.frameHeight * dims.fitScale * state.scale))
  const atlasColumns = animation.atlas?.columns || animation.frameCount
  const atlasRows = animation.atlas?.rows || 1
  catEl.style.backgroundSize = `${Math.round(atlasColumns * frameStepX)}px ${Math.round(atlasRows * frameStepY)}px`
}

/**
 * 帧 tick：偏移 background-position-x 切换到下一帧。
 * 循环动作播完后从头开始；一次性动作播完后切回待机。
 */
const tickFrame = () => {
  state.frameIndex += 1
  if (state.frameIndex >= frameCount) {
    const a = state.currentAnimation
    if (a?.loop) { state.frameIndex = 0 } else { setAction(state.defaultAction); return }
  }
  renderCurrentFrame()
  refreshMouseStateFromLastPoint()
  scheduleFrameTick()
}

const getFrameDuration = (animation, frameIndex) => {
  const durations = Array.isArray(animation?.frameDurations) ? animation.frameDurations : []
  return durations[frameIndex] || animation?.frameMs || 100
}

const renderCurrentFrame = () => {
  catEl.style.backgroundPositionX = -((frameColumn + state.frameIndex) * frameStepX) + 'px'
  catEl.style.backgroundPositionY = -(frameRow * frameStepY) + 'px'
}

const applyCurrentActionScale = () => {
  const currentAction = state.currentAnimation
  if (!currentAction) return
  const dims = getDisplayDimensions(currentAction)
  applyActionLayout(currentAction, dims)
  applySpriteGeometry(currentAction, dims)
  renderCurrentFrame()
  refreshMouseStateFromLastPoint()
}

const freezeActionForScalePreview = () => {
  if (state.spritePending || state.action !== state.defaultAction) {
    stopWalk()
    setAction(state.defaultAction, { scheduleFrame: false })
    return
  }
  state.frameIndex = 0
  window.clearTimeout(state.frameTimer)
  applyCurrentActionScale()
}

const scheduleFrameTick = () => {
  const a = state.currentAnimation
  window.clearTimeout(state.frameTimer)
  state.frameTimer = window.setTimeout(tickFrame, getFrameDuration(a, state.frameIndex))
}

const setMousePassthrough = (passthrough) => {
  const next = Boolean(passthrough)
  if (state.mousePassthrough === next) return
  state.mousePassthrough = next
  window.petAPI.setMousePassthrough?.(next)
  logPetEvent('pet.mouse.passthrough.changed', {
    passthrough: next
  }, { message: 'Mouse passthrough changed' })
}

const isPointInsideCurrentFrame = (clientX, clientY) => {
  if (state.drag || state.walking) return true
  const animation = state.currentAnimation
  const layout = state.currentLayout
  if (!animation || !layout) return true

  const hitbox = petHitbox.getFrameHitbox({
    animation,
    layout,
    frameIndex: state.frameIndex,
    windowHeight: window.innerHeight,
    scale: state.scale,
    mirrored: state.walkDirection > 0
  })
  return petHitbox.isPointInHitbox({ x: clientX, y: clientY }, hitbox)
}

const isPointInsideCursorRegion = (clientX, clientY) => {
  if (state.drag) return true
  const hitbox = petHitbox.getWindowHitbox({
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight
  })
  return petHitbox.isPointInHitbox({ x: clientX, y: clientY }, hitbox)
}

const setNativeCursor = (nextCursor) => {
  const value = nextCursor || ''
  const priority = value ? 'important' : ''
  document.documentElement.style.setProperty('cursor', value, priority)
  document.body.style.setProperty('cursor', value, priority)
  pet.style.setProperty('cursor', value, priority)
  state.nativeCursor = value
}

const isPointInsidePetWindow = (clientX, clientY) => (
  clientX >= 0 &&
  clientY >= 0 &&
  clientX <= window.innerWidth &&
  clientY <= window.innerHeight
)

const isPetWindowFocused = () => {
  return Boolean(state.windowFocused)
}

const moveCursorOverlay = (clientX, clientY) => {
  const hotspotX = Number.isFinite(Number(state.customCursor.hotspotX)) ? Number(state.customCursor.hotspotX) : 0
  const hotspotY = Number.isFinite(Number(state.customCursor.hotspotY)) ? Number(state.customCursor.hotspotY) : 0
  cursorOverlay.style.transform = `translate3d(${Math.round(clientX - hotspotX)}px, ${Math.round(clientY - hotspotY)}px, 0)`
}

const getCursorOverlayDimension = (configuredSize, naturalSize) => {
  const configured = Number(configuredSize)
  if (Number.isFinite(configured) && configured > 0) return configured
  const natural = Number(naturalSize)
  return Number.isFinite(natural) && natural > 0 ? natural : 48
}

const applyCursorOverlaySize = () => {
  const width = getCursorOverlayDimension(state.customCursor.width, cursorOverlay.naturalWidth)
  const height = getCursorOverlayDimension(state.customCursor.height, cursorOverlay.naturalHeight)
  cursorOverlay.style.width = `${Math.round(width)}px`
  cursorOverlay.style.height = `${Math.round(height)}px`
}

const hideCursorOverlay = () => {
  if (!state.customCursorOverlayVisible) return
  state.customCursorOverlayVisible = false
  cursorOverlay.classList.remove('visible')
}

const showCursorOverlay = (assetUrl, clientX, clientY) => {
  if (cursorOverlay.src !== assetUrl) cursorOverlay.src = assetUrl
  applyCursorOverlaySize()
  moveCursorOverlay(clientX, clientY)
  if (state.customCursorOverlayVisible) return
  state.customCursorOverlayVisible = true
  cursorOverlay.classList.add('visible')
}

const requestFocusForCursorIfNeeded = (overlayVisible, windowFocused) => {
  if (!overlayVisible || windowFocused || state.cursorFocusRequested) return
  state.cursorFocusRequested = true
  window.petAPI.requestFocusForCursor?.()
}

cursorOverlay.addEventListener?.('load', () => {
  applyCursorOverlaySize()
  if (state.customCursorOverlayVisible && state.lastPointerPoint) {
    moveCursorOverlay(state.lastPointerPoint.clientX, state.lastPointerPoint.clientY)
  }
})

const applyPetCursorStyle = (insideFrame, point = state.lastPointerPoint, insideCursorRegion = insideFrame) => {
  const context = {
    scope: state.customCursorScope,
    insideFrame,
    insideCursorRegion,
    windowFocused: isPetWindowFocused(),
    dragging: Boolean(state.drag)
  }
  const overlayState = cursorStyle.resolvePetCursorOverlayState(state.customCursor, context)

  if (overlayState.visible && !context.windowFocused) {
    hideCursorOverlay()
    setNativeCursor('')
    requestFocusForCursorIfNeeded(true, context.windowFocused)
    return { visible: false, assetUrl: overlayState.assetUrl, nativeCursor: '' }
  }

  setNativeCursor(overlayState.visible ? overlayState.nativeCursor : '')
  if (overlayState.visible && point) showCursorOverlay(overlayState.assetUrl, point.clientX, point.clientY)
  else hideCursorOverlay()
  if (context.windowFocused) state.cursorFocusRequested = false
  requestFocusForCursorIfNeeded(overlayState.visible, context.windowFocused)
  return overlayState
}

const preservePetCursorStyle = () => {
  state.customCursorFocusRequested = false
  hideCursorOverlay()
  state.cursorFocusRequested = false
  setNativeCursor('')
  return { visible: false, assetUrl: '', nativeCursor: state.nativeCursor }
}

const refreshMouseStateFromLastPoint = () => {
  if (!state.lastPointerPoint) {
    applyPetCursorStyle(false)
    return
  }
  updateMousePassthroughFromPoint(state.lastPointerPoint)
}

const updateMousePassthroughFromPoint = (event) => {
  state.lastPointerPoint = { clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY }
  const insideFrame = isPointInsideCurrentFrame(event.clientX, event.clientY)
  const insideCursorRegion = isPointInsideCursorRegion(event.clientX, event.clientY)
  const isInsideWindow = isPointInsidePetWindow(event.clientX, event.clientY)
  const cursorState = isInsideWindow
    ? applyPetCursorStyle(insideFrame, state.lastPointerPoint, insideCursorRegion)
    : preservePetCursorStyle()
  setMousePassthrough(!insideFrame)
  maybeLogMouseDiagnostic(event, {
    insideFrame,
    insideCursorRegion,
    insideWindow: isInsideWindow,
    passthrough: !insideFrame,
    cursorApplied: Boolean(cursorState.visible || state.nativeCursor),
    cursorOverlayVisible: cursorState.visible,
    nativeCursor: state.nativeCursor,
    windowFocused: isPetWindowFocused(),
    customCursorEnabled: Boolean(state.customCursor.enabled),
    dragging: Boolean(state.drag)
  })
}

const clearPointerHoverState = (event = {}) => {
  state.lastPointerPoint = null
  state.cursorFocusRequested = false
  hideCursorOverlay()
  setNativeCursor('')
  maybeLogMouseDiagnostic({
    clientX: event.clientX ?? -1,
    clientY: event.clientY ?? -1,
    screenX: event.screenX ?? -1,
    screenY: event.screenY ?? -1
  }, {
    insideFrame: false,
    insideCursorRegion: false,
    insideWindow: false,
    passthrough: true,
    cursorApplied: false,
    cursorOverlayVisible: false,
    nativeCursor: '',
    windowFocused: isPetWindowFocused(),
    customCursorEnabled: Boolean(state.customCursor.enabled),
    dragging: Boolean(state.drag)
  })
}

/**
 * 切换到指定动作，启动帧播放定时器。
 * — 动作无 sprite 时静默返回（防御性编程）。
 * — 点击动作（非待机）会先停止散步防止窗口移动干扰。
 * @param {string} action 动作 id
 */
const setAction = (action, options = {}) => {
  const a = state.animations[action]
  if (!a?.sprite) {
    logPetEvent('pet.action.ignored', {
      requestedAction: action,
      reason: 'missing-sprite'
    }, { level: 'info', message: 'Pet action ignored' })
    return
  }

  const request = ++state.spriteRequest
  state.spritePending = true
  window.clearTimeout(state.frameTimer)
  const preload = (animation, onLoad, onError) => {
    if (state.loadedSprites.has(animation.sprite)) {
      onLoad()
      return
    }
    const image = new window.Image()
    image.onload = () => {
      if (request !== state.spriteRequest) return
      state.loadedSprites.add(animation.sprite)
      onLoad()
    }
    image.onerror = () => {
      if (request === state.spriteRequest) onError?.()
    }
    image.src = animation.sprite
  }
  preload(a, () => applyLoadedAction(action, a, options), () => {
    logPetEvent('pet.action.ignored', {
      requestedAction: action,
      reason: 'sprite-load-failed'
    }, { level: 'warn', message: 'Pet sprite failed to load' })
    preload(FALLBACK_ANIMATION, () => applyLoadedAction(action, FALLBACK_ANIMATION, { ...options, announce: false }), () => {
      state.spritePending = false
      if (state.currentAnimation && !state.scalePreview) scheduleFrameTick()
    })
  })
}

const applyLoadedAction = (action, a, options) => {
  const previousAction = state.action
  state.action = action
  state.currentAnimation = a
  state.spritePending = false
  state.frameIndex = 0

  const dims = getDisplayDimensions(a)
  applyActionLayout(a, dims)
  applySpriteGeometry(a, dims)
  catEl.style.backgroundImage = 'url(' + a.sprite + ')'
  frameColumn = a.frameColumn || 0
  frameRow = a.frameRow || 0
  frameCount = a.frameCount
  renderCurrentFrame()
  setMousePassthrough(false)
  refreshMouseStateFromLastPoint()

  if (options.scheduleFrame === false || state.scalePreview) window.clearTimeout(state.frameTimer)
  else scheduleFrameTick()

  // 用户本地点击/菜单触发的非待机动作才提示动作名，避免 AI 回复被动作 label 覆盖。
  if (options.announce !== false && action === state.clickAction && action !== state.defaultAction) {
    stopWalk()
    say(a.label)
  }
  logPetEvent('pet.action.changed', {
    previousAction,
    nextAction: action,
    defaultAction: state.defaultAction,
    clickAction: state.clickAction,
    frameCount,
    frameWidth: a.frameWidth,
    frameHeight: a.frameHeight,
    viewportWidth: state.currentLayout?.viewport?.width,
    viewportHeight: state.currentLayout?.viewport?.height
  }, { level: 'info', message: 'Pet action changed' })
}

// ═══════════════════════════════════════════
// 4. 散步系统 — 水平移动 + 碰壁掉头 + 自动停止
// ═══════════════════════════════════════════

/** 设置散步方向并翻转猫咪图片（CSS 变量 --cat-direction）。 */
const setWalkDirection = (d) => {
  const nextDirection = d < 0 ? -1 : 1
  if (state.walkDirection === nextDirection) return
  state.walkDirection = nextDirection
  catEl.style.setProperty('--cat-direction', state.walkDirection < 0 ? '1' : '-1')
  refreshMouseStateFromLastPoint()
}

/** 掉头：方向取反。 */
const turnWalk = () => setWalkDirection(state.walkDirection * -1)

/**
 * 停止散步并清理自动停止定时器。
 * 多处调用：点击动作、菜单切换动作、自动停止到期。
 */
const stopWalk = () => {
  const wasWalking = state.walking
  state.walking = false
  state.walkReady = false
  state.walkGeneration += 1
  window.clearTimeout(state.walkDurationTimer)
  if (wasWalking) refreshMouseStateFromLastPoint()
}

/**
 * 散步移动 tick，每 40ms 由 setInterval 驱动。
 * — walkMoving 并发锁防止 IPC 堆积。
 * — 撞到屏幕边缘自动掉头。
 * — 约 1.2% 概率随机掉头增加自然感。
 */
const tickWalk = async () => {
  if (!state.walkReady || state.drag || state.walkMoving) return
  const generation = state.walkGeneration
  state.walkMoving = true
  try {
    const r = await window.petAPI.moveBy({ x: state.walkDirection * state.walkSpeed, y: 0 })
    if (generation !== state.walkGeneration) return
    if (r?.hitX || Math.random() < 0.012) turnWalk()
  } catch (_) {
    if (generation === state.walkGeneration) stopWalk()
  } finally {
    state.walkMoving = false
  }
}

/**
 * 切换散步模式（右键菜单触发）。
 * — 启动时查询贴边状态选择安全方向。
 * — 设置自动停止定时器（默认 15 秒）。
 */
const toggleWalk = async () => {
  if (state.walking) {
    stopWalk()
  } else {
    state.walking = true
    const generation = ++state.walkGeneration
    let ms
    try {
      ms = await window.petAPI.getMovementState()
    } catch (_) {}
    if (generation !== state.walkGeneration) return
    if (ms?.atRight) setWalkDirection(-1)
    else if (ms?.atLeft) setWalkDirection(1)
    else setWalkDirection(Math.random() > 0.5 ? 1 : -1)

    state.walkReady = true
    state.walkDurationTimer = window.setTimeout(() => {
      if (generation !== state.walkGeneration) return
      stopWalk(); setAction(state.defaultAction); say('散步结束')
    }, state.walkDuration)
  }

  setAction(state.defaultAction)
  say(state.walking ? '出发' : '休息一下')
  logPetEvent('pet.walk.toggled', {
    walking: state.walking,
    walkDirection: state.walkDirection,
    walkSpeed: state.walkSpeed,
    walkDuration: state.walkDuration
  }, { level: 'info', actor: 'user', message: 'Walk toggled' })
}

// ═══════════════════════════════════════════
// 5. 拖拽 — 鼠标移动窗口，主进程负责边界钳制
// ═══════════════════════════════════════════

/**
 * pointerdown：记录鼠标相对窗口偏移，进入拖拽状态。
 * 忽略右键（button !== 0）。
 */
const onPointerDown = async (event) => {
  if (event.button !== 0 || state.drag) return
  const insideFrame = isPointInsideCurrentFrame(event.clientX, event.clientY)
  const insideCursorRegion = isPointInsideCursorRegion(event.clientX, event.clientY)
  try {
    pet.setPointerCapture(event.pointerId)
  } catch (_) {
    return
  }
  const drag = { pointerId: event.pointerId, offset: null, lastMove: null }
  state.drag = drag
  pet.classList.add('dragging')
  updateMousePassthroughFromPoint(event)

  let bounds
  try {
    bounds = await window.petAPI.getBounds()
  } catch (_) {
    if (state.drag === drag) cancelDrag(event)
    return
  }
  if (state.drag !== drag) return
  if (!bounds) {
    cancelDrag(event)
    return
  }
  drag.offset = { x: event.screenX - bounds.x, y: event.screenY - bounds.y }
  if (drag.lastMove) moveDragTo(drag)
  logPetEvent('pet.pointer.down', {
    ...createPointDetails(event),
    button: event.button,
    insideFrame,
    insideCursorRegion,
    mousePassthrough: state.mousePassthrough,
    cursorApplied: Boolean(pet.style.cursor),
    cursorOverlayVisible: state.customCursorOverlayVisible,
    nativeCursor: state.nativeCursor,
    boundsWidth: bounds.width,
    boundsHeight: bounds.height
  }, { actor: 'user', message: 'Pointer down' })
}

const moveDragTo = ({ offset, lastMove }) => {
  window.petAPI.setPosition({ x: lastMove.screenX - offset.x, y: lastMove.screenY - offset.y })
}

const onPointerMove = (event) => {
  const drag = state.drag
  if (!drag || event.pointerId !== drag.pointerId) return
  drag.lastMove = { screenX: event.screenX, screenY: event.screenY }
  if (drag.offset) moveDragTo(drag)
}

const clearDrag = () => {
  const drag = state.drag
  if (!drag) return
  state.drag = null
  pet.classList.remove('dragging')
  if (pet.hasPointerCapture?.(drag.pointerId)) pet.releasePointerCapture(drag.pointerId)
}

const cancelDrag = (event) => {
  if (event.pointerId !== state.drag?.pointerId) return
  clearDrag()
  refreshMouseStateFromLastPoint()
}

/** pointerup：未移动 → 视为点击 → 触发 clickAction。 */
const onPointerUp = (event) => {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return
  const wasClick = !state.drag.lastMove
  const wasDrag = Boolean(state.drag.lastMove && state.drag.offset)
  const insideFrame = isPointInsideCurrentFrame(event.clientX, event.clientY)
  const insideCursorRegion = isPointInsideCursorRegion(event.clientX, event.clientY)
  clearDrag()
  if (wasDrag) window.petAPI.dragEnded?.()
  updateMousePassthroughFromPoint(event)
  logPetEvent('pet.pointer.up', {
    ...createPointDetails(event),
    wasClick,
    wasDrag,
    insideFrame,
    insideCursorRegion,
    cursorOverlayVisible: state.customCursorOverlayVisible,
    nativeCursor: state.nativeCursor,
    clickAction: state.clickAction
  }, { actor: 'user', message: 'Pointer up' })
  if (wasClick) {
    if (state.walking) toggleWalk()
    else handlePetClick(event)
  }
}

// ═══════════════════════════════════════════
// 6. 右键菜单 — 主进程原生菜单 + 命令分发
// ═══════════════════════════════════════════

const applyAnimationsConfig = ({ actions, defaultAction, clickAction }) => {
  state.spriteRequest += 1
  state.spritePending = false
  state.loadedSprites.clear()
  state.defaultAction = defaultAction
  state.clickAction = clickAction
  state.animations = Object.fromEntries(actions.map((a) => [a.id, a]))
  if (state.defaultAction) setAction(state.defaultAction)
}

const showContextMenu = (event) => {
  event.preventDefault()
  setMousePassthrough(false)
  applyPetCursorStyle(false)
  window.petAPI.showContextMenu?.({ x: event.clientX, y: event.clientY })
}

const runMenuCommand = (payload) => {
  logPetEvent('pet.menu.action.selected', {
    selectedAction: payload?.command === 'action' ? payload.actionId : payload?.command
  }, { level: 'info', actor: 'user', message: 'Pet menu action selected' })
  if (payload?.command === 'walk') toggleWalk()
  else if (payload?.command === 'action' && payload.actionId) {
    stopWalk()
    setAction(payload.actionId)
  }
}

// ═══════════════════════════════════════════
// 7. 入口 — 绑定事件、同步设置、启动应用
// ═══════════════════════════════════════════

// 监听主进程推送的设置变更，同步到渲染状态
const applyScaleSettings = ({ scale, scalePreview }) => {
  if (scale == null) return
  const nextScale = normalizePetScale(scale)
  if (scalePreview === true) {
    if (state.scale !== nextScale) {
      state.scale = nextScale
      state.scalePreview = true
      freezeActionForScalePreview()
    }
    return
  }
  if (scalePreview !== false && state.scalePreview && nextScale === state.committedScale) return
  state.committedScale = nextScale
  const wasPreview = state.scalePreview
  state.scalePreview = false
  if (nextScale !== state.scale) {
    state.scale = nextScale
    applyCurrentActionScale()
  }
  if (wasPreview && !state.spritePending && state.currentAnimation) scheduleFrameTick()
}

window.petAPI.onSettingsChanged((s) => {
  applyScaleSettings(s)
  if (s.walkSpeed != null) state.walkSpeed = s.walkSpeed
  if (s.walkDuration != null) state.walkDuration = s.walkDuration
  if (s.bubbleDuration != null) state.bubbleDuration = s.bubbleDuration
  if (s.customCursorScope === 'system' || s.customCursorScope === 'openpet') {
    state.customCursorScope = s.customCursorScope
  }
  if (s.customCursor) {
    state.customCursor = {
      enabled: Boolean(s.customCursor.enabled && s.customCursor.assetUrl),
      assetPath: s.customCursor.assetPath || '',
      assetUrl: s.customCursor.assetUrl || '',
      fileName: s.customCursor.fileName || '',
      width: Number(s.customCursor.width) || 0,
      height: Number(s.customCursor.height) || 0,
      hotspotX: Number(s.customCursor.hotspotX) || 0,
      hotspotY: Number(s.customCursor.hotspotY) || 0
    }
    refreshMouseStateFromLastPoint()
  }
  logPetEvent('pet.settings.applied', {
    scaleUpdated: s.scale != null,
    walkSpeedUpdated: s.walkSpeed != null,
    walkDurationUpdated: s.walkDuration != null,
    bubbleDurationUpdated: s.bubbleDuration != null,
    customCursorUpdated: Boolean(s.customCursor),
    customCursorScope: state.customCursorScope,
    customCursorEnabled: Boolean(state.customCursor.enabled),
    customCursorFileName: state.customCursor.fileName || ''
  }, { level: 'info', message: 'Pet renderer settings applied' })
})

window.petAPI.onPetSay((payload) => {
  if (!payload?.text) return
  hideLegacyBubble()
  logPetEvent('pet.say.legacy-ignored', {
    source: payload.source || '',
    textChars: String(payload.text || '').length
  }, { message: 'Legacy inline pet speech ignored by renderer' })
})

window.petAPI.onPetAction((payload) => {
  if (payload?.actionId) {
    stopWalk()
    setAction(payload.actionId, { announce: false })
  }
})

window.petAPI.onAnimationsChanged((config) => {
  if (config?.actions) applyAnimationsConfig(config)
})

window.petAPI.onPetMenuCommand?.(runMenuCommand)

// DOM 事件绑定
pet.addEventListener('pointerdown', onPointerDown)
pet.addEventListener('pointermove', updateMousePassthroughFromPoint)
pet.addEventListener('pointermove', onPointerMove)
pet.addEventListener('pointerup', onPointerUp)
pet.addEventListener('pointercancel', cancelDrag)
pet.addEventListener('lostpointercapture', cancelDrag)
pet.addEventListener('pointerleave', clearPointerHoverState)
pet.addEventListener('dblclick', onPetDoubleClick)
pet.addEventListener('contextmenu', showContextMenu)
window.addEventListener('focus', () => {
  state.windowFocused = true
  state.cursorFocusRequested = false
  refreshMouseStateFromLastPoint()
})
window.addEventListener('blur', () => {
  state.windowFocused = false
  clearDrag()
  clearPointerHoverState()
})  // 窗口失焦时清理 hover 态
window.addEventListener('resize', refreshMouseStateFromLastPoint)

/**
 * 启动流程：
 * 1. 从主进程获取动作配置
 * 2. 缓存动作表供菜单命令使用
 * 3. 播放待机动画
 * 4. 启动散步 tick 循环（40ms ≈ 25fps）
 */
const start = async () => {
  const config = await window.petAPI.getAnimations()
  applyAnimationsConfig(config)
  logPetEvent('pet.renderer.started', {
    actionsCount: Array.isArray(config?.actions) ? config.actions.length : 0,
    defaultAction: state.defaultAction,
    clickAction: state.clickAction
  }, { level: 'info', message: 'Pet renderer started' })

  if (!state.defaultAction) { say('没有找到动作图片'); return }

  state.walkTimer = window.setInterval(tickWalk, 40)
}

start()
