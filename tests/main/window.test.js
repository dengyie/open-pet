const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const Module = require('module')
const { createPetMovementPolicy } = require('../../apps/desktop/src/pet/pet-movement-policy')

const projectRoot = path.join(__dirname, '..', '..')
const petIndexPath = path.join(projectRoot, 'apps', 'desktop', 'index.html')
const windowModulePath = require.resolve('../../apps/desktop/src/windows/window')

const createScreenStub = () => ({
  getPrimaryDisplay: () => ({
    workArea: { x: 0, y: 0, width: 1440, height: 900 }
  }),
  getDisplayMatching: () => ({
    workArea: { x: 0, y: 0, width: 1440, height: 900 }
  })
})

const createBrowserWindowStub = (instances) => class BrowserWindowStub {
  constructor(options) {
    this.options = options
    this.loadedFiles = []
    this.visibleOnAllWorkspaces = null
    this.position = null
    this.destroyed = false
    this.minimized = false
    this.visible = true
    this.focusCalls = 0
    this.moveTopCalls = 0
    this.restoreCalls = 0
    this.showCalls = 0
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height }
    instances.push(this)
  }

  setPosition(x, y) {
    this.position = { x, y }
    this.bounds.x = x
    this.bounds.y = y
  }

  setBounds(bounds) {
    this.bounds = { ...this.bounds, ...bounds }
  }

  setVisibleOnAllWorkspaces(value, options) {
    this.visibleOnAllWorkspaces = { value, options }
  }

  loadFile(filePath) {
    this.loadedFiles.push(filePath)
    return Promise.resolve()
  }

  getBounds() {
    return { ...this.bounds }
  }

  getPosition() {
    return [this.bounds.x, this.bounds.y]
  }

  isDestroyed() {
    return this.destroyed
  }

  isMinimized() {
    return this.minimized
  }

  restore() {
    this.restoreCalls += 1
    this.minimized = false
  }

  isVisible() {
    return this.visible
  }

  show() {
    this.showCalls += 1
    this.visible = true
  }

  moveTop() {
    this.moveTopCalls += 1
  }

  focus() {
    this.focusCalls += 1
  }
}

const loadWindowModule = (electronStub = {}) => {
  delete require.cache[windowModulePath]
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    return require(windowModulePath)
  } finally {
    Module._load = originalLoad
  }
}

test('createWindow can defer loading so callers register lifecycle handlers first', () => {
  const instances = []
  const { createWindow, loadPetWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })

  assert.equal(instances.length, 1)
  assert.equal(petWindow.loadedFiles.length, 0)
  loadPetWindow(petWindow)
  assert.deepEqual(petWindow.loadedFiles, [petIndexPath])
})

test('createWindow preserves automatic loading by default', () => {
  const instances = []
  const { createWindow } = loadWindowModule()
  const petWindow = createWindow({
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })

  assert.deepEqual(petWindow.loadedFiles, [petIndexPath])
  assert.equal(petWindow.options.transparent, true)
  assert.equal(petWindow.options.alwaysOnTop, true)
})

const createDualDisplayScreen = () => {
  const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  const secondary = { id: 2, workArea: { x: 1920, y: 24, width: 1280, height: 1000 } }
  const getDisplayNearestPoint = ({ x }) => x >= 1920 ? secondary : primary
  return {
    getPrimaryDisplay: () => primary,
    getAllDisplays: () => [primary, secondary],
    getDisplayNearestPoint,
    getDisplayMatching: ({ x, width }) => getDisplayNearestPoint({ x: x + width / 2 })
  }
}

test('createWindow restores the saved Home landing point on the secondary display for walking', () => {
  const { applyWindowScale, createWindow } = loadWindowModule()
  const screen = createDualDisplayScreen()
  const homeAnchor = { displayId: '2', x: 2550, y: 984 }
  const petWindow = createWindow({ BrowserWindow: createBrowserWindowStub([]), screen, homeAnchor })

  applyWindowScale(petWindow, 1)
  const windowBounds = petWindow.getBounds()
  assert.deepEqual(windowBounds, { x: 2475, y: 834, width: 150, height: 150 })
  assert.equal(screen.getDisplayMatching(windowBounds).id, 2)

  const movement = createPetMovementPolicy({ screen }).clampMoveBy({
    windowBounds,
    delta: { x: 16, y: 0 },
    settings: { grounded: true, home: { enabled: true, anchor: homeAnchor } }
  })
  assert.equal(movement.displayId, '2')
  assert.equal(movement.landingX, 2566)
  assert.equal(movement.landingY, homeAnchor.y)
})

test('createWindow clamps Home from a disconnected display to the nearest available work area', () => {
  const { createWindow } = loadWindowModule()
  const screen = createDualDisplayScreen()
  const petWindow = createWindow({
    BrowserWindow: createBrowserWindowStub([]),
    screen,
    homeAnchor: { displayId: '3', x: 3900, y: 1200 }
  })

  assert.deepEqual(petWindow.getBounds(), { x: 2900, y: 724, width: 300, height: 300 })
})

