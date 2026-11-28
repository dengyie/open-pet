const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { crc32 } = require('node:zlib')
const sharp = require('sharp')

const { createActionService } = require('../../apps/desktop/src/services/action-service')
const { createActionImportService } = require('../../apps/desktop/src/services/action-import-service')
const { BUILT_IN_PACK_ID, createPetPackService } = require('../../apps/desktop/src/services/pet-pack-service')
const zipArchiveUtils = require('../../apps/desktop/src/services/zip-archive-utils')
const { createMinimalWebp: createFixtureWebp } = require('../../examples/plugins/creator-studio/lib/fake-hatch-pet')

const createSettingsService = (initialSettings = {}) => {
  let settings = {
    petPacks: {
      activePackId: BUILT_IN_PACK_ID,
      installed: {}
    },
    ...initialSettings
  }
  return {
    get: () => settings,
    save: (nextSettings) => {
      settings = nextSettings
      return settings
    }
  }
}

const createTempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `openpet-${name}-`))

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

const createSpritePng = (width = 32, height = 32, background = 'black') =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()

const createSpriteBmp = (width, height) => {
  const pixelOffset = 54
  const rowStride = Math.ceil(width * 3 / 4) * 4
  const bytes = Buffer.alloc(pixelOffset + rowStride * height)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(pixelOffset, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  return bytes
}

const corruptPngImageData = (bytes) => {
  const type = bytes.indexOf('IDAT')
  const end = type + 4 + bytes.readUInt32BE(type - 4)
  bytes[type + 4] = 0
  bytes.writeUInt32BE(crc32(bytes.subarray(type, end)), end)
  return bytes
}

const FIXTURE_ATLAS_WEBP = Buffer.from(
  'UklGRkIUAABXRUJQVlA4IDYUAACwXwKdASoABlAHPm02mUmkIqKhIAgAgA2JaW7hd2EbQAoMdOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ychvAAP7+Wb/0l0t5H//9ZX//zK//+ZX+8mbIAApNAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  'base64'
)

const TRANSPARENT_FIXTURE_ATLAS_WEBP = Buffer.from([
  'UklGRpgAAABXRUJQVlA4TIsAAAAv/8XTEQcQEREAUKT//ymi/6n//e9///vf//73',
  'v//973//+9///ve///3vf//73//+97///e9///vf//73v//973//+9///ve///3',
  'vf//73//+97///e9///vf//73v//973//+9///ve///3vf//73//+97///e9///',
  'vf//73v//973//+9///q8CAA=='
].join(''), 'base64')

const createPetPackDirectory = async (root, manifest = {}) => {
  fs.mkdirSync(path.join(root, 'sprites'), { recursive: true })
  const actions = manifest.actions || [
    { id: 'idle', label: 'Idle', kind: 'idle', sprite: 'sprites/idle.png', frameCount: 1, frameMs: 100, frameWidth: 32, frameHeight: 32 },
    { id: 'wave', label: 'Wave', kind: 'greeting', sprite: 'sprites/wave.png', frameCount: 1, frameMs: 100, frameWidth: 32, frameHeight: 32 }
  ]
  for (const action of actions) {
    fs.writeFileSync(path.join(root, action.sprite), await createSpritePng(action.frameWidth * action.frameCount, action.frameHeight))
  }
  fs.writeFileSync(path.join(root, 'pet.json'), JSON.stringify({
    schemaVersion: 1,
    id: manifest.id || 'pack-cat',
    displayName: manifest.displayName || 'Pack Cat',
    version: manifest.version || '1.0.0',
    ...(manifest.sourceUrl ? { sourceUrl: manifest.sourceUrl } : {}),
    ...(manifest.assetAuthor ? { assetAuthor: manifest.assetAuthor } : {}),
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(manifest.licenseUrl ? { licenseUrl: manifest.licenseUrl } : {}),
    defaultAction: manifest.defaultAction || actions[0].id,
    clickAction: manifest.clickAction || actions[1]?.id || actions[0].id,
    actions
  }))
}

const createMinimalWebp = ({ width, height }) => {
  if (width === 1536 && height === 1872) return createFixtureWebp()
  const buffer = Buffer.alloc(30)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(22, 4)
  buffer.write('WEBP', 8, 'ascii')
  buffer.write('VP8X', 12, 'ascii')
  buffer.writeUInt32LE(10, 16)
  buffer.writeUInt8(0, 20)
  buffer.writeUIntLE(width - 1, 24, 3)
  buffer.writeUIntLE(height - 1, 27, 3)
  return buffer
}

const createCodexPetDirectory = (root, manifest = {}) => {
  fs.writeFileSync(
    path.join(root, manifest.spritesheetPath || 'spritesheet.webp'),
    manifest.spritesheet || createMinimalWebp({ width: 1536, height: 1872 })
  )
  fs.writeFileSync(path.join(root, 'pet.json'), JSON.stringify({
    id: manifest.id || 'codex-cat',
    displayName: manifest.displayName || 'Codex Cat',
    description: manifest.description || 'A Codex-compatible pet.',
    spritesheetPath: manifest.spritesheetPath || 'spritesheet.webp'
  }))
}

const createZipFromDirectory = (sourceDir, zipName = 'pet.codex-pet.zip') => {
  const zipRoot = createTempDir('pet-pack-zip')
  const zipPath = path.join(zipRoot, zipName)
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceDir })
  return zipPath
}

const createUnsafeZip = () => {
  const sourceRoot = createTempDir('pet-pack-unsafe-src')
  const nested = path.join(sourceRoot, 'nested')
  fs.mkdirSync(nested)
  fs.writeFileSync(path.join(sourceRoot, 'evil.txt'), 'evil')
  const zipPath = path.join(sourceRoot, 'unsafe.codex-pet.zip')
  execFileSync('zip', ['-q', zipPath, '../evil.txt'], { cwd: nested })
  return zipPath
}

const createService = (settingsService = createSettingsService()) => createPetPackService({
  settingsService,
  userPacksDir: createTempDir('pet-packs'),
  projectRoot: '/app/openpet',
  loadLegacyAnimations: () => ({
    defaultAction: 'bai_no_bg',
    clickAction: 'eat_no_bg',
    actions: [
      { id: 'bai_no_bg', label: '待机', loop: true, frameCount: 16, frameMs: 95, frameWidth: 191, frameHeight: 453, sprite: 'cat_anime/sprites/bai_no_bg.png' },
      { id: 'eat_no_bg', label: '喂食', loop: false, frameCount: 16, frameMs: 85, frameWidth: 381, frameHeight: 253, sprite: 'cat_anime/sprites/eat_no_bg.png' }
    ]
  }),
  now: () => new Date('2026-06-12T00:00:00.000Z')
})

const createServiceWithBundledPacks = ({ settingsService = createSettingsService(), bundledPacksDir, getPetPackBlockStatus }) => createPetPackService({
  settingsService,
  userPacksDir: createTempDir('pet-packs'),
  projectRoot: '/app/openpet',
  bundledPacksDir,
  loadLegacyAnimations: () => ({
    defaultAction: 'bai_no_bg',
    clickAction: 'eat_no_bg',
    actions: [
      { id: 'bai_no_bg', label: '待机', loop: true, frameCount: 16, frameMs: 95, frameWidth: 191, frameHeight: 453, sprite: 'cat_anime/sprites/bai_no_bg.png' },
      { id: 'eat_no_bg', label: '喂食', loop: false, frameCount: 16, frameMs: 85, frameWidth: 381, frameHeight: 253, sprite: 'cat_anime/sprites/eat_no_bg.png' }
    ]
  }),
  now: () => new Date('2026-06-12T00:00:00.000Z'),
  getPetPackBlockStatus
})

