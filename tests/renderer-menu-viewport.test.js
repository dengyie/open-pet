const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createPetRendererElements, createSpriteImage } = require('./fixtures/pet-renderer-elements')

const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'desktop', 'renderer.js'), 'utf-8')

const createStyle = () => ({
  values: {},
  setProperty(name, value) {
    this.values[name] = String(value)
  }
})

const createClassList = () => ({
  values: new Set(),
  add(value) { this.values.add(value) },
  remove(value) { this.values.delete(value) },
  contains(value) { return this.values.has(value) }
})

const createElement = (id = '') => ({
  id,
  style: createStyle(),
  dataset: {},
  textContent: '',
  children: [],
  className: '',
  classList: createClassList(),
  appendChild(child) { this.children.push(child) },
  addEventListener(eventName, callback) {
    this.listeners[eventName] ||= []
    this.listeners[eventName].push(callback)
  },
  listeners: {},
  setPointerCapture() {}
})

const dispatch = async (element, eventName, event = {}) => {
  for (const listener of element.listeners[eventName] || []) await listener(event)
}

const createRendererHarness = async ({
  insideFrame = true,
  idleFrames,
  getBounds = async () => ({ x: 0, y: 0, width: 58, height: 58 }),
  getMovementState = async () => ({}),
  moveBy = async () => ({})
} = {}) => {
  const viewportCalls = []
  const contextMenuRequests = []
  const mousePassthroughCalls = []
  const openBubbleChatRequests = []
  const bubbleChatMessages = []
  const timers = []
  const intervals = []
  const callbacks = {}
  const logs = []
  const positions = []
  const dragEnds = []
  const elements = createPetRendererElements(createElement)
  const context = {
    console,
    document: {
      documentElement: { style: createStyle() },
      body: { style: createStyle() },
      getElementById: (id) => elements[id] ?? null,
      createElement: () => createElement()
    },
    window: {
      Image: createSpriteImage(),
      innerWidth: 58,
      innerHeight: 122,
      OpenPetCursorStyle: { resolvePetCursorStyle: () => '', resolvePetCursorOverlayState: () => ({ visible: false, assetUrl: '', nativeCursor: '' }) },
      OpenPetHitbox: idleFrames ? require('../packages/shared/src/pet-hitbox.cjs') : {
        getFrameHitbox: () => ({ left: 0, top: 0, right: 58, bottom: 58 }),
        getWindowHitbox: () => ({ left: 0, top: 0, right: 58, bottom: 58 }),
        getViewportHitbox: () => ({ left: 0, top: 0, right: 58, bottom: 58 }),
        isPointInHitbox: () => insideFrame
      },
      clearTimeout: (timer) => {
        if (timer) timer.cleared = true
      },
      addEventListener(eventName, callback) { callbacks[eventName] = callback },
      setInterval: (callback) => { intervals.push(callback); return intervals.length },
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, cleared: false }
        timers.push(timer)
        return timer
      },
      petAPI: {
        getAnimations: async () => ({
          defaultAction: 'idle',
          clickAction: 'feed',
          actions: [
            { id: 'idle', label: 'Idle', loop: true, sprite: 'idle.png', frameWidth: 100, frameHeight: 100, frameCount: idleFrames?.length ?? 4, frameMs: 100, frames: idleFrames },
            { id: 'feed', label: 'Feed', loop: false, sprite: 'feed.png', frameWidth: 100, frameHeight: 100, frameCount: 4, frameMs: 100 }
          ]
        }),
        setViewport: (viewport) => viewportCalls.push(viewport),
        setMousePassthrough: (passthrough) => mousePassthroughCalls.push(passthrough),
        recordAppLog: (entry) => logs.push(entry),
        onSettingsChanged: () => {},
        onPetSay: () => {},
        onPetAction: (callback) => { callbacks.action = callback },
        onPetMenuCommand: (callback) => { callbacks.menuCommand = callback },
        onAnimationsChanged: () => {},
        showContextMenu: (point) => contextMenuRequests.push(point),
        getBounds,
        getMovementState,
        moveBy,
        setPosition: ({ x, y }) => positions.push({ x, y }),
        dragEnded: () => dragEnds.push(true),
        quit: () => {},
        openSettings: () => {},
        openBubbleChat: () => {
          openBubbleChatRequests.push({})
          return Promise.resolve({ visible: true })
        },
        showBubbleChatMessage: (payload) => {
          bubbleChatMessages.push(payload)
          return Promise.resolve({ visible: true })
        }
      }
    }
  }
  context.window.document = context.document
  context.globalThis = context
  vm.runInNewContext(rendererSource, context, { filename: 'renderer.js' })
  await Promise.resolve()
  await Promise.resolve()
  return { bubbleChatMessages, callbacks, contextMenuRequests, dragEnds, elements, intervals, logs, mousePassthroughCalls, openBubbleChatRequests, positions, timers, viewportCalls }
}