test('a matching display ID wins over the old Home coordinates after a display is rearranged', () => {
  const { createWindow } = loadWindowModule()
  const screen = createDualDisplayScreen()
  const petWindow = createWindow({
    BrowserWindow: createBrowserWindowStub([]),
    screen,
    homeAnchor: { displayId: '2', x: 700, y: 984 }
  })

  assert.deepEqual(petWindow.getBounds(), { x: 1920, y: 684, width: 300, height: 300 })
})

test('restorePetPlacement returns to the default primary position when Home is disabled', () => {
  const { applyWindowScale, createWindow, restorePetPlacement } = loadWindowModule()
  const petWindow = createWindow({
    BrowserWindow: createBrowserWindowStub([]),
    screen: createDualDisplayScreen(),
    homeAnchor: { displayId: '2', x: 2550, y: 984 }
  })

  restorePetPlacement(petWindow, null)
  assert.deepEqual(petWindow.getBounds(), { x: 1580, y: 700, width: 300, height: 300 })
  applyWindowScale(petWindow, 1)
  assert.deepEqual(petWindow.getBounds(), { x: 1655, y: 850, width: 150, height: 150 })
})

test('createSettingsWindow uses normal app stacking instead of pet-level always-on-top', () => {
  const instances = []
  const { createSettingsWindow, createWindow } = loadWindowModule()
  const BrowserWindow = createBrowserWindowStub(instances)
  const screen = createScreenStub()
  const petWindow = createWindow({
    load: false,
    BrowserWindow,
    screen
  })

  const settingsWindow = createSettingsWindow(petWindow, { BrowserWindow, screen })

  assert.equal(instances.length, 2)
  assert.equal(settingsWindow, instances[1])
  assert.equal(instances[0].options.alwaysOnTop, true)
  assert.equal(instances[0].visibleOnAllWorkspaces.value, true)
  assert.equal(instances[1].options.alwaysOnTop, false)
  assert.equal(instances[1].visibleOnAllWorkspaces, null)
})

test('createSettingsWindow restores and raises an existing settings window', () => {
  const instances = []
  const appFocusCalls = []
  const { createSettingsWindow, createWindow } = loadWindowModule()
  const BrowserWindow = createBrowserWindowStub(instances)
  const screen = createScreenStub()
  const app = { focus: (options) => appFocusCalls.push(options) }
  const petWindow = createWindow({
    load: false,
    BrowserWindow,
    screen
  })

  const firstSettingsWindow = createSettingsWindow(petWindow, { BrowserWindow, screen, app })
  const settingsWindow = instances[1]
  settingsWindow.minimized = true
  settingsWindow.visible = false

  const reusedSettingsWindow = createSettingsWindow(petWindow, { BrowserWindow, screen, app })

  assert.equal(instances.length, 2)
  assert.equal(firstSettingsWindow, settingsWindow)
  assert.equal(reusedSettingsWindow, settingsWindow)
  assert.equal(settingsWindow.restoreCalls, 1)
  assert.equal(settingsWindow.showCalls, 1)
  assert.equal(settingsWindow.moveTopCalls, 1)
  assert.equal(settingsWindow.focusCalls, 1)
  assert.deepEqual(appFocusCalls, [{ steal: true }])
})

test('applyWindowScale recovers a collapsed pet window back to valid default bounds', () => {
  const instances = []
  const { BASE_HEIGHT, BASE_WIDTH, PET_BASE_SCALE, applyWindowScale, createWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })
  petWindow.setBounds({ x: 40, y: 33, width: 0, height: 0 })

  applyWindowScale(petWindow, 1)

  assert.deepEqual(petWindow.getBounds(), {
    x: 40,
    y: 33,
    width: BASE_WIDTH * PET_BASE_SCALE,
    height: BASE_HEIGHT * PET_BASE_SCALE
  })
})

test('applyWindowScale uses the reduced visual base size for user scale values', () => {
  const instances = []
  const { BASE_HEIGHT, BASE_WIDTH, applyWindowScale, createWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })
  petWindow.setBounds({ x: 100, y: 200, width: BASE_WIDTH, height: BASE_HEIGHT })

  applyWindowScale(petWindow, 0.5)

  assert.deepEqual(petWindow.getBounds(), {
    x: 213,
    y: 425,
    width: 75,
    height: 75
  })
})

