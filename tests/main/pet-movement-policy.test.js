const test = require('node:test')
const assert = require('node:assert/strict')

const { createPetMovementPolicy } = require('../../apps/desktop/src/pet/pet-movement-policy')

const createFakeScreen = ({ workArea = { x: 0, y: 0, width: 1440, height: 900, id: 1 } } = {}) => {
  const normalizedDisplay = {
    id: workArea.id ?? 1,
    workArea: {
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height
    }
  }

  return {
    getDisplayMatching: () => normalizedDisplay,
    getDisplayNearestPoint: () => normalizedDisplay,
    getPrimaryDisplay: () => normalizedDisplay
  }
}

const createPetBehaviorSettings = (overrides = {}) => ({
  grounded: false,
  home: {
    enabled: false,
    radius: 'medium',
    anchor: null
  },
  ...overrides,
  home: {
    enabled: false,
    radius: 'medium',
    anchor: null,
    ...(overrides.home || {})
  }
})

test('grounded policy clamps the pet landing point to the display ground line', () => {
  const policy = createPetMovementPolicy({
    screen: createFakeScreen({
      workArea: { x: 0, y: 0, width: 1440, height: 900, id: 1 }
    })
  })

  const windowBounds = { x: 100, y: 100, width: 300, height: 300 }
  const settings = createPetBehaviorSettings({ grounded: true })
  const drag = policy.clampDragPosition({
    windowBounds,
    requestedTopLeft: { x: 240, y: 120 },
    settings
  })
  const walk = policy.clampMoveBy({ windowBounds, delta: { x: 20, y: 0 }, settings })
  const normalized = policy.normalizeWindowForDisplay({ windowBounds, settings })

  for (const result of [drag, walk, normalized]) {
    assert.equal(result.y, 900 - 300 - policy.getGroundInset())
    assert.equal(result.landingY, 900 - policy.getGroundInset())
  }
})

test('free-mode walking keeps the height of a pet dragged near the work-area bottom', () => {
  const policy = createPetMovementPolicy({
    screen: createFakeScreen({ workArea: { x: 0, y: 0, width: 1200, height: 800 } })
  })
  const windowBounds = { x: 100, y: 100, width: 100, height: 100 }
  const settings = createPetBehaviorSettings()
  const drag = policy.clampDragPosition({ windowBounds, requestedTopLeft: { x: 100, y: 680 }, settings })

  const walk = policy.clampMoveBy({
    windowBounds: { ...windowBounds, x: drag.x, y: drag.y },
    delta: { x: 20, y: 0 },
    settings
  })

  assert.equal(walk.x, 120)
  assert.equal(walk.y, 680)
  assert.equal(walk.hitY, false)
})

test('free-mode drag, movement, and display normalization use the same work-area edges', () => {
  const policy = createPetMovementPolicy({
    screen: createFakeScreen({ workArea: { x: 0, y: -120, width: 1200, height: 800 } })
  })
  const windowBounds = { x: 100, y: 100, width: 100, height: 100 }
  const settings = createPetBehaviorSettings()

  for (const [requestedY, expectedY] of [[-150, -120], [-120, -120], [580, 580], [610, 580]]) {
    const drag = policy.clampDragPosition({ windowBounds, requestedTopLeft: { x: 100, y: requestedY }, settings })
    const move = policy.clampMoveBy({ windowBounds, delta: { x: 0, y: requestedY - windowBounds.y }, settings })
    const normalized = policy.normalizeWindowForDisplay({ windowBounds: { ...windowBounds, y: requestedY }, settings })

    assert.deepEqual([drag.y, move.y, normalized.y], [expectedY, expectedY, expectedY], `requested y=${requestedY}`)
    assert.equal(drag.hitY, requestedY !== expectedY)
    assert.equal(move.hitY, requestedY !== expectedY)
  }
})

test('home policy clamps horizontal landing positions to the configured radius', () => {
  const policy = createPetMovementPolicy({
    screen: createFakeScreen({
      workArea: { x: 0, y: 0, width: 1440, height: 900, id: 1 }
    })
  })

  const result = policy.clampMoveBy({
    windowBounds: { x: 900, y: 560, width: 300, height: 300 },
    delta: { x: 80, y: 0 },
    settings: createPetBehaviorSettings({
      grounded: true,
      home: {
        enabled: true,
        radius: 'small',
        anchor: { displayId: '1', x: 1000, y: 860 }
      }
    })
  })

  assert.equal(result.hitX, true)
  assert.equal(result.landingX <= policy.getAllowedRange('small', 1000).max, true)
})

test('drag end returns a persisted home anchor when home is enabled', () => {
  const policy = createPetMovementPolicy({
    screen: createFakeScreen({
      workArea: { x: 0, y: 0, width: 1440, height: 900, id: 1 }
    })
  })

  const result = policy.createHomeAnchorFromWindow({
    windowBounds: { x: 880, y: 560, width: 300, height: 300 }
  })

  assert.deepEqual(result, { displayId: '1', x: 1030, y: 860 })
})

test('display recovery clamps stale home anchors back into the current work area', () => {
  const policy = createPetMovementPolicy({
    screen: createFakeScreen({
      workArea: { x: 0, y: 0, width: 1280, height: 800, id: 1 }
    })
  })

  const next = policy.normalizeAnchorForDisplay({
    anchor: { displayId: '1', x: 2000, y: 1200 },
    display: { id: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } }
  })

  assert.equal(next.x <= 1130, true)
  assert.equal(next.y, 760)
})