test('right-click delegates menu placement to the main-process menu', async () => {
  const { contextMenuRequests, elements, mousePassthroughCalls, viewportCalls } = await createRendererHarness()
  const initialViewport = viewportCalls.at(-1)
  let prevented = false

  await dispatch(elements.pet, 'contextmenu', {
    clientX: 12,
    clientY: 18,
    preventDefault() { prevented = true }
  })

  assert.equal(prevented, true)
  assert.equal(contextMenuRequests.length, 1)
  assert.equal(contextMenuRequests[0].x, 12)
  assert.equal(contextMenuRequests[0].y, 18)
  assert.deepEqual(viewportCalls.at(-1), initialViewport)
  assert.notEqual(mousePassthroughCalls.at(-1), true)
})

test('right-clicking the pet does not resize or offset the current action viewport', async () => {
  const { contextMenuRequests, elements, viewportCalls } = await createRendererHarness()
  const initialViewport = viewportCalls.at(-1)
  const initialCatLeft = elements.cat.style.left
  const initialCatBottom = elements.cat.style.bottom

  await dispatch(elements.pet, 'contextmenu', {
    clientX: 24,
    clientY: 30,
    preventDefault() {}
  })

  assert.equal(contextMenuRequests.length, 1)
  assert.equal(contextMenuRequests[0].x, 24)
  assert.equal(contextMenuRequests[0].y, 30)
  assert.deepEqual(viewportCalls.at(-1), initialViewport)
  assert.equal(elements.cat.style.left, initialCatLeft)
  assert.equal(elements.cat.style.bottom, initialCatBottom)
})

test('pet viewport reserves top chrome space for the speech bubble', async () => {
  const { elements, viewportCalls } = await createRendererHarness()
  const initialViewport = viewportCalls.at(-1)

  assert.equal(initialViewport.topInset, 64)
  assert.equal(elements.cat.style.bottom, '4px')
})

test('menu blur leaves the current action viewport intact', async () => {
  const { callbacks, elements, viewportCalls } = await createRendererHarness()
  const initialViewport = viewportCalls.at(-1)
  const initialCatLeft = elements.cat.style.left
  const initialCatBottom = elements.cat.style.bottom

  await dispatch(elements.pet, 'contextmenu', {
    clientX: 14,
    clientY: 16,
    preventDefault() {}
  })
  callbacks.blur()

  assert.deepEqual(viewportCalls.at(-1), initialViewport)
  assert.equal(elements.cat.style.left, initialCatLeft)
  assert.equal(elements.cat.style.bottom, initialCatBottom)
})

test('double-click opens the lightweight bubble chat window', async () => {
  const { elements, openBubbleChatRequests } = await createRendererHarness()

  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 2, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 2, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'dblclick', { clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })

  assert.equal(openBubbleChatRequests.length, 1)
})

test('single-click stops an active walk without waiting for the walk timer', async () => {
  const { callbacks, elements, logs } = await createRendererHarness()

  callbacks.menuCommand({ command: 'walk' })
  await Promise.resolve()
  await Promise.resolve()
  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })

  const walkStates = logs
    .filter((entry) => entry.event === 'pet.walk.toggled')
    .map((entry) => entry.details.walking)
  assert.deepEqual(walkStates, [true, false])
})