test('pet pack service lists the built-in legacy pack and bundled choices', () => {
  const service = createService()

  const result = service.listPacks()
  const packs = new Map(result.packs.map((pack) => [pack.id, pack]))

  assert.equal(result.activePackId, BUILT_IN_PACK_ID)
  assert.equal(result.packs.length, 4)
  assert.equal(packs.get(BUILT_IN_PACK_ID).source, 'built-in')
  assert.equal(packs.get(BUILT_IN_PACK_ID).active, true)
  assert.equal(packs.get(BUILT_IN_PACK_ID).actionCount, 2)
  assert.equal(packs.get('doro').source, 'built-in')
  assert.equal(packs.get('duodong').source, 'built-in')
  assert.equal(packs.get('chispa').source, 'built-in')
  assert.equal(packs.get('doro').previewAction.atlas.columns, 8)
})

test('pet pack service lists bundled pet packs as built-in choices', () => {
  const bundledPacksDir = createTempDir('bundled-pet-packs')
  const doroDir = path.join(bundledPacksDir, 'doro')
  const duodongDir = path.join(bundledPacksDir, 'duodong')
  fs.mkdirSync(doroDir)
  fs.mkdirSync(duodongDir)
  createCodexPetDirectory(doroDir, { id: 'doro', displayName: 'Doro' })
  createCodexPetDirectory(duodongDir, { id: 'duodong', displayName: '多栋' })
  const service = createServiceWithBundledPacks({ bundledPacksDir })

  const result = service.listPacks()
  const packs = new Map(result.packs.map((pack) => [pack.id, pack]))

  assert.equal(result.activePackId, BUILT_IN_PACK_ID)
  assert.equal(packs.get(BUILT_IN_PACK_ID).source, 'built-in')
  assert.equal(packs.get('doro').source, 'built-in')
  assert.equal(packs.get('duodong').source, 'built-in')
  assert.equal(packs.get('doro').actionCount, 9)
  assert.match(packs.get('doro').previewSprite, /doro\/spritesheet\.webp$/)
})

test('pet pack service activates bundled pet packs without installing them', async () => {
  const bundledPacksDir = createTempDir('bundled-pet-pack-active')
  const doroDir = path.join(bundledPacksDir, 'doro')
  fs.mkdirSync(doroDir)
  createCodexPetDirectory(doroDir, { id: 'doro', displayName: 'Doro' })
  const settingsService = createSettingsService()
  const service = createServiceWithBundledPacks({ settingsService, bundledPacksDir })
  const actionService = createActionService({ petPackService: service })

  const result = await service.setActivePack('doro')
  actionService.reload()

  assert.equal(result.activePackId, 'doro')
  assert.equal(settingsService.get().petPacks.activePackId, 'doro')
  assert.equal(settingsService.get().petPacks.installed.doro, undefined)
  assert.equal(actionService.getPetPack().manifest.id, 'doro')
  assert.equal(actionService.getConfig().actions.length, 9)
})

test('pet pack service reads the selected pack ID from settings without opening pet assets', (t) => {
  const bundledPacksDir = createTempDir('bundled-pet-pack-id')
  const settingsService = createSettingsService()
  const service = createServiceWithBundledPacks({ settingsService, bundledPacksDir })
  t.mock.method(fs, 'readdirSync', () => assert.fail('ID lookups must not enumerate pack files'))
  t.mock.method(fs, 'readFileSync', () => assert.fail('ID lookups must not read pet assets'))

  assert.equal(service.getActivePackId(), BUILT_IN_PACK_ID)
  settingsService.save({ petPacks: { activePackId: 'doro', installed: {} } })
  assert.equal(service.getActivePackId(), 'doro')
  assert.equal(service.getActivePackId(), 'doro')
})

test('pet pack service falls back to built-in when active installed Codex atlas is transparent', () => {
  const userPacksDir = createTempDir('pet-packs-transparent-active')
  const badPackDir = path.join(userPacksDir, 'transparent-pet')
  fs.mkdirSync(badPackDir)
  createCodexPetDirectory(badPackDir, {
    id: 'transparent-pet',
    displayName: 'Transparent Pet',
    spritesheet: TRANSPARENT_FIXTURE_ATLAS_WEBP
  })
  const settingsService = createSettingsService({
    petPacks: {
      activePackId: 'transparent-pet',
      installed: {
        'transparent-pet': {
          id: 'transparent-pet',
          displayName: 'Transparent Pet',
          version: '1.0.0',
          installedAt: '2026-06-12T00:00:00.000Z'
        }
      }
    }
  })
  const service = createPetPackService({
    settingsService,
    userPacksDir,
    projectRoot: '/app/openpet',
    loadLegacyAnimations: () => ({
      defaultAction: 'bai_no_bg',
      clickAction: 'eat_no_bg',
      actions: [
        { id: 'bai_no_bg', label: '待机', loop: true, frameCount: 16, frameMs: 95, frameWidth: 191, frameHeight: 453, sprite: 'cat_anime/sprites/bai_no_bg.png' },
        { id: 'eat_no_bg', label: '喂食', loop: false, frameCount: 16, frameMs: 85, frameWidth: 381, frameHeight: 253, sprite: 'cat_anime/sprites/eat_no_bg.png' }
      ]
    })
  })

  const pack = service.getActivePetPack()

  assert.equal(pack.manifest.id, BUILT_IN_PACK_ID)
  assert.equal(settingsService.get().petPacks.activePackId, BUILT_IN_PACK_ID)
})

test('pet pack service blocks bundled pet packs denied by content hash policy', async () => {
  const bundledPacksDir = createTempDir('bundled-pet-pack-policy')
  const doroDir = path.join(bundledPacksDir, 'doro')
  fs.mkdirSync(doroDir)
  createCodexPetDirectory(doroDir, { id: 'doro', displayName: 'Doro' })
  const service = createServiceWithBundledPacks({
    bundledPacksDir,
    getPetPackBlockStatus: ({ packageHash }) => packageHash
      ? { blocked: true, reasons: ['sha256:bundled-doro'] }
      : { blocked: false, reasons: [] }
  })

  await assert.rejects(() => service.setActivePack('doro'), /blocked/)
})

test('pet pack service protects bundled pet packs from removal', () => {
  const bundledPacksDir = createTempDir('bundled-pet-pack-remove')
  const chispaDir = path.join(bundledPacksDir, 'chispa')
  fs.mkdirSync(chispaDir)
  createCodexPetDirectory(chispaDir, { id: 'chispa', displayName: 'Chispa' })
  const service = createServiceWithBundledPacks({ bundledPacksDir })

  assert.throws(() => service.removePack('chispa'), /built-in/)
})

test('pet pack service reserves bundled and legacy IDs at inspection and import', async () => {
  const service = createService()
  const root = createTempDir('reserved-pack-id')
  for (const id of ['chispa', BUILT_IN_PACK_ID]) {
    await createPetPackDirectory(root, { id })
    assert.match((await service.inspectPackDirectory(root)).errors[0], /reserved for a built-in pack/)
    const zip = createZipFromDirectory(root)
    assert.match((await service.inspectPackSource(zip)).errors[0], /reserved for a built-in pack/)
  }
  await createPetPackDirectory(root)
  const inspection = await service.inspectPackDirectory(root)
  assert.equal(inspection.valid, true)
  await createPetPackDirectory(root, { id: 'chispa' })
  await assert.rejects(() => service.importPack(inspection.selectionId), /reserved for a built-in pack/)
})

