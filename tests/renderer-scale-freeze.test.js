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

const createElement = (id = '') => ({
  id,
  style: createStyle(),
  dataset: {},
  textContent: '',
  children: [],
  classList: {
    values: new Set(),
    add(value) { this.values.add(value) },
    remove(value) { this.values.delete(value) },
    contains(value) { return this.values.has(value) }
  },
  appendChild(child) { this.children.push(child) },
  addEventListener() {},
  setPointerCapture() {},
  closest() { return null }
})

const createRendererHarness = async ({ loadSprite } = {}) => {
  const viewportCalls = []
  const elements = createPetRendererElements(createElement)
  let nextTimerId = 1
  const activeTimers = new Map()
  const callbacks = {}
  const logs = []
  const context = {
    console,
    document: {
      documentElement: { style: createStyle() },
      body: { style: createStyle() },
      getElementById: (id) => elements[id] ?? null,
      createElement: () => createElement()
    },
    window: {
      Image: createSpriteImage(loadSprite),
      innerWidth: 300,
      innerHeight: 300,
      OpenPetCursorStyle: { resolvePetCursorStyle: () => '' },
      OpenPetHitbox: {
        getFrameHitbox: () => ({ left: 0, top: 0, right: 1, bottom: 1 }),
        getWindowHitbox: () => ({ left: 0, top: 0, right: 1, bottom: 1 }),
        getViewportHitbox: () => ({ left: 0, top: 0, right: 1, bottom: 1 }),
        isPointInHitbox: () => true
      },
      clearTimeout: (id) => activeTimers.delete(id),
      addEventListener: () => {},
      setInterval: () => 0,
      setTimeout: (_callback, delay) => {
        const id = nextTimerId++
        activeTimers.set(id, delay)
        return id
      },
      petAPI: {
        getAnimations: async () => ({
          defaultAction: 'idle',
          clickAction: 'waving',
          actions: [
            { id: 'idle', label: 'Idle', loop: true, sprite: 'idle.png', frameWidth: 100, frameHeight: 100, frameCount: 4, frameMs: 100 },
            { id: 'waving', label: 'Waving', loop: false, sprite: 'waving.png', frameWidth: 100, frameHeight: 100, frameCount: 4, frameMs: 100 }
          ]
        }),
        setViewport: (viewport) => viewportCalls.push(viewport),
        setMousePassthrough: () => {},
        recordAppLog: (entry) => logs.push(entry),
        onSettingsChanged: (callback) => { callbacks.settings = callback },
        onPetSay: (callback) => { callbacks.say = callback },
        onPetAction: (callback) => { callbacks.action = callback },
        onAnimationsChanged: (callback) => { callbacks.animations = callback },
        getBounds: async () => ({ x: 0, y: 0, width: 300, height: 300 }),
        getMovementState: async () => ({}),
        moveBy: async () => ({}),
        setPosition: () => {},
        quit: () => {},
        openSettings: () => {}
      }
    }
  }
  context.window.document = context.document
  context.globalThis = context
  vm.runInNewContext(rendererSource, context, { filename: 'renderer.js' })
  await Promise.resolve()
  await Promise.resolve()
  return { activeTimers, callbacks, elements, logs, viewportCalls }
}

test('the renderer keeps the previous sprite until a broken action is replaced by the built-in fallback', async () => {
  const loading = new Map()
  const { callbacks, elements, logs } = await createRendererHarness({
    loadSprite: (url, image) => loading.set(url, image)
  })
  loading.get('idle.png').onload()
  callbacks.action({ actionId: 'waving' })
  assert.equal(elements.cat.style.backgroundImage, 'url(idle.png)')
  loading.get('waving.png').onerror()
  assert.equal(elements.cat.style.backgroundImage, 'url(idle.png)')
  const fallback = '../../cat_anime/sprites/bai_no_bg.png'
  loading.get(fallback).onload()
  assert.equal(elements.cat.style.backgroundImage, `url(${fallback})`)
  assert.equal(logs.find((entry) => entry.details?.reason === 'sprite-load-failed')?.details.requestedAction, 'waving')
})