test('applyWindowScale commits no negative coordinates when growing at the work area origin', () => {
  const { applyWindowScale, createWindow } = loadWindowModule()
  const petWindow = createWindow({ BrowserWindow: createBrowserWindowStub([]), screen: createScreenStub() })
  petWindow.setBounds({ x: 0, y: 0, width: 150, height: 150 })
  const commits = []
  petWindow.setContentBounds = (bounds) => {
    commits.push(bounds)
    petWindow.setBounds(bounds)
  }

  applyWindowScale(petWindow, 1.2)
  applyWindowScale(petWindow, 1)

  assert.deepEqual(commits, [
    { x: 0, y: 0, width: 180, height: 180 },
    { x: 0, y: 0, width: 150, height: 150 }
  ])
})

test('applyPetViewport fits oversized bounds inside the current secondary work area', () => {
  const { applyPetViewport, createWindow } = loadWindowModule()
  const petWindow = createWindow({ BrowserWindow: createBrowserWindowStub([]), screen: createDualDisplayScreen() })
  petWindow.setBounds({ x: 1920, y: 24, width: 150, height: 150 })

  applyPetViewport(petWindow, { width: 1600, height: 1100, scale: 1, topInset: 64 })

  assert.deepEqual(petWindow.getBounds(), { x: 1920, y: 24, width: 1280, height: 1000 })
})

test('applyPetViewport resizes around bottom center for dynamic action bounds', () => {
  const instances = []
  const { applyPetViewport, createWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })
  petWindow.setBounds({ x: 100, y: 200, width: 300, height: 300 })

  applyPetViewport(petWindow, { width: 120, height: 180, scale: 1.5 })

  assert.deepEqual(petWindow.getBounds(), {
    x: 160,
    y: 230,
    width: 180,
    height: 270
  })
})

test('applyWindowScale preserves a pet sprite viewport when committing the preview scale', () => {
  const instances = []
  const { applyPetViewport, applyWindowScale, createWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })
  applyPetViewport(petWindow, { width: 100, height: 160, padding: 8, topInset: 64, scale: 0.4 })
  const previewBounds = petWindow.getBounds()

  applyWindowScale(petWindow, 0.8)
  assert.deepEqual(petWindow.getBounds(), previewBounds)
  applyWindowScale(petWindow, 1)
  assert.equal(petWindow.getBounds().width, 58)
  assert.equal(petWindow.getBounds().height, 152)
  assert.equal(petWindow.getBounds().y + 152, previewBounds.y + previewBounds.height)
})

test('applyPetViewport can shrink dynamic action bounds below their source size', () => {
  const instances = []
  const { applyPetViewport, createWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })
  petWindow.setBounds({ x: 100, y: 200, width: 300, height: 300 })

  applyPetViewport(petWindow, { width: 120, height: 180, scale: 0.5 })

  assert.deepEqual(petWindow.getBounds(), {
    x: 220,
    y: 410,
    width: 60,
    height: 90
  })
})

test('applyPetViewport expands upward for renderer chrome above the pet viewport', () => {
  const instances = []
  const { applyPetViewport, createWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })
  petWindow.setBounds({ x: 100, y: 200, width: 300, height: 300 })

  applyPetViewport(petWindow, { width: 120, height: 180, scale: 1, topInset: 64 })

  assert.deepEqual(petWindow.getBounds(), {
    x: 190,
    y: 256,
    width: 120,
    height: 244
  })
})

test('applyPetViewport preserves the same horizontal anchor across repeated odd-pixel resizes', () => {
  const instances = []
  const { applyPetViewport, createWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })
  petWindow.setBounds({ x: 100, y: 200, width: 150, height: 150 })
  const initialCenter = petWindow.getBounds().x + petWindow.getBounds().width / 2

  for (const width of [151, 150, 151, 150, 151, 150, 151, 150]) {
    applyPetViewport(petWindow, { width, height: 150, scale: 1 })
  }

  const bounds = petWindow.getBounds()
  assert.equal(bounds.x + bounds.width / 2, initialCenter)
})

test('applyPetViewport keeps the left edge stable for adjacent odd-even preview widths', () => {
  const instances = []
  const { applyPetViewport, createWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })
  petWindow.setBounds({ x: 100, y: 200, width: 150, height: 150 })

  for (const width of [151, 150, 151, 150]) {
    applyPetViewport(petWindow, { width, height: 150, scale: 1 })
    assert.equal(petWindow.getBounds().x, 100)
  }
})

test('applyPetViewport preserves the same bottom anchor across repeated odd-pixel resizes', () => {
  const instances = []
  const { applyPetViewport, createWindow } = loadWindowModule()
  const petWindow = createWindow({
    load: false,
    BrowserWindow: createBrowserWindowStub(instances),
    screen: createScreenStub()
  })
  petWindow.setBounds({ x: 100, y: 200, width: 150, height: 150 })
  const initialBottom = petWindow.getBounds().y + petWindow.getBounds().height

  for (const height of [151, 150, 151, 150, 151, 150, 151, 150]) {
    applyPetViewport(petWindow, { width: 150, height, scale: 1 })
  }

  const bounds = petWindow.getBounds()
  assert.equal(bounds.y + bounds.height, initialBottom)
})