test('pet pack service can remove only the installed copy of an active bundled ID', async () => {
  const userPacksDir = createTempDir('conflicting-user-pack')
  const installedRoot = path.join(userPacksDir, 'chispa')
  await createPetPackDirectory(installedRoot, { id: 'chispa', displayName: 'Custom Chispa' })
  const settingsService = createSettingsService({
    petPacks: { activePackId: 'chispa', installed: { chispa: { displayName: 'Custom Chispa' } } }
  })
  const service = createPetPackService({ settingsService, userPacksDir })
  const [bundled, installed] = service.listPacks().packs.filter((pack) => pack.id === 'chispa')
  assert.equal(bundled.source, 'built-in')
  assert.equal(bundled.active, true)
  assert.equal(installed.source, 'user-installed')
  assert.equal(installed.active, false)
  assert.equal(installed.valid, false)
  assert.match(installed.error, /conflicts with the built-in/)
  assert.equal((await service.setActivePack('chispa')).pack.source, 'built-in')
  const manifestPath = path.join(bundled.rootPath, 'pet.json')
  const bundledHash = sha256(manifestPath)
  assert.equal(service.removePack('chispa').petPacks.activePackId, 'chispa')
  assert.equal(fs.existsSync(installedRoot), false)
  assert.equal(sha256(manifestPath), bundledHash)
  assert.deepEqual(service.listPacks().packs.filter((pack) => pack.id === 'chispa'), [bundled])
  assert.throws(() => service.removePack('chispa'), /built-in/)
})

test('pet pack service rejects truncated sprites during inspection, import and activation', async () => {
  const service = createService()
  const source = createTempDir('truncated-sprite')
  await createPetPackDirectory(source)
  const sprite = path.join(source, 'sprites', 'idle.png')
  const complete = fs.readFileSync(sprite)
  const truncated = complete.subarray(0, -12)
  fs.writeFileSync(sprite, truncated)
  assert.match((await service.inspectPackSource(source)).errors[0], /could not be decoded: sprites\/idle\.png/)
  assert.match((await service.inspectPackSource(createZipFromDirectory(source))).errors[0], /could not be decoded/)
  fs.writeFileSync(sprite, complete)
  const inspection = await service.inspectPackDirectory(source)
  assert.equal(inspection.valid, true)
  fs.writeFileSync(sprite, truncated)
  await assert.rejects(() => service.importPack(inspection.selectionId), /could not be decoded/)
  fs.writeFileSync(sprite, complete)
  const { pack } = await service.importPack(inspection.selectionId)
  const installedSprite = path.join(pack.rootPath, 'sprites', 'idle.png')
  await service.setActivePack(pack.id)
  fs.writeFileSync(installedSprite, truncated)
  await assert.rejects(() => service.setActivePack(pack.id), /could not be decoded/)
  assert.equal(service.getActivePetPack().manifest.id, BUILT_IN_PACK_ID)
  assert.equal(service.listPacks().packs.find(({ id }) => id === pack.id).valid, false)
})

test('pet pack service checks actual and declared sprite dimensions', async () => {
  const service = createService()
  const source = createTempDir('wrong-sprite-dimensions')
  await createPetPackDirectory(source)
  const sprite = path.join(source, 'sprites', 'idle.png')
  fs.writeFileSync(sprite, await createSpritePng(64, 32))
  assert.match((await service.inspectPackDirectory(source)).errors[0], /dimensions.*64x32, expected 32x32/)
  fs.writeFileSync(sprite, corruptPngImageData(fs.readFileSync(sprite)))
  assert.match((await service.inspectPackDirectory(source)).errors[0], /dimensions.*64x32, expected 32x32/)
})

test('pet pack service accepts BMP sprites and rejects wrong dimensions and truncated pixel data', async () => {
  const service = createService()
  const root = createTempDir('bitmap-sprite')
  await createPetPackDirectory(root)
  const manifestPath = path.join(root, 'pet.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath))
  manifest.actions[0].sprite = 'sprites/idle.bmp'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  const sprite = path.join(root, 'sprites', 'idle.bmp')
  fs.writeFileSync(sprite, createSpriteBmp(31, 32))
  assert.match((await service.inspectPackDirectory(root)).errors[0], /dimensions.*31x32, expected 32x32/)
  const complete = createSpriteBmp(32, 32)
  fs.writeFileSync(sprite, complete)
  const inspection = await service.inspectPackDirectory(root)
  assert.equal(inspection.valid, true)
  const { pack } = await service.importPack(inspection.selectionId)
  assert.equal((await service.setActivePack(pack.id)).activePackId, pack.id)
  const truncated = complete.subarray(0, -1)
  truncated.writeUInt32LE(truncated.length, 2)
  fs.writeFileSync(path.join(pack.rootPath, 'sprites', 'idle.bmp'), truncated)
  await assert.rejects(() => service.setActivePack(pack.id), /Incomplete BMP pixel data/)
})

test('pet pack service checks run-length encoded BMP termination', async () => {
  const service = createService()
  const root = createTempDir('rle-bitmap-sprite')
  await createPetPackDirectory(root)
  const sprite = path.join(root, 'sprites', 'idle.png')
  const header = createSpriteBmp(32, 32).subarray(0, 54)
  const pixelOffset = 62
  const rows = Buffer.alloc(32 * 4)
  for (let offset = 0; offset < rows.length; offset += 4) rows[offset] = 32
  const bytes = Buffer.concat([header, Buffer.alloc(8), rows, Buffer.from([0, 1])])
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(pixelOffset, 10)
  bytes.writeUInt16LE(8, 28)
  bytes.writeUInt32LE(1, 30)
  bytes.writeUInt32LE(2, 46)
  fs.writeFileSync(sprite, bytes)
  assert.equal((await service.inspectPackDirectory(root)).valid, true)
  const truncated = bytes.subarray(0, -2)
  truncated.writeUInt32LE(truncated.length, 2)
  fs.writeFileSync(sprite, truncated)
  assert.match((await service.inspectPackDirectory(root)).errors[0], /Incomplete BMP run-length data/)
})

test('pet pack service rejects oversized sprite metadata before pixel decode', async () => {
  const service = createService()
  const root = createTempDir('oversized-sprite')
  const actions = [{
    id: 'idle', sprite: 'sprites/idle.png', frameCount: 1, frameMs: 100, frameWidth: 16384, frameHeight: 8192
  }]
  await createPetPackDirectory(root)
  const manifestPath = path.join(root, 'pet.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath))
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, clickAction: 'idle', actions }))
  const sprite = path.join(root, 'sprites', 'idle.png')
  const bytes = fs.readFileSync(sprite)
  bytes.writeUInt32BE(16384, 16)
  bytes.writeUInt32BE(8192, 20)
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29)
  fs.writeFileSync(sprite, bytes)
  assert.match((await service.inspectPackDirectory(root)).errors[0], /pixel limit/i)
})