test('a stale sprite error does not replace a newer action', async () => {
  const loading = new Map()
  const { callbacks, elements } = await createRendererHarness({
    loadSprite: (url, image) => loading.set(url, image)
  })
  loading.get('idle.png').onload()
  callbacks.action({ actionId: 'waving' })
  callbacks.action({ actionId: 'idle' })
  loading.get('waving.png').onerror()
  assert.deepEqual([...loading.keys()], ['idle.png', 'waving.png'])
  assert.equal(elements.cat.style.backgroundImage, 'url(idle.png)')
})

test('scale changes freeze the pet on the default action instead of continuing an animation', async () => {
  const { activeTimers, callbacks, elements, logs } = await createRendererHarness()

  callbacks.action({ actionId: 'waving' })
  assert.ok([...activeTimers.values()].includes(100))

  callbacks.settings({ scale: 0.5, scalePreview: true })

  const actionEvents = logs.filter((entry) => entry.event === 'pet.action.changed')
  assert.equal(actionEvents.at(-1).details.nextAction, 'idle')
  assert.equal(elements.cat.style.width, '25px')
  assert.equal(elements.cat.style.height, '25px')
  assert.equal(elements.cat.style.backgroundImage, 'url(idle.png)')
  assert.equal(elements.cat.style.backgroundPositionX, '0px')
  assert.equal(elements.cat.style.backgroundPositionY, '0px')
  assert.equal([...activeTimers.values()].includes(100), false)
})

test('repeated settings with the same scale keep the current action playing', async () => {
  const { activeTimers, callbacks, logs } = await createRendererHarness()

  callbacks.action({ actionId: 'waving' })
  callbacks.settings({ scale: 1 })

  const actionEvents = logs.filter((entry) => entry.event === 'pet.action.changed')
  assert.equal(actionEvents.at(-1).details.nextAction, 'waving')
  assert.equal([...activeTimers.values()].includes(100), true)
})

test('scale preview sends one viewport resize after freezing to the default action', async () => {
  const { callbacks, viewportCalls } = await createRendererHarness()

  callbacks.action({ actionId: 'waving' })
  const callsBeforeScale = viewportCalls.length

  callbacks.settings({ scale: 0.5, scalePreview: true })

  const scaleViewportCalls = viewportCalls.slice(callsBeforeScale)
  assert.equal(scaleViewportCalls.length, 1)
  assert.equal(scaleViewportCalls[0].scale, 0.25)
})

test('saving the already-previewed scale resumes idle without replacing the sprite viewport', async () => {
  const { activeTimers, callbacks, elements, viewportCalls } = await createRendererHarness()
  callbacks.settings({ scale: 0.8, scalePreview: true })
  const count = viewportCalls.length
  assert.equal(activeTimers.size, 0)

  callbacks.settings({ scale: 1, walkSpeed: 3 })
  assert.equal(activeTimers.size, 0)
  assert.equal(elements.cat.style.width, '40px')

  callbacks.settings({ scale: 0.8, walkSpeed: 3 })
  assert.equal(activeTimers.size, 1)
  assert.equal(viewportCalls.length, count)
  assert.equal(viewportCalls.at(-1).scale, 0.4)
})

test('returning to the saved scale cancels preview and resumes idle', async () => {
  const { activeTimers, callbacks, elements, viewportCalls } = await createRendererHarness()
  callbacks.settings({ scale: 0.8, scalePreview: true })
  callbacks.settings({ scale: 1, scalePreview: false })

  assert.equal(activeTimers.size, 1)
  assert.equal(elements.cat.style.width, '50px')
  assert.equal(viewportCalls.at(-1).scale, 0.5)
})

test('a committed scale change outside preview keeps the active animation playing', async () => {
  const { activeTimers, callbacks, elements } = await createRendererHarness()
  callbacks.action({ actionId: 'waving' })
  callbacks.settings({ scale: 0.8 })

  assert.equal(activeTimers.size, 1)
  assert.equal(elements.cat.style.backgroundImage, 'url(waving.png)')
  assert.equal(elements.cat.style.width, '40px')
})