test('walking keeps mouse handling enabled so the context menu remains reachable', async () => {
  const { callbacks, elements, mousePassthroughCalls } = await createRendererHarness({ insideFrame: false })

  callbacks.menuCommand({ command: 'walk' })
  await Promise.resolve()
  await Promise.resolve()
  await dispatch(elements.pet, 'pointermove', { clientX: 1, clientY: 1, screenX: 1001, screenY: 701 })

  assert.deepEqual(mousePassthroughCalls, [])
})

test('double-click opens the floating bubble chat instead of toggling walk', async () => {
  const { elements, logs, openBubbleChatRequests } = await createRendererHarness()

  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 2, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 2, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'dblclick', { clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })

  assert.equal(openBubbleChatRequests.length, 1)
  assert.equal(logs.some((entry) => entry.event === 'pet.walk.toggled'), false)
})

test('real double-click sequence opens bubble chat without running the single-click action', async () => {
  const { bubbleChatMessages, elements, openBubbleChatRequests } = await createRendererHarness()

  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 2, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 2, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'dblclick', { clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(openBubbleChatRequests.length, 1)
  assert.equal(bubbleChatMessages.some((payload) => payload.text === 'Feed'), false)
})

test('two quick pointer clicks alone do not open bubble chat before a dblclick event arrives', async () => {
  const { elements, openBubbleChatRequests, timers } = await createRendererHarness()

  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 2, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 2, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })

  assert.equal(openBubbleChatRequests.length, 0)
  assert.equal(timers.some((timer) => timer.delay === 220 && !timer.cleared), true)
})

test('single-click does not open bubble chat before the click-action timer fires', async () => {
  const { elements, openBubbleChatRequests, timers } = await createRendererHarness()

  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })

  assert.equal(openBubbleChatRequests.length, 0)
  assert.equal(timers.some((timer) => timer.delay === 220 && !timer.cleared), true)
})