test('an installed pet pack can reactivate after importing a frame strip larger than 16 megapixels', async (t) => {
  const root = createTempDir('large-frame-strip')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source-pack')
  const sourceDir = path.join(root, 'frames')
  await createPetPackDirectory(source)
  fs.mkdirSync(sourceDir)
  const frame = await sharp({
    create: { width: 512, height: 2048, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.8 } }
  }).png().toBuffer()
  for (let index = 0; index < 17; index += 1) {
    fs.writeFileSync(path.join(sourceDir, `frame-${index}.png`), frame)
  }
  const service = createPetPackService({
    settingsService: createSettingsService(),
    userPacksDir: path.join(root, 'packs')
  })
  const { selectionId } = await service.inspectPackDirectory(source)
  const { pack } = await service.importPack(selectionId)
  await service.setActivePack(pack.id)
  const importer = createActionImportService({
    framesRoot: path.join(pack.rootPath, 'frames'),
    spritesDir: path.join(pack.rootPath, 'sprites'),
    configPath: path.join(pack.rootPath, 'pet.json'),
    configType: 'pet-pack',
    spriteRelativeDir: 'sprites'
  })
  const { importedAction } = await importer.importActionFrames({ sourceDir, actionId: 'large-wave' })
  assert.equal(importedAction.frameCount * importedAction.frameWidth * importedAction.frameHeight, 17_825_792)
  await service.setActivePack(BUILT_IN_PACK_ID)
  assert.equal((await service.setActivePack(pack.id)).activePackId, pack.id)
})

test('pet pack service decodes PNG image data even when the chunks have valid checksums', async () => {
  const service = createService()
  const root = createTempDir('invalid-sprite-pixels')
  await createPetPackDirectory(root)
  const sprite = path.join(root, 'sprites', 'idle.png')
  fs.writeFileSync(sprite, corruptPngImageData(fs.readFileSync(sprite)))
  assert.match((await service.inspectPackDirectory(root)).errors[0], /could not be decoded/)
})

test('pet pack service inspects and imports a valid pack directory', async () => {
  const sourceDir = createTempDir('pet-pack-source')
  await createPetPackDirectory(sourceDir)
  const settingsService = createSettingsService()
  const service = createService(settingsService)

  const inspection = await service.inspectPackDirectory(sourceDir)
  const imported = await service.importPack(inspection.selectionId)
  const listed = service.listPacks()

  assert.equal(inspection.valid, true)
  assert.equal(inspection.pack.id, 'pack-cat')
  assert.equal(imported.pack.id, 'pack-cat')
  assert.equal(settingsService.get().petPacks.installed['pack-cat'].version, '1.0.0')
  assert.equal(listed.packs.some((pack) => pack.id === 'pack-cat'), true)
})

test('pet pack service stores provenance metadata when importing a pack', async () => {
  const sourceDir = createTempDir('pet-pack-provenance')
  await createPetPackDirectory(sourceDir, {
    id: 'provenance-cat',
    displayName: 'Provenance Cat',
    version: '1.2.0',
    sourceUrl: 'https://example.com/provenance-cat',
    assetAuthor: 'OpenPet Test Assets',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://example.com/license'
  })
  const settingsService = createSettingsService()
  const service = createService(settingsService)

  const inspection = await service.inspectPackDirectory(sourceDir)
  const imported = await service.importPack(inspection.selectionId)
  const listedPack = service.listPacks().packs.find((pack) => pack.id === 'provenance-cat')

  assert.equal(imported.pack.provenance.sourceUrl, 'https://example.com/provenance-cat')
  assert.equal(imported.pack.provenance.assetAuthor, 'OpenPet Test Assets')
  assert.equal(imported.pack.provenance.license, 'CC-BY-4.0')
  assert.equal(imported.pack.provenance.licenseUrl, 'https://example.com/license')
  assert.equal(imported.pack.provenance.originalFormat, 'directory')
  assert.equal(imported.pack.provenance.importedAt, '2026-06-12T00:00:00.000Z')
  assert.equal(settingsService.get().petPacks.installed['provenance-cat'].provenance.sourceUrl, 'https://example.com/provenance-cat')
  assert.equal(listedPack.provenance.assetAuthor, 'OpenPet Test Assets')
})

test('pet pack service reports deterministic version conflict decisions during inspection', async () => {
  const firstSource = createTempDir('pet-pack-version-first')
  const nextSource = createTempDir('pet-pack-version-next')
  await createPetPackDirectory(firstSource, { id: 'versioned-cat', version: '1.2.0' })
  await createPetPackDirectory(nextSource, { id: 'versioned-cat', version: '1.1.0' })
  const service = createService()

  const firstInspection = await service.inspectPackDirectory(firstSource)
  const first = await service.importPack(firstInspection.selectionId)
  const nextInspection = await service.inspectPackDirectory(nextSource)

  assert.equal(nextInspection.pack.conflict.installed, true)
  assert.equal(nextInspection.pack.conflict.installedVersion, '1.2.0')
  assert.equal(nextInspection.pack.conflict.incomingVersion, '1.1.0')
  assert.equal(nextInspection.pack.conflict.decision, 'downgrade')
  assert.equal(nextInspection.pack.conflict.requiresReview, true)
  await assert.rejects(() => service.importPack(nextInspection.selectionId, { expectedInstalledPackageHash: '' }), {
    code: 'pet_pack_import_conflict'
  })
  assert.equal(service.getPackManifest('versioned-cat').version, '1.2.0')
  const updated = await service.importPack(nextInspection.selectionId, { expectedInstalledPackageHash: first.pack.packageHash })
  assert.equal(updated.pack.version, '1.1.0')
})

test('pet pack service imports read-only source folders as writable installed packs', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
}, async (t) => {
  const root = createTempDir('pet-pack-read-only')
  const sourceDir = path.join(root, 'source')
  const userPacksDir = path.join(root, 'installed')
  const directories = ['', 'sprites']
  const files = ['pet.json', 'sprites/idle.png', 'sprites/wave.png']
  await createPetPackDirectory(sourceDir)
  t.after(() => {
    for (const dir of directories) fs.chmodSync(path.join(sourceDir, dir), 0o755)
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const file of files) fs.chmodSync(path.join(sourceDir, file), 0o444)
  for (const dir of directories) fs.chmodSync(path.join(sourceDir, dir), 0o555)
  const service = createPetPackService({ settingsService: createSettingsService(), userPacksDir })
  const inspection = await service.inspectPackDirectory(sourceDir)

  assert.equal(inspection.valid, true)
  const { pack } = await service.importPack(inspection.selectionId)
  for (const entry of [...directories, ...files]) {
    assert.equal(fs.statSync(path.join(pack.rootPath, entry)).mode & 0o200, 0o200, entry)
    assert.equal(fs.statSync(path.join(sourceDir, entry)).mode & 0o200, 0, entry)
  }
})

test('pet pack service leaves an active pack untouched if staging its upgrade fails', async (t) => {
  const firstSource = createTempDir('pet-pack-rollback-first')
  const nextSource = createTempDir('pet-pack-rollback-next')
  await createPetPackDirectory(firstSource)
  await createPetPackDirectory(nextSource, { version: '2.0.0' })
  const originalSprite = await createSpritePng(32, 32, 'red')
  fs.writeFileSync(path.join(firstSource, 'sprites', 'idle.png'), originalSprite)
  const settingsService = createSettingsService()
  const service = createService(settingsService)
  const first = await service.importPack((await service.inspectPackDirectory(firstSource)).selectionId)
  await service.setActivePack('pack-cat')
  const previousSettings = structuredClone(settingsService.get())
  const selectionId = (await service.inspectPackDirectory(nextSource)).selectionId
  const copy = t.mock.method(fs, 'cpSync', (source, target) => {
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'partial'), 'incomplete copy')
    throw new Error('injected copy failure')
  })

  await assert.rejects(() => service.importPack(selectionId), /injected copy failure/)
  copy.mock.restore()

  assert.equal(service.getActivePetPack().manifest.version, '1.0.0')
  assert.deepEqual(fs.readFileSync(path.join(first.pack.rootPath, 'sprites', 'idle.png')), originalSprite)
  assert.deepEqual(settingsService.get(), previousSettings)
  assert.deepEqual(fs.readdirSync(path.dirname(first.pack.rootPath)), ['pack-cat'])

  const upgraded = await service.importPack(selectionId)
  assert.equal(upgraded.pack.rootPath, first.pack.rootPath)
  assert.equal(upgraded.petPacks.activePackId, 'pack-cat')
  assert.equal(service.getActivePetPack().manifest.version, '2.0.0')
  assert.deepEqual(fs.readdirSync(path.dirname(first.pack.rootPath)), ['pack-cat'])
})

test('pet pack service restores the previous pack and settings if saving upgrade metadata fails', async (t) => {
  const firstSource = createTempDir('pet-pack-rollback-settings-first')
  const nextSource = createTempDir('pet-pack-rollback-settings-next')
  await createPetPackDirectory(firstSource)
  await createPetPackDirectory(nextSource, { version: '2.0.0' })
  const settingsService = createSettingsService()
  const service = createService(settingsService)
  const first = await service.importPack((await service.inspectPackDirectory(firstSource)).selectionId)
  await service.setActivePack('pack-cat')
  const previousSettings = structuredClone(settingsService.get())
  const selectionId = (await service.inspectPackDirectory(nextSource)).selectionId
  const saveSettings = settingsService.save
  t.mock.method(settingsService, 'save', (settings) => {
    saveSettings(settings)
    if (settings.petPacks.installed['pack-cat'].version === '2.0.0') {
      throw new Error('injected settings failure')
    }
  })

  await assert.rejects(() => service.importPack(selectionId), /injected settings failure/)

  assert.equal(service.getActivePetPack().manifest.version, '1.0.0')
  assert.deepEqual(settingsService.get(), previousSettings)
  assert.deepEqual(fs.readdirSync(path.dirname(first.pack.rootPath)), ['pack-cat'])
})

test('pet pack service exports installed user packs as re-importable zip packages', async () => {
  const sourceDir = createTempDir('pet-pack-export-source')
  await createPetPackDirectory(sourceDir, {
    id: 'exportable-cat',
    displayName: 'Exportable Cat',
    sourceUrl: 'https://example.com/exportable-cat',
    assetAuthor: 'OpenPet Test Assets',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://example.com/license'
  })
  const outputDir = createTempDir('pet-pack-export-output')
  const settingsService = createSettingsService()
  const service = createService(settingsService)

  const inspection = await service.inspectPackDirectory(sourceDir)
  await service.importPack(inspection.selectionId)
  const exported = await service.exportPack('exportable-cat', outputDir)

  assert.equal(exported.packId, 'exportable-cat')
  assert.equal(exported.fileName, 'exportable-cat-1.0.0.openpet-pet.zip')
  assert.equal(fs.existsSync(exported.outputPath), true)
  assert.equal(exported.sha256, sha256(exported.outputPath))

  service.removePack('exportable-cat')
  const reinspection = await service.inspectPackSource(exported.outputPath)
  const reimported = await service.importPack(reinspection.selectionId)
  const exportedRoot = await zipArchiveUtils.extractZipToTemp(exported.outputPath, {
    tempPrefix: 'openpet-pet-pack-export-check-'
  })
  const exportedManifest = JSON.parse(fs.readFileSync(path.join(exportedRoot, 'pet.json'), 'utf-8'))

  assert.equal(reinspection.valid, true)
  assert.equal(reinspection.pack.id, 'exportable-cat')
  assert.equal(reinspection.pack.provenance.originalFormat, 'openpet-pet-zip')
  assert.equal(exportedManifest.provenance.sourceUrl, 'https://example.com/exportable-cat')
  assert.equal(exportedManifest.provenance.assetAuthor, 'OpenPet Test Assets')
  assert.equal(exportedManifest.provenance.license, 'CC-BY-4.0')
  assert.equal(exportedManifest.provenance.licenseUrl, 'https://example.com/license')
  assert.equal(exportedManifest.provenance.originalFormat, 'directory')
  assert.equal(reimported.pack.id, 'exportable-cat')
})

test('pet pack service refuses to export built-in packs', async () => {
  const service = createService()

  await assert.rejects(() => service.exportPack(BUILT_IN_PACK_ID, createTempDir('pet-pack-export-built-in')), /built-in/)
})

test('pet pack service inspects and imports a Codex-compatible pet directory', async () => {
  const sourceDir = createTempDir('codex-pet-source')
  createCodexPetDirectory(sourceDir)
  const settingsService = createSettingsService()
  const service = createService(settingsService)

  const inspection = await service.inspectPackDirectory(sourceDir)
  const imported = await service.importPack(inspection.selectionId)
  const listed = service.listPacks()

  assert.equal(inspection.valid, true)
  assert.equal(inspection.pack.id, 'codex-cat')
  assert.equal(inspection.pack.source, 'codex-pet')
  assert.equal(inspection.pack.actionCount, 9)
  assert.equal(inspection.pack.previewAction.frameWidth, 192)
  assert.equal(imported.pack.id, 'codex-cat')
  assert.equal(settingsService.get().petPacks.installed['codex-cat'].displayName, 'Codex Cat')
  assert.equal(listed.packs.some((pack) => pack.id === 'codex-cat'), true)
})

test('pet pack service inspects and imports a Codex-compatible pet zip package', async () => {
  const sourceDir = createTempDir('codex-pet-zip-source')
  createCodexPetDirectory(sourceDir, { id: 'zip-codex-cat', displayName: 'Zip Codex Cat' })
  const zipPath = createZipFromDirectory(sourceDir)
  const settingsService = createSettingsService()
  const userPacksDir = createTempDir('pet-packs')
  const service = createPetPackService({
    settingsService,
    userPacksDir,
    projectRoot: '/app/openpet',
    loadLegacyAnimations: () => ({ defaultAction: 'idle', clickAction: 'idle', actions: [] }),
    now: () => new Date('2026-06-12T00:00:00.000Z')
  })

  const inspection = await service.inspectPackSource(zipPath)
  const extractedRoot = inspection.rootPath
  const imported = await service.importPack(inspection.selectionId)

  assert.equal(inspection.valid, true)
  assert.equal(inspection.folderName, path.basename(zipPath))
  assert.equal(inspection.pack.id, 'zip-codex-cat')
  assert.equal(inspection.pack.source, 'codex-pet')
  assert.equal(inspection.pack.sourcePackageHash, sha256(zipPath))
  assert.equal(imported.pack.id, 'zip-codex-cat')
  assert.equal(settingsService.get().petPacks.installed['zip-codex-cat'].sourcePackageHash, sha256(zipPath))
  assert.equal(fs.existsSync(path.join(userPacksDir, 'zip-codex-cat', 'pet.json')), true)
  assert.equal(fs.existsSync(extractedRoot), false)
})

test('pet pack service clears extracted zip selections', async () => {
  const sourceDir = createTempDir('codex-pet-zip-clear-source')
  createCodexPetDirectory(sourceDir, { id: 'clear-codex-cat' })
  const zipPath = createZipFromDirectory(sourceDir)
  const service = createService()

  const inspection = await service.inspectPackSource(zipPath)
  const extractedRoot = inspection.rootPath
  const result = service.clearPendingSelection(inspection.selectionId)

  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(extractedRoot), false)
})