test('single-click still runs the click action after the double-click window expires', async () => {
  const { bubbleChatMessages, elements, timers } = await createRendererHarness()

  await dispatch(elements.pet, 'pointerdown', { button: 0, pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  await dispatch(elements.pet, 'pointerup', { pointerId: 1, clientX: 24, clientY: 30, screenX: 1024, screenY: 768 })
  const clickTimer = timers.find((timer) => timer.delay === 220 && !timer.cleared)
  assert.ok(clickTimer)

  clickTimer.callback()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(bubbleChatMessages.some((payload) => payload.text === 'Feed'), true)
})

const pointer = { button: 0, pointerId: 1, clientX: 24, clientY: 30, screenX: 240, screenY: 320 }

test('pointer release before bounds arrive clicks once and never resurrects the drag', async () => {
  const bounds = Promise.withResolvers()
  const { elements, positions, dragEnds, timers } = await createRendererHarness({ getBounds: () => bounds.promise })
  const down = dispatch(elements.pet, 'pointerdown', pointer)
  assert.equal(elements.pet.classList.contains('dragging'), true)
  await dispatch(elements.pet, 'pointerup', pointer)
  bounds.resolve({ x: 100, y: 200, width: 58, height: 122 })
  await down
  await dispatch(elements.pet, 'pointermove', { ...pointer, screenX: 300 })

  assert.equal(elements.pet.classList.contains('dragging'), false)
  assert.deepEqual(positions, [])
  assert.deepEqual(dragEnds, [])
  assert.equal(timers.filter((timer) => timer.delay === 220 && !timer.cleared).length, 1)
})

test('pointer cancellation and lost capture clean up without ending a drag or clicking', async () => {
  for (const event of ['pointercancel', 'lostpointercapture']) {
    const { elements, positions, dragEnds, timers } = await createRendererHarness()
    await dispatch(elements.pet, 'pointerdown', pointer)
    await dispatch(elements.pet, 'pointermove', { ...pointer, screenX: 250 })
    await dispatch(elements.pet, event, pointer)
    await dispatch(elements.pet, 'pointermove', { ...pointer, screenX: 280 })
    await dispatch(elements.pet, 'pointerup', pointer)

    assert.equal(elements.pet.classList.contains('dragging'), false)
    assert.deepEqual(positions, [{ x: 10, y: 0 }])
    assert.deepEqual(dragEnds, [])
    assert.equal(timers.some((timer) => timer.delay === 220), false)
  }
})

test('a drag uses the latest pointer position when its bounds reply arrives', async () => {
  const bounds = Promise.withResolvers()
  const { elements, positions, dragEnds } = await createRendererHarness({ getBounds: () => bounds.promise })
  const down = dispatch(elements.pet, 'pointerdown', pointer)
  await dispatch(elements.pet, 'pointermove', { ...pointer, screenX: 250 })
  await dispatch(elements.pet, 'pointermove', { ...pointer, screenX: 260 })
  assert.deepEqual(positions, [])
  bounds.resolve({ x: 100, y: 200, width: 58, height: 122 })
  await down
  await dispatch(elements.pet, 'pointerup', pointer)

  assert.deepEqual(positions, [{ x: 120, y: 200 }])
  assert.deepEqual(dragEnds, [true])
})

test('an action aborts a walk whose movement-state reply has not arrived', async () => {
  const movement = Promise.withResolvers()
  const { callbacks, timers, bubbleChatMessages, elements } = await createRendererHarness({ getMovementState: () => movement.promise })
  callbacks.menuCommand({ command: 'walk' })
  callbacks.action({ actionId: 'feed' })
  movement.resolve({ atLeft: true })
  await new Promise(setImmediate)

  assert.equal(timers.some((timer) => timer.delay === 15000), false)
  assert.deepEqual(bubbleChatMessages, [])
  assert.equal(elements.cat.style.backgroundImage, 'url(feed.png)')
})

test('old move replies and duration callbacks do not affect a restarted walk', async () => {
  const staleMove = Promise.withResolvers()
  const { callbacks, intervals, timers, bubbleChatMessages, elements } = await createRendererHarness({
    getMovementState: async () => ({ atLeft: true }),
    moveBy: () => staleMove.promise
  })
  callbacks.menuCommand({ command: 'walk' })
  await new Promise(setImmediate)
  const staleEnd = timers.find((timer) => timer.delay === 15000)
  assert.ok(staleEnd)
  const move = intervals[0]()
  callbacks.menuCommand({ command: 'walk' })
  callbacks.menuCommand({ command: 'walk' })
  await new Promise(setImmediate)
  staleMove.resolve({ hitX: true })
  await move
  staleEnd.callback()

  assert.equal(elements.cat.style.values['--cat-direction'], '-1')
  assert.deepEqual(bubbleChatMessages.map(({ text }) => text), ['出发', '休息一下', '出发'])
  assert.equal(timers.filter((timer) => timer.delay === 15000 && !timer.cleared).length, 1)
})

test('stationary pointer hit testing follows new frames and the stopped pet faces the mirrored hitbox', async () => {
  const { callbacks, elements, mousePassthroughCalls, timers } = await createRendererHarness({
    idleFrames: [{ trim: { x: 10, y: 10, width: 10, height: 80 } }, { trim: { x: 80, y: 10, width: 10, height: 80 } }],
    getMovementState: async () => ({ atLeft: true })
  })
  await dispatch(elements.pet, 'pointermove', { ...pointer, clientX: 46, clientY: 90 })
  assert.equal(mousePassthroughCalls.at(-1), true)
  timers.find((timer) => timer.delay === 100).callback()
  assert.equal(mousePassthroughCalls.at(-1), false)

  callbacks.menuCommand({ command: 'walk' })
  await new Promise(setImmediate)
  callbacks.menuCommand({ command: 'walk' })
  assert.equal(elements.cat.style.values['--cat-direction'], '-1')
  assert.equal(mousePassthroughCalls.at(-1), false)
  await dispatch(elements.pet, 'pointermove', { ...pointer, clientX: 11, clientY: 90 })
  assert.equal(mousePassthroughCalls.at(-1), true)
})

test('pointer leave and blur are safe with the production pet HTML', async () => {
  const { callbacks, elements } = await createRendererHarness()
  assert.equal(elements.menu, undefined)
  await dispatch(elements.pet, 'pointerleave', pointer)
  assert.doesNotThrow(() => callbacks.blur())
})