test('pet pack service removes expired extracted zip selections', async () => {
  const sourceDir = createTempDir('codex-pet-zip-expire-source')
  createCodexPetDirectory(sourceDir, { id: 'expire-codex-cat' })
  const zipPath = createZipFromDirectory(sourceDir)
  const settingsService = createSettingsService()
  let nowMs = 0
  const service = createPetPackService({
    settingsService,
    userPacksDir: createTempDir('pet-packs'),
    projectRoot: '/app/openpet',
    loadLegacyAnimations: () => ({ defaultAction: 'idle', clickAction: 'idle', actions: [] }),
    now: () => new Date('2026-06-12T00:00:00.000Z'),
    nowMs: () => nowMs
  })

  const inspection = await service.inspectPackSource(zipPath)
  const extractedRoot = inspection.rootPath
  nowMs += 11 * 60 * 1000

  await assert.rejects(() => service.importPack(inspection.selectionId), /expired/)
  assert.equal(fs.existsSync(extractedRoot), false)
})

test('pet pack service rejects unsafe pet pack zip entries before extraction', async () => {
  const zipPath = createUnsafeZip()
  const service = createService()

  const inspection = await service.inspectPackSource(zipPath)

  assert.equal(inspection.valid, false)
  assert.match(inspection.errors[0], /unsafe paths/)
})

test('pet pack service rejects zip packages with multiple pet roots', async () => {
  const sourceRoot = createTempDir('codex-pet-zip-multiple')
  fs.mkdirSync(path.join(sourceRoot, 'one'))
  fs.mkdirSync(path.join(sourceRoot, 'two'))
  createCodexPetDirectory(path.join(sourceRoot, 'one'), { id: 'one-cat' })
  createCodexPetDirectory(path.join(sourceRoot, 'two'), { id: 'two-cat' })
  const zipPath = createZipFromDirectory(sourceRoot)
  const service = createService()

  const inspection = await service.inspectPackSource(zipPath)

  assert.equal(inspection.valid, false)
  assert.match(inspection.errors[0], /exactly one pet.json root/)
})

test('pet pack service blocks zip packages denied by source package hash', async () => {
  const sourceDir = createTempDir('codex-pet-zip-blocked-source')
  createCodexPetDirectory(sourceDir, { id: 'hash-blocked-codex-cat' })
  const zipPath = createZipFromDirectory(sourceDir)
  const blockedHash = sha256(zipPath)
  const service = createPetPackService({
    settingsService: createSettingsService(),
    userPacksDir: createTempDir('pet-packs'),
    projectRoot: '/app/openpet',
    loadLegacyAnimations: () => ({ defaultAction: 'idle', clickAction: 'idle', actions: [] }),
    getPetPackBlockStatus: ({ sourceSha256 }) => sourceSha256 === blockedHash
      ? { blocked: true, reasons: [`sha256:${blockedHash}`] }
      : { blocked: false, reasons: [] }
  })

  const inspection = await service.inspectPackSource(zipPath)

  assert.equal(inspection.valid, false)
  assert.match(inspection.errors[0], /blocked/)
})

test('action service loads the active installed pet pack and uses its root for previews', async () => {
  const sourceDir = createTempDir('pet-pack-action-source')
  await createPetPackDirectory(sourceDir, { id: 'active-cat', displayName: 'Active Cat' })
  const settingsService = createSettingsService()
  const petPackService = createService(settingsService)
  const actionService = createActionService({ petPackService })

  const inspection = await petPackService.inspectPackDirectory(sourceDir)
  await petPackService.importPack(inspection.selectionId)
  await petPackService.setActivePack('active-cat')
  actionService.reload()

  assert.equal(actionService.getPetPack().manifest.id, 'active-cat')
  assert.deepEqual(actionService.getConfig().actions.map((action) => action.id), ['idle', 'wave'])
  assert.match(actionService.getPreviewConfig().actions[0].previewSprite, /file:\/\/.*active-cat\/sprites\/idle\.png$/)
})

test('pet pack service updates the active installed pack manifest action fields', async () => {
  const sourceDir = createTempDir('pet-pack-update-active')
  await createPetPackDirectory(sourceDir, { id: 'editable-cat', displayName: 'Editable Cat' })
  const settingsService = createSettingsService()
  const petPackService = createService(settingsService)

  const inspection = await petPackService.inspectPackDirectory(sourceDir)
  await petPackService.importPack(inspection.selectionId)
  await petPackService.setActivePack('editable-cat')

  const updated = petPackService.updateActivePetPackManifest({
    defaultAction: 'wave',
    clickAction: 'wave',
    actions: [
      { id: 'idle', label: 'Idle', kind: 'idle', sprite: 'sprites/idle.png', frameCount: 1, frameMs: 100, frameWidth: 32, frameHeight: 32 },
      { id: 'wave', label: 'Wave Updated', kind: 'greeting', sprite: 'sprites/wave.png', frameCount: 1, frameMs: 100, frameWidth: 32, frameHeight: 32 }
    ],
    triggerRules: [
      { id: 'rule:state:wave:test', actionId: 'wave', type: 'state', status: 'active' }
    ]
  })

  const installedManifestPath = path.join(petPackService.listPacks().packs.find((pack) => pack.id === 'editable-cat').rootPath, 'pet.json')
  const persisted = JSON.parse(fs.readFileSync(installedManifestPath, 'utf-8'))

  assert.equal(updated.defaultAction, 'wave')
  assert.equal(persisted.clickAction, 'wave')
  assert.equal(persisted.actions.find((action) => action.id === 'wave').label, 'Wave Updated')
  assert.equal(persisted.triggerRules[0].actionId, 'wave')
})

test('pet pack service reads validates and applies creator pack manifest metadata for the active installed pack', async () => {
  const sourceDir = createTempDir('pet-pack-creator-view')
  await createPetPackDirectory(sourceDir, {
    id: 'creator-cat',
    displayName: 'Creator Cat',
    version: '1.2.3',
    sourceUrl: 'https://example.com/creator-cat',
    assetAuthor: 'OpenPet Creator',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://example.com/license'
  })
  const settingsService = createSettingsService()
  const petPackService = createService(settingsService)

  const inspection = await petPackService.inspectPackDirectory(sourceDir)
  await petPackService.importPack(inspection.selectionId)
  await petPackService.setActivePack('creator-cat')

  const view = petPackService.getActiveCreatorPackManifest()
  const validation = petPackService.validateActiveCreatorPackManifestMutation({
    displayName: 'Creator Cat v2',
    version: '2.0.0',
    provenance: {
      sourceUrl: 'https://example.com/creator-cat-v2',
      assetAuthor: 'Creator Team',
      license: 'MIT',
      licenseUrl: 'https://example.com/mit'
    }
  })
  const applied = petPackService.applyActiveCreatorPackManifestMutation({
    displayName: 'Creator Cat v2',
    version: '2.0.0',
    provenance: {
      sourceUrl: 'https://example.com/creator-cat-v2',
      assetAuthor: 'Creator Team',
      license: 'MIT',
      licenseUrl: 'https://example.com/mit'
    }
  })

  assert.equal(view.id, 'creator-cat')
  assert.equal(view.displayName, 'Creator Cat')
  assert.equal(validation.ok, true)
  assert.deepEqual(validation.errors, [])
  assert.equal(validation.manifest.displayName, 'Creator Cat v2')
  assert.equal(validation.manifest.version, '2.0.0')
  assert.equal(validation.manifest.provenance.assetAuthor, 'Creator Team')
  assert.equal(applied.displayName, 'Creator Cat v2')
  assert.equal(applied.provenance.sourceUrl, 'https://example.com/creator-cat-v2')
})

test('pet pack service rejects creator manifest mutation for built-in packs', () => {
  const petPackService = createService()

  assert.throws(
    () => petPackService.getActiveCreatorPackManifest(),
    /active installed pet pack/
  )
  const validation = petPackService.validateActiveCreatorPackManifestMutation({ displayName: 'Nope' })

  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /active installed pet pack/)
  assert.throws(
    () => petPackService.applyActiveCreatorPackManifestMutation({ displayName: 'Nope' }),
    /active installed pet pack/
  )
})

test('pet pack service rejects unsupported creator manifest keys', async () => {
  const sourceDir = createTempDir('pet-pack-creator-immutable')
  await createPetPackDirectory(sourceDir, { id: 'creator-immutable-cat' })
  const settingsService = createSettingsService()
  const petPackService = createService(settingsService)

  const inspection = await petPackService.inspectPackDirectory(sourceDir)
  await petPackService.importPack(inspection.selectionId)
  await petPackService.setActivePack('creator-immutable-cat')

  const validation = petPackService.validateActiveCreatorPackManifestMutation({
    id: 'other-cat',
    defaultAction: 'wave',
    actions: [],
    provenance: {
      importedAt: '2026-06-18T00:00:00.000Z',
      originalFormat: 'manual'
    }
  })

  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /Unsupported creator pack manifest field: id/)
  assert.match(validation.errors.join('\n'), /Unsupported creator pack manifest field: defaultAction/)
  assert.match(validation.errors.join('\n'), /Unsupported creator pack manifest field: actions/)
  assert.match(validation.errors.join('\n'), /Unsupported creator pack manifest provenance field: importedAt/)
  assert.match(validation.errors.join('\n'), /Unsupported creator pack manifest provenance field: originalFormat/)
})

test('pet pack service rejects non-object creator manifest mutations', async () => {
  const sourceDir = createTempDir('pet-pack-creator-invalid-payload')
  await createPetPackDirectory(sourceDir, { id: 'creator-invalid-payload-cat' })
  const settingsService = createSettingsService()
  const petPackService = createService(settingsService)

  const inspection = await petPackService.inspectPackDirectory(sourceDir)
  await petPackService.importPack(inspection.selectionId)
  await petPackService.setActivePack('creator-invalid-payload-cat')

  for (const payload of [null, [], 'display name']) {
    const validation = petPackService.validateActiveCreatorPackManifestMutation(payload)

    assert.equal(validation.ok, false)
    assert.match(validation.errors.join('\n'), /Creator pack manifest mutation must be an object/)
    assert.throws(
      () => petPackService.applyActiveCreatorPackManifestMutation(payload),
      /Creator pack manifest mutation must be an object/
    )
  }
})

test('pet pack service preserves host-owned and action fields during creator manifest apply', async () => {
  const sourceDir = createTempDir('pet-pack-creator-apply')
  await createPetPackDirectory(sourceDir, { id: 'creator-apply-cat', displayName: 'Creator Apply Cat' })
  const settingsService = createSettingsService()
  const petPackService = createService(settingsService)

  const inspection = await petPackService.inspectPackDirectory(sourceDir)
  await petPackService.importPack(inspection.selectionId)
  await petPackService.setActivePack('creator-apply-cat')

  const installedManifestPath = path.join(
    petPackService.listPacks().packs.find((pack) => pack.id === 'creator-apply-cat').rootPath,
    'pet.json'
  )
  const original = JSON.parse(fs.readFileSync(installedManifestPath, 'utf-8'))
  const applied = petPackService.applyActiveCreatorPackManifestMutation({
    displayName: 'Creator Apply Cat Updated',
    version: '1.1.0',
    provenance: {
      assetAuthor: 'Creator Apply Team',
      sourceUrl: 'https://example.com/creator-apply-cat'
    }
  })
  const persisted = JSON.parse(fs.readFileSync(installedManifestPath, 'utf-8'))

  assert.equal(applied.id, 'creator-apply-cat')
  assert.equal(applied.displayName, 'Creator Apply Cat Updated')
  assert.equal(applied.version, '1.1.0')
  assert.equal(applied.provenance.assetAuthor, 'Creator Apply Team')
  assert.equal(persisted.id, original.id)
  assert.equal(persisted.defaultAction, original.defaultAction)
  assert.equal(persisted.clickAction, original.clickAction)
  assert.deepEqual(persisted.actions, original.actions)
  assert.equal(persisted.displayName, 'Creator Apply Cat Updated')
  assert.equal(persisted.version, '1.1.0')
  assert.equal(persisted.sourceUrl, 'https://example.com/creator-apply-cat')
  assert.equal(persisted.assetAuthor, 'Creator Apply Team')
  assert.equal(persisted.provenance.sourceUrl, 'https://example.com/creator-apply-cat')
})

test('pet pack service rejects invalid packs before import', async () => {
  const sourceDir = createTempDir('pet-pack-invalid')
  fs.mkdirSync(path.join(sourceDir, 'sprites'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'pet.json'), JSON.stringify({
    id: 'broken-cat',
    defaultAction: 'idle',
    actions: [
      { id: 'idle', sprite: 'sprites/missing.png', frameCount: 1, frameMs: 100, frameWidth: 32, frameHeight: 32 }
    ]
  }))
  const service = createService()

  const inspection = await service.inspectPackDirectory(sourceDir)

  assert.equal(inspection.valid, false)
  assert.match(inspection.errors[0], /sprite does not exist/)
})

test('pet pack service rejects source folders containing symlinks', async () => {
  const sourceDir = createTempDir('pet-pack-symlink')
  await createPetPackDirectory(sourceDir, { id: 'symlink-cat' })
  const targetPath = path.join(sourceDir, 'sprites', 'idle.png')
  const linkPath = path.join(sourceDir, 'sprites', 'idle-link.png')
  fs.symlinkSync(targetPath, linkPath)
  const service = createService()

  const inspection = await service.inspectPackDirectory(sourceDir)

  assert.equal(inspection.valid, false)
  assert.match(inspection.errors[0], /symlinks/)
})

test('pet pack service rejects a source folder that is itself a symlink', async () => {
  const sourceDir = createTempDir('pet-pack-root-target')
  await createPetPackDirectory(sourceDir, { id: 'root-symlink-cat' })
  const linkParent = createTempDir('pet-pack-root-link')
  const linkDir = path.join(linkParent, 'pack-link')
  fs.symlinkSync(sourceDir, linkDir, 'dir')
  const service = createService()

  const inspection = await service.inspectPackDirectory(linkDir)

  assert.equal(inspection.valid, false)
  assert.match(inspection.errors[0], /symlinks/)
})

test('pet pack service protects built-in and active packs from removal', async () => {
  const sourceDir = createTempDir('pet-pack-remove')
  await createPetPackDirectory(sourceDir, { id: 'remove-cat' })
  const service = createService()

  const inspection = await service.inspectPackDirectory(sourceDir)
  await service.importPack(inspection.selectionId)

  assert.throws(() => service.removePack(BUILT_IN_PACK_ID), /built-in/)
  await service.setActivePack('remove-cat')
  assert.throws(() => service.removePack('remove-cat'), /active/)
})

test('pet pack service blocks importing and activating packs denied by ecosystem policy', async () => {
  const sourceDir = createTempDir('pet-pack-blocked')
  await createPetPackDirectory(sourceDir, { id: 'blocked-cat' })
  const settingsService = createSettingsService({
    petPacks: {
      activePackId: BUILT_IN_PACK_ID,
      installed: {
        'blocked-cat': { id: 'blocked-cat', displayName: 'Blocked Cat', version: '1.0.0' }
      }
    }
  })
  const service = createPetPackService({
    settingsService,
    userPacksDir: createTempDir('pet-packs'),
    projectRoot: '/app/openpet',
    loadLegacyAnimations: () => ({ defaultAction: 'idle', clickAction: 'idle', actions: [{ id: 'idle', sprite: 'cat_anime/sprites/idle.png', frameCount: 1, frameMs: 100, frameWidth: 1, frameHeight: 1 }] }),
    getPetPackBlockStatus: ({ id }) => id === 'blocked-cat'
      ? { blocked: true, reasons: ['packId:blocked-cat'] }
      : { blocked: false, reasons: [] }
  })

  const inspection = await service.inspectPackDirectory(sourceDir)

  assert.equal(inspection.valid, false)
  assert.match(inspection.errors[0], /blocked/)
  await assert.rejects(() => service.setActivePack('blocked-cat'), /blocked/)
})

test('pet pack service removes non-active installed packs', async () => {
  const sourceDir = createTempDir('pet-pack-removable')
  await createPetPackDirectory(sourceDir, { id: 'removable-cat' })
  const settingsService = createSettingsService()
  const service = createService(settingsService)

  const inspection = await service.inspectPackDirectory(sourceDir)
  await service.importPack(inspection.selectionId)
  const result = service.removePack('removable-cat')

  assert.equal(result.petPacks.installed['removable-cat'], undefined)
  assert.equal(settingsService.get().petPacks.installed['removable-cat'], undefined)
})

test('pet pack service self-heals invalid active installed packs to the built-in pack', () => {
  const settingsService = createSettingsService({
    petPacks: {
      activePackId: 'broken-cat',
      installed: {
        'broken-cat': { id: 'broken-cat', displayName: 'Broken Cat', version: '1.0.0' }
      }
    }
  })
  const service = createService(settingsService)

  const activePack = service.getActivePetPack()
  const listed = service.listPacks()

  assert.equal(activePack.manifest.id, BUILT_IN_PACK_ID)
  assert.equal(settingsService.get().petPacks.activePackId, BUILT_IN_PACK_ID)
  assert.equal(listed.activePackId, BUILT_IN_PACK_ID)
  assert.equal(listed.packs.find((pack) => pack.id === BUILT_IN_PACK_ID).active, true)
  assert.equal(listed.packs.find((pack) => pack.id === 'broken-cat').active, false)
})

test('pet pack service self-heals invalid active installed packs when listing packs', () => {
  const settingsService = createSettingsService({
    petPacks: {
      activePackId: 'broken-cat',
      installed: {
        'broken-cat': { id: 'broken-cat', displayName: 'Broken Cat', version: '1.0.0' }
      }
    }
  })
  const service = createService(settingsService)

  const listed = service.listPacks()

  assert.equal(settingsService.get().petPacks.activePackId, BUILT_IN_PACK_ID)
  assert.equal(listed.activePackId, BUILT_IN_PACK_ID)
  assert.equal(listed.packs.find((pack) => pack.id === BUILT_IN_PACK_ID).active, true)
  assert.equal(listed.packs.find((pack) => pack.id === 'broken-cat').active, false)
})

test('pet pack service rejects zip packages containing symbolic links', async () => {
  const sourceDir = createTempDir('codex-pet-zip-link-source')
  createCodexPetDirectory(sourceDir, { id: 'linked-codex-cat' })
  const outsidePath = path.join(createTempDir('codex-pet-zip-link-outside'), 'outside.txt')
  fs.writeFileSync(outsidePath, 'outside')
  fs.symlinkSync(outsidePath, path.join(sourceDir, 'linked.txt'))
  const zipRoot = createTempDir('pet-pack-zip')
  const zipPath = path.join(zipRoot, 'linked.codex-pet.zip')
  execFileSync('zip', ['-qry', zipPath, '.'], { cwd: sourceDir })
  const service = createService()

  const inspection = await service.inspectPackSource(zipPath)

  assert.equal(inspection.valid, false)
  assert.match(inspection.errors[0], /must not contain links/i)
})

test('pet pack service enforces bounded zip metadata before extraction', async () => {
  const zipPath = path.join(createTempDir('pet-pack-zip-limits'), 'fixture.zip')
  fs.writeFileSync(zipPath, 'fixture')
  let entries = []
  let extractCalls = 0
  const service = createPetPackService({
    settingsService: createSettingsService(),
    userPacksDir: createTempDir('pet-packs'),
    projectRoot: '/app/openpet',
    loadLegacyAnimations: () => ({ defaultAction: 'idle', clickAction: 'idle', actions: [] }),
    zipLimits: {
      maxEntries: 2,
      maxExpandedBytes: 20,
      maxFileBytes: 12,
      maxCompressionRatio: 5,
      timeoutMs: 20
    },
    inspectArchive: async () => entries,
    extractArchive: async () => {
      extractCalls += 1
    }
  })

  entries = [
    { name: 'a', uncompressedSize: 1, compressedSize: 1 },
    { name: 'b', uncompressedSize: 1, compressedSize: 1 },
    { name: 'c', uncompressedSize: 1, compressedSize: 1 }
  ]
  assert.match((await service.inspectPackSource(zipPath)).errors[0], /entry count/i)

  entries = [{ name: 'large', uncompressedSize: 13, compressedSize: 13 }]
  assert.match((await service.inspectPackSource(zipPath)).errors[0], /single file/i)

  entries = [
    { name: 'a', uncompressedSize: 11, compressedSize: 11 },
    { name: 'b', uncompressedSize: 10, compressedSize: 10 }
  ]
  assert.match((await service.inspectPackSource(zipPath)).errors[0], /expanded size/i)

  entries = [{ name: 'ratio', uncompressedSize: 12, compressedSize: 1 }]
  assert.match((await service.inspectPackSource(zipPath)).errors[0], /compression ratio/i)
  assert.equal(extractCalls, 0)
})

test('pet pack service aborts timed-out zip extraction and removes staging', async () => {
  const zipPath = path.join(createTempDir('pet-pack-zip-timeout'), 'fixture.zip')
  fs.writeFileSync(zipPath, 'fixture')
  let extractionPath = ''
  const service = createPetPackService({
    settingsService: createSettingsService(),
    userPacksDir: createTempDir('pet-packs'),
    projectRoot: '/app/openpet',
    loadLegacyAnimations: () => ({ defaultAction: 'idle', clickAction: 'idle', actions: [] }),
    zipLimits: { timeoutMs: 5 },
    inspectArchive: async () => [{ name: 'pet.json', uncompressedSize: 10, compressedSize: 10 }],
    extractArchive: async ({ destination, signal }) => {
      extractionPath = destination
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('archive extraction timed out')), { once: true })
      })
    }
  })

  const inspection = await service.inspectPackSource(zipPath)

  assert.equal(inspection.valid, false)
  assert.match(inspection.errors[0], /timed out/i)
  assert.equal(fs.existsSync(extractionPath), false)
})
