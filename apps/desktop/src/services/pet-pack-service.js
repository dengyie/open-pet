const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { pathToFileURL } = require('url')
const { isDeepStrictEqual } = require('util')
const zipArchiveUtils = require('./zip-archive-utils')
const { writeJsonAtomic } = require('./json-file-utils')
const { getLegacyPetAnimations, loadLegacyPetPack, loadPetPackFromDirectory } = require('../pet/pet-pack/loader')
const { normalizePetPackManifest } = require('../pet/pet-pack/schema')
const { assertCompleteSprite, inspectSprite } = require('../pet/pet-pack/sprite-image')

const BUILT_IN_PACK_ID = 'legacy-cat'
const DEFAULT_BUNDLED_PACKS_DIR = path.join(__dirname, '..', '..', '..', '..', 'assets', 'pet-packs')
const PET_PACK_SELECTION_TTL_MS = 10 * 60 * 1000
// zip 安全策略（限制、超时、软链接/加密拒绝）与插件包共用 zip-archive-utils。
const PET_PACK_ZIP_SUBJECT = 'Pet pack package'
const PET_PACK_FOLDER_SUBJECT = 'Pet pack'
const CREATOR_PACK_MANIFEST_FIELDS = new Set(['displayName', 'version', 'provenance'])
const CREATOR_PACK_MANIFEST_PROVENANCE_FIELDS = new Set(['sourceUrl', 'assetAuthor', 'license', 'licenseUrl'])

const isSafePackId = (packId) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(packId || '')

const ensureDirectory = (dirPath) => fs.mkdirSync(dirPath, { recursive: true })

const hashBuffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

const getFileHash = (filePath) => hashBuffer(fs.readFileSync(filePath))

const listFiles = (rootPath) => {
  const files = []
  const walk = (currentPath, relativeRoot = '') => {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name
      const entryPath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) walk(entryPath, relativePath)
      else if (entry.isFile()) files.push(relativePath)
    }
  }
  walk(rootPath)
  return files.sort()
}

const readJsonFile = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8'))

const writeJsonFile = (filePath, value) => writeJsonAtomic(filePath, value)

const getDirectoryPackageHash = (rootPath) => hashBuffer(Buffer.from(listFiles(rootPath).map((relativePath) => {
  const fileHash = hashBuffer(fs.readFileSync(path.join(rootPath, relativePath)))
  return `${relativePath}:${fileHash}`
}).join('\n'), 'utf-8'))

const compareVersions = (left = '', right = '') => {
  const parse = (value) => String(value || '')
    .split(/[.-]/)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part))

  const leftParts = parse(left)
  const rightParts = parse(right)
  const length = Math.max(leftParts.length, rightParts.length, 3)
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0
    const b = rightParts[index] ?? 0
    if (typeof a === 'number' && typeof b === 'number') {
      if (a !== b) return a > b ? 1 : -1
    } else {
      const result = String(a).localeCompare(String(b))
      if (result !== 0) return result > 0 ? 1 : -1
    }
  }
  return 0
}

const createVersionConflict = (manifest, installed = {}) => {
  if (!installed.id) {
    return {
      installed: false,
      decision: 'new-install',
      requiresReview: false,
      installedVersion: '',
      incomingVersion: manifest.version
    }
  }

  const comparison = compareVersions(manifest.version, installed.version)
  const decision = comparison > 0
    ? 'upgrade'
    : comparison < 0
      ? 'downgrade'
      : 'same-version'
  return {
    installed: true,
    decision,
    requiresReview: true,
    installedDisplayName: installed.displayName || '',
    installedPackageHash: installed.packageHash || '',
    installedVersion: installed.version || '',
    incomingVersion: manifest.version
  }
}

const extractZipToTemp = (zipPath, { limits, inspectArchive, extractArchive }) => zipArchiveUtils.extractZipToTemp(zipPath, {
  subject: PET_PACK_ZIP_SUBJECT,
  folderSubject: PET_PACK_FOLDER_SUBJECT,
  tempPrefix: 'openpet-pet-pack-zip-',
  limits,
  inspectArchive,
  extractArchive
})

const findPetPackRoot = (extractRoot) => {
  if (fs.existsSync(path.join(extractRoot, 'pet.json'))) return extractRoot
  const candidates = fs.readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extractRoot, entry.name))
    .filter((entryPath) => fs.existsSync(path.join(entryPath, 'pet.json')))
  if (candidates.length !== 1) throw new Error('Pet pack package must contain exactly one pet.json root')
  return candidates[0]
}

const normalizePetPackSettings = (settings = {}) => ({
  activePackId: settings.activePackId || BUILT_IN_PACK_ID,
  installed: settings.installed && typeof settings.installed === 'object' && !Array.isArray(settings.installed)
    ? settings.installed
    : {}
})

const createSelectionId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

const createBuiltInPack = ({ projectRoot, loadLegacyAnimations }) => {
  const pack = loadLegacyPetPack({
    id: BUILT_IN_PACK_ID,
    displayName: 'Legacy Cat',
    getPetAnimations: loadLegacyAnimations
  })
  return {
    ...pack,
    rootPath: projectRoot,
    source: { type: 'built-in', path: projectRoot }
  }
}

const listBundledPackRoots = (bundledPacksDir) => {
  if (!bundledPacksDir || !fs.existsSync(bundledPacksDir)) return []
  return fs.readdirSync(bundledPacksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(bundledPacksDir, entry.name))
    .filter((entryPath) => fs.existsSync(path.join(entryPath, 'pet.json')))
    .sort()
}

const assertInsideDirectory = (rootPath, targetPath, fieldName) => {
  const rootRealPath = fs.realpathSync(rootPath)
  const targetRealPath = fs.realpathSync(targetPath)
  if (targetRealPath !== rootRealPath && !targetRealPath.startsWith(`${rootRealPath}${path.sep}`)) {
    throw new Error(`Pet pack ${fieldName} must stay inside the pet pack directory`)
  }
}

const assertNoSymlinks = (rootPath) => zipArchiveUtils.assertNoSymlinks(rootPath, { subject: PET_PACK_FOLDER_SUBJECT })

const invalidPack = (message) => Object.assign(new Error(message), { code: 'VALIDATION_FAILED' })

const resolveSpritePath = (pack, action) => {
  const spritePath = path.join(pack.rootPath, action.sprite)
  if (!fs.statSync(spritePath, { throwIfNoEntry: false })?.isFile()) {
    throw invalidPack(`Pet pack action sprite does not exist: ${action.sprite}`)
  }
  assertInsideDirectory(pack.rootPath, spritePath, `action(${action.id}).sprite`)
  return spritePath
}

const spriteDecodeError = (action, error) => invalidPack(`Pet pack action sprite could not be decoded: ${action.sprite} (${error.message})`)

const validatePackFiles = (pack, { checkCompleteness = false } = {}) => {
  const checked = new Set()
  for (const action of pack.manifest.actions) {
    const spritePath = resolveSpritePath(pack, action)
    if (!checkCompleteness || checked.has(spritePath)) continue
    try {
      assertCompleteSprite(fs.readFileSync(spritePath))
    } catch (error) {
      throw spriteDecodeError(action, error)
    }
    checked.add(spritePath)
  }
}

const validatePackSprites = async (pack) => {
  const spriteActions = new Map()
  for (const action of pack.manifest.actions) {
    const spritePath = resolveSpritePath(pack, action)
    if (!spriteActions.has(spritePath)) spriteActions.set(spritePath, [])
    spriteActions.get(spritePath).push(action)
  }

  for (const [spritePath, actions] of spriteActions) {
    let sprite
    try {
      sprite = await inspectSprite(await fs.promises.readFile(spritePath))
    } catch (error) {
      throw spriteDecodeError(actions[0], error)
    }
    const { width, height } = sprite
    for (const action of actions) {
      const columns = action.atlas?.columns ?? action.frameCount
      const rows = action.atlas?.rows ?? 1
      const expectedWidth = columns * action.frameWidth
      const expectedHeight = rows * action.frameHeight
      if (width !== expectedWidth || height !== expectedHeight
          || (action.atlas && (action.atlas.width !== width || action.atlas.height !== height))
          || (action.frameColumn ?? 0) + action.frameCount > columns || (action.frameRow ?? 0) >= rows) {
        throw invalidPack(`Pet pack action ${action.id} sprite dimensions do not match the manifest: ${action.sprite} (${width}x${height}, expected ${expectedWidth}x${expectedHeight})`)
      }
    }
    try {
      await sprite.decode?.()
    } catch (error) {
      throw spriteDecodeError(actions[0], error)
    }
  }
}

const pickPreviewAction = (actions = []) => {
  return actions.find((action) => action.kind === 'idle')
    || actions.find((action) => action.kind === 'greeting')
    || actions[0]
}

const createPackSummary = (pack, { active = false, installedAt = '', updatedAt = '' } = {}) => {
  const previewAction = pickPreviewAction(pack.manifest.actions)
  const provenance = {
    ...(pack.manifest.provenance || {}),
    ...(pack.metadata?.provenance || {})
  }
  return {
    id: pack.manifest.id,
    displayName: pack.manifest.displayName,
    version: pack.manifest.version,
    source: pack.source?.type || 'directory',
    rootPath: pack.rootPath,
    active,
    installedAt,
    updatedAt,
    packageHash: pack.metadata?.packageHash || '',
    sourcePackageHash: pack.metadata?.sourcePackageHash || '',
    provenance,
    actionCount: pack.manifest.actions.length,
    defaultAction: pack.manifest.defaultAction,
    clickAction: pack.manifest.clickAction,
    presentation: pack.manifest.presentation ? structuredClone(pack.manifest.presentation) : null,
    previewSprite: previewAction?.sprite
      ? pathToFileURL(path.join(pack.rootPath, previewAction.sprite)).toString()
      : '',
    previewAction: previewAction ? {
      id: previewAction.id,
      label: previewAction.label || previewAction.id,
      frameCount: previewAction.frameCount,
      frameWidth: previewAction.frameWidth,
      frameHeight: previewAction.frameHeight,
      frameMs: previewAction.frameMs,
      frameRow: previewAction.frameRow,
      frameColumn: previewAction.frameColumn,
      atlas: previewAction.atlas,
      frameDurations: previewAction.frameDurations
    } : null
  }
}

const removeImportDirectory = (dirPath) => {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true })
  } catch (error) {
    console.warn('Failed to clean up pet pack import:', error.message)
  }
}

const makeStagedPackWritable = (entryPath) => {
  const stats = fs.lstatSync(entryPath)
  if (!stats.isDirectory() && !stats.isFile()) return
  if (!(stats.mode & 0o200)) fs.chmodSync(entryPath, stats.mode | 0o200)
  if (stats.isDirectory()) {
    for (const name of fs.readdirSync(entryPath)) {
      makeStagedPackWritable(path.join(entryPath, name))
    }
  }
}

const writePackManifest = (rootPath, pack) => {
  const manifestPath = path.join(rootPath, 'pet.json')
  const manifest = {
    ...readJsonFile(manifestPath),
    provenance: {
      ...(pack.manifest.provenance || {}),
      ...(pack.metadata?.provenance || {})
    }
  }
  writeJsonFile(manifestPath, manifest)
}

const createPetPackService = ({
  settingsService,
  userPacksDir,
  projectRoot = path.join(__dirname, '..', '..', '..', '..'),
  bundledPacksDir = DEFAULT_BUNDLED_PACKS_DIR,
  loadLegacyAnimations = getLegacyPetAnimations,
  now = () => new Date(),
  nowMs = () => Date.now(),
  getPetPackBlockStatus = () => ({ blocked: false, reasons: [] }),
  zipLimits = {},
  inspectArchive = zipArchiveUtils.inspectZipArchive,
  extractArchive = zipArchiveUtils.extractZipArchive
}) => {
  if (!settingsService) throw new Error('settingsService is required')
  if (!userPacksDir) throw new Error('userPacksDir is required')

  let pendingSelection = null
  const limits = { ...zipArchiveUtils.DEFAULT_ZIP_LIMITS, ...zipLimits }

  const getSettings = () => normalizePetPackSettings(settingsService.get().petPacks)
  const getActivePackId = () => getSettings().activePackId

  const savePetPackSettings = (petPacks) => {
    const settings = settingsService.get()
    settingsService.save({ ...settings, petPacks })
    return getSettings()
  }

  const getBuiltInPack = () => createBuiltInPack({ projectRoot, loadLegacyAnimations })

  const resetActivePackToBuiltIn = () => {
    const current = getSettings()
    if (current.activePackId === BUILT_IN_PACK_ID) return current
    return savePetPackSettings({ ...current, activePackId: BUILT_IN_PACK_ID })
  }

  const listBundledPacks = () => listBundledPackRoots(bundledPacksDir).map((packRoot) => {
    const pack = loadPetPackFromDirectory(packRoot)
    validatePackFiles(pack)
    return {
      ...pack,
      source: { type: 'built-in', path: packRoot }
    }
  })

  const getBundledPack = (packId) => listBundledPacks().find((pack) => pack.manifest.id === packId) || null

  const getBundledPackPolicyInput = (packId) => {
    const pack = getBundledPack(packId)
    return pack ? { id: packId, packageHash: getDirectoryPackageHash(pack.rootPath) } : null
  }

  const isBuiltInPackId = (packId) => packId === BUILT_IN_PACK_ID || Boolean(getBundledPack(packId))

  const assertInstallablePackId = (packId) => {
    if (!isSafePackId(packId)) throw new Error('Pet pack id is invalid')
    if (isBuiltInPackId(packId)) throw invalidPack(`Pet pack id is reserved for a built-in pack: ${packId}`)
  }

  const getPolicyStatus = ({ id, sha256, sourceSha256, packageHash } = {}) => getPetPackBlockStatus({ id, sha256, sourceSha256, packageHash }) || { blocked: false, reasons: [] }

  const assertPackAllowed = ({ id, sha256, sourceSha256, packageHash } = {}) => {
    const status = getPolicyStatus({ id, sha256, sourceSha256, packageHash })
    if (status.blocked) throw new Error(`Pet pack is blocked: ${status.reasons.join(', ')}`)
    return status
  }

  const loadInstalledPack = (packId, { checkCompleteness = true } = {}) => {
    const metadata = getSettings().installed[packId]
    if (!metadata) throw new Error(`Pet pack is not installed: ${packId}`)
    const pack = loadPetPackFromDirectory(path.join(userPacksDir, packId))
    if (pack.manifest.id !== packId) throw new Error(`Installed pet pack id mismatch: ${packId}`)
    validatePackFiles(pack, { checkCompleteness })
    return {
      ...pack,
      source: { type: 'user-installed', path: pack.rootPath },
      metadata
    }
  }

  const getActivePetPack = () => {
    const petPackSettings = getSettings()
    const activeBundledPack = petPackSettings.activePackId === BUILT_IN_PACK_ID ? null : getBundledPack(petPackSettings.activePackId)
    if (activeBundledPack) {
      assertPackAllowed({ id: activeBundledPack.manifest.id, packageHash: getDirectoryPackageHash(activeBundledPack.rootPath) })
      return activeBundledPack
    }

    if (petPackSettings.activePackId && petPackSettings.activePackId !== BUILT_IN_PACK_ID) {
      try {
        const metadata = petPackSettings.installed[petPackSettings.activePackId]
        assertPackAllowed({ id: petPackSettings.activePackId, packageHash: metadata?.packageHash || '', sourceSha256: metadata?.sourcePackageHash || '' })
        return loadInstalledPack(petPackSettings.activePackId)
      } catch (error) {
        console.error('Failed to load active pet pack:', error.message)
        resetActivePackToBuiltIn()
      }
    }
    return getBuiltInPack()
  }

  const listPacks = () => {
    let petPackSettings = getSettings()
    if (petPackSettings.activePackId && petPackSettings.activePackId !== BUILT_IN_PACK_ID && !getBundledPack(petPackSettings.activePackId)) {
      try {
        const metadata = petPackSettings.installed[petPackSettings.activePackId]
        assertPackAllowed({ id: petPackSettings.activePackId, packageHash: metadata?.packageHash || '', sourceSha256: metadata?.sourcePackageHash || '' })
        loadInstalledPack(petPackSettings.activePackId)
      } catch (error) {
        console.error('Failed to load active pet pack:', error.message)
        petPackSettings = resetActivePackToBuiltIn()
      }
    }
    const builtInPack = getBuiltInPack()
    const packs = [{
      ...createPackSummary(builtInPack, { active: petPackSettings.activePackId === BUILT_IN_PACK_ID }),
      blockStatus: getPolicyStatus({ id: BUILT_IN_PACK_ID })
    }]

    for (const bundledPack of listBundledPacks()) {
      packs.push({
        ...createPackSummary(bundledPack, { active: petPackSettings.activePackId === bundledPack.manifest.id }),
        blockStatus: getPolicyStatus({ id: bundledPack.manifest.id, packageHash: getDirectoryPackageHash(bundledPack.rootPath) })
      })
    }

    for (const [packId, metadata] of Object.entries(petPackSettings.installed)) {
      const conflictsWithBuiltIn = packs.some((pack) => pack.source === 'built-in' && pack.id === packId)
      try {
        if (conflictsWithBuiltIn) throw new Error(`Installed copy conflicts with the built-in pet pack ID: ${packId}`)
        const pack = loadInstalledPack(packId)
        packs.push({
          ...createPackSummary(pack, {
            active: petPackSettings.activePackId === packId,
            installedAt: metadata.installedAt,
            updatedAt: metadata.updatedAt
          }),
          blockStatus: getPolicyStatus({ id: packId, packageHash: metadata.packageHash, sourceSha256: metadata.sourcePackageHash }),
        })
      } catch (error) {
        packs.push({
          id: packId,
          displayName: metadata.displayName || packId,
          version: metadata.version || 'unknown',
          source: 'user-installed',
          rootPath: path.join(userPacksDir, packId),
          active: !conflictsWithBuiltIn && petPackSettings.activePackId === packId,
          installedAt: metadata.installedAt || '',
          updatedAt: metadata.updatedAt || '',
          actionCount: 0,
          defaultAction: '',
          clickAction: '',
          previewSprite: '',
          valid: false,
          blockStatus: getPolicyStatus({ id: packId, packageHash: metadata.packageHash, sourceSha256: metadata.sourcePackageHash }),
          error: error.message || 'Failed to load pet pack'
        })
      }
    }

    return { activePackId: petPackSettings.activePackId, packs }
  }

  const inspectPackDirectory = async (sourceDir) => {
    const selectionId = createSelectionId()
    const result = {
      selectionId,
      folderName: path.basename(sourceDir || ''),
      valid: false,
      errors: [],
      pack: null
    }

    try {
      cleanupPendingSelection()
      if (!sourceDir || !fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        throw new Error('Pet pack folder does not exist')
      }
      assertNoSymlinks(sourceDir)
      const packageHash = getDirectoryPackageHash(sourceDir)
      const pack = loadPetPackFromDirectory(sourceDir)
      assertInstallablePackId(pack.manifest.id)
      const blockStatus = assertPackAllowed({ id: pack.manifest.id, sha256: packageHash })
      await validatePackSprites(pack)
      result.valid = true
      result.pack = {
        ...createPackSummary({
          ...pack,
          metadata: {
            packageHash,
            provenance: { originalFormat: pack.source?.type || 'directory' }
          }
        }),
        packageHash,
        blockStatus,
        conflict: createVersionConflict(pack.manifest, getSettings().installed[pack.manifest.id])
      }
      pendingSelection = {
        id: selectionId,
        sourceDir,
        inspectedAt: nowMs(),
        packId: pack.manifest.id,
        sourceType: 'directory',
        cleanupPath: ''
      }
    } catch (error) {
      result.errors.push(error.message || 'Pet pack inspection failed')
      pendingSelection = null
    }

    return result
  }

  const cleanupPendingSelection = () => {
    const cleanupPath = pendingSelection?.cleanupPath
    pendingSelection = null
    if (cleanupPath) removeImportDirectory(cleanupPath)
  }

  const inspectPackSource = async (sourcePath) => {
    const selectionId = createSelectionId()
    const result = {
      selectionId,
      folderName: path.basename(sourcePath || ''),
      valid: false,
      errors: [],
      pack: null
    }
    let cleanupPath = ''
    try {
      cleanupPendingSelection()
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        throw new Error('Pet pack source does not exist')
      }
      let sourceDir = sourcePath
      let sourceType = 'directory'
      if (!fs.statSync(sourcePath).isDirectory()) {
        if (!fs.statSync(sourcePath).isFile() || !/\.zip$/i.test(sourcePath)) {
          throw new Error('Pet pack source must be a directory or zip package')
        }
        sourceDir = await extractZipToTemp(sourcePath, { limits, inspectArchive, extractArchive })
        cleanupPath = sourceDir
        sourceType = 'zip'
      }
      const petPackRoot = findPetPackRoot(sourceDir)
      assertNoSymlinks(petPackRoot)
      const packageHash = getDirectoryPackageHash(petPackRoot)
      const sourcePackageHash = sourceType === 'zip' ? getFileHash(sourcePath) : ''
      const pack = loadPetPackFromDirectory(petPackRoot)
      assertInstallablePackId(pack.manifest.id)
      const blockStatus = assertPackAllowed({ id: pack.manifest.id, sha256: packageHash, sourceSha256: sourcePackageHash })
      await validatePackSprites(pack)
      result.valid = true
      result.rootPath = petPackRoot
      result.pack = {
        ...createPackSummary({
          ...pack,
          metadata: {
            packageHash,
            sourcePackageHash,
            provenance: { originalFormat: sourceType === 'zip' ? 'openpet-pet-zip' : pack.source?.type || 'directory' }
          }
        }),
        packageHash,
        sourcePackageHash,
        blockStatus,
        conflict: createVersionConflict(pack.manifest, getSettings().installed[pack.manifest.id])
      }
      cleanupPendingSelection()
      pendingSelection = {
        id: selectionId,
        sourceDir: petPackRoot,
        inspectedAt: nowMs(),
        packId: pack.manifest.id,
        sourceType,
        cleanupPath,
        sourcePackageHash
      }
    } catch (error) {
      if (cleanupPath) fs.rmSync(cleanupPath, { recursive: true, force: true })
      result.errors.push(error.message || 'Pet pack inspection failed')
      pendingSelection = null
    }
    return result
  }

  const getPendingSelection = (selectionId) => {
    if (!pendingSelection || pendingSelection.id !== selectionId) {
      throw new Error('Selected pet pack folder is no longer available')
    }
    if (nowMs() - pendingSelection.inspectedAt > PET_PACK_SELECTION_TTL_MS) {
      cleanupPendingSelection()
      throw new Error('Selected pet pack folder expired')
    }
    return pendingSelection
  }

  const clearPendingSelection = (selectionId) => {
    if (!selectionId || pendingSelection?.id === selectionId) cleanupPendingSelection()
    return { ok: true }
  }

  const importPack = async (selectionId, { packageHash = '', sourcePackageHash = '', expectedInstalledPackageHash } = {}) => {
    const selection = getPendingSelection(selectionId)
    assertNoSymlinks(selection.sourceDir)
    const pack = loadPetPackFromDirectory(selection.sourceDir)
    const packId = pack.manifest.id
    assertInstallablePackId(packId)
    ensureDirectory(userPacksDir)
    const targetParentRealPath = fs.realpathSync(userPacksDir)
    const targetDir = path.join(targetParentRealPath, packId)
    const sourceRealPath = fs.realpathSync(selection.sourceDir)
    if (sourceRealPath === targetDir || sourceRealPath.startsWith(`${targetDir}${path.sep}`)) {
      throw new Error('Cannot import a pet pack from its install target')
    }

    const stagingRoot = fs.mkdtempSync(path.join(targetParentRealPath, '.import-'))
    const stagedDir = path.join(stagingRoot, 'pack')
    const backupDir = path.join(stagingRoot, 'previous')
    let backedUp = false
    let swapped = false
    let previousSettings
    let keepBackup = false
    try {
      fs.cpSync(selection.sourceDir, stagedDir, { recursive: true })
      assertNoSymlinks(stagedDir)
      makeStagedPackWritable(stagedDir)
      const stagedPack = loadPetPackFromDirectory(stagedDir)
      if (stagedPack.manifest.id !== packId) throw new Error('Pet pack id changed during import')
      await validatePackSprites(stagedPack)
      getPendingSelection(selectionId)
      const contentPackageHash = packageHash || getDirectoryPackageHash(stagedDir)
      const downloadedPackageHash = sourcePackageHash || selection.sourcePackageHash || ''
      assertPackAllowed({ id: packId, packageHash: contentPackageHash, sourceSha256: downloadedPackageHash })

      const current = getSettings()
      const previousMetadata = current.installed[packId] || {}
      const installedDirectory = fs.lstatSync(targetDir, { throwIfNoEntry: false })
      if (expectedInstalledPackageHash !== undefined && (installedDirectory || previousMetadata.id) && (
        !expectedInstalledPackageHash ||
        previousMetadata.packageHash !== expectedInstalledPackageHash ||
        !installedDirectory?.isDirectory() ||
        getDirectoryPackageHash(targetDir) !== expectedInstalledPackageHash
      )) {
        throw Object.assign(new Error(`Pet pack "${packId}" is already installed; no pack was replaced`), {
          code: 'pet_pack_import_conflict'
        })
      }
      const timestamp = now().toISOString()
      const provenance = {
        ...(stagedPack.manifest.provenance || {}),
        originalFormat: selection.sourceType === 'zip' ? 'openpet-pet-zip' : stagedPack.source?.type || 'directory',
        importedAt: previousMetadata.provenance?.importedAt || previousMetadata.importedAt || timestamp
      }
      const installPath = path.join(userPacksDir, packId)
      const summary = createPackSummary({
        ...stagedPack,
        rootPath: installPath,
        source: { type: 'user-installed', path: installPath },
        metadata: { packageHash: contentPackageHash, sourcePackageHash: downloadedPackageHash, provenance }
      })
      if (installedDirectory) {
        fs.renameSync(targetDir, backupDir)
        backedUp = true
      }
      fs.renameSync(stagedDir, targetDir)
      swapped = true
      previousSettings = current
      const nextSettings = savePetPackSettings({
        ...current,
        installed: {
          ...current.installed,
          [packId]: {
            id: packId,
            displayName: stagedPack.manifest.displayName,
            version: stagedPack.manifest.version,
            packageHash: contentPackageHash,
            sourcePackageHash: downloadedPackageHash,
            provenance,
            installedAt: previousMetadata.installedAt || timestamp,
            updatedAt: timestamp
          }
        }
      })
      cleanupPendingSelection()
      return { pack: summary, petPacks: nextSettings }
    } catch (error) {
      try {
        if (swapped) fs.renameSync(targetDir, stagedDir)
        if (backedUp) {
          fs.renameSync(backupDir, targetDir)
          backedUp = false
        }
        if (previousSettings && !isDeepStrictEqual(getSettings(), previousSettings)) {
          savePetPackSettings(previousSettings)
        }
      } catch (rollbackError) {
        keepBackup = backedUp
        const recoveryPath = keepBackup ? `; previous pack preserved at ${backupDir}` : ''
        throw new AggregateError([error, rollbackError], `Pet pack import failed: ${error.message}; rollback failed: ${rollbackError.message}${recoveryPath}`)
      }
      throw error
    } finally {
      if (!keepBackup) removeImportDirectory(stagingRoot)
    }
  }

  const exportPack = async (packId, outputDir) => {
    if (!isSafePackId(packId)) throw new Error('Pet pack id is invalid')
    if (isBuiltInPackId(packId)) throw new Error('Cannot export the built-in pet pack')
    if (!outputDir) throw new Error('Pet pack export output directory is required')
    const pack = loadInstalledPack(packId)
    ensureDirectory(outputDir)
    const fileName = `${pack.manifest.id}-${pack.manifest.version}.openpet-pet.zip`
    const outputPath = path.join(outputDir, fileName)
    const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openpet-pet-pack-export-'))
    try {
      fs.cpSync(pack.rootPath, exportRoot, { recursive: true })
      writePackManifest(exportRoot, pack)
      await zipArchiveUtils.writeZipFromDirectory(exportRoot, outputPath)
    } finally {
      fs.rmSync(exportRoot, { recursive: true, force: true })
    }
    return {
      packId,
      fileName,
      outputPath,
      sha256: getFileHash(outputPath),
      byteSize: fs.statSync(outputPath).size
    }
  }

  const updateActivePetPackManifest = (nextManifest = {}) => {
    const current = getSettings()
    const activePackId = current.activePackId
    if (!activePackId) throw new Error('No active pet pack is selected')
    if (isBuiltInPackId(activePackId)) {
      throw new Error('The built-in pet pack cannot be modified through pet-pack persistence')
    }
    const metadata = current.installed[activePackId]
    if (!metadata) throw new Error(`Pet pack is not installed: ${activePackId}`)
    const targetDir = path.join(userPacksDir, activePackId)
    if (!fs.existsSync(path.join(targetDir, 'pet.json'))) {
      throw new Error(`Pet pack manifest is missing: ${activePackId}`)
    }
    const currentManifest = loadPetPackFromDirectory(targetDir).manifest
    const nextActions = Array.isArray(nextManifest.actions) ? nextManifest.actions : currentManifest.actions
    const manifest = {
      ...readJsonFile(path.join(targetDir, 'pet.json')),
      defaultAction: nextManifest.defaultAction ?? currentManifest.defaultAction,
      clickAction: nextManifest.clickAction ?? currentManifest.clickAction,
      actions: nextActions,
      ...(nextManifest.triggerProposalInbox !== undefined
        ? { triggerProposalInbox: Array.isArray(nextManifest.triggerProposalInbox) ? nextManifest.triggerProposalInbox : [] }
        : {}),
      ...(nextManifest.triggerRules !== undefined
        ? { triggerRules: Array.isArray(nextManifest.triggerRules) ? nextManifest.triggerRules : [] }
        : {})
    }
    writeJsonFile(path.join(targetDir, 'pet.json'), manifest)
    return loadPetPackFromDirectory(targetDir).manifest
  }

  const cloneCreatorPackManifestView = (pack) => ({
    id: pack.manifest.id,
    displayName: pack.manifest.displayName,
    version: pack.manifest.version,
    source: pack.source?.type || 'directory',
    provenance: {
      sourceUrl: pack.manifest.provenance?.sourceUrl || '',
      assetAuthor: pack.manifest.provenance?.assetAuthor || '',
      license: pack.manifest.provenance?.license || '',
      licenseUrl: pack.manifest.provenance?.licenseUrl || ''
    }
  })

  const assertCreatorEditableActivePack = () => {
    const pack = getActivePetPack()
    if (pack.source?.type !== 'user-installed') {
      throw new Error('Creator pack manifest workflows require an active installed pet pack')
    }
    return pack
  }

  const collectUnsupportedCreatorManifestErrors = (mutation = {}) => {
    const errors = []
    for (const field of Object.keys(mutation || {})) {
      if (!CREATOR_PACK_MANIFEST_FIELDS.has(field)) {
        errors.push(`Unsupported creator pack manifest field: ${field}`)
      }
    }
    if (mutation.provenance && typeof mutation.provenance === 'object' && !Array.isArray(mutation.provenance)) {
      for (const field of Object.keys(mutation.provenance)) {
        if (!CREATOR_PACK_MANIFEST_PROVENANCE_FIELDS.has(field)) {
          errors.push(`Unsupported creator pack manifest provenance field: ${field}`)
        }
      }
    }
    return errors
  }

  const getActiveCreatorPackManifest = () => cloneCreatorPackManifestView(assertCreatorEditableActivePack())

  const validateActiveCreatorPackManifestMutation = (mutation = {}) => {
    const errors = []
    let pack = null
    try {
      pack = assertCreatorEditableActivePack()
    } catch (error) {
      return { ok: false, errors: [error.message], warnings: [], manifest: null }
    }

    if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
      return {
        ok: false,
        errors: ['Creator pack manifest mutation must be an object'],
        warnings: [],
        manifest: cloneCreatorPackManifestView(pack)
      }
    }

    errors.push(...collectUnsupportedCreatorManifestErrors(mutation))

    const nextDisplayName = mutation.displayName == null ? pack.manifest.displayName : String(mutation.displayName).trim()
    const nextVersion = mutation.version == null ? pack.manifest.version : String(mutation.version).trim()
    if (!nextDisplayName) errors.push('Creator pack manifest displayName is required')
    if (!nextVersion) errors.push('Creator pack manifest version is required')
    if (mutation.provenance != null && (!mutation.provenance || typeof mutation.provenance !== 'object' || Array.isArray(mutation.provenance))) {
      errors.push('Creator pack manifest provenance must be an object')
    }

    const creatorProvenance = mutation.provenance && typeof mutation.provenance === 'object' && !Array.isArray(mutation.provenance)
      ? Object.fromEntries(Object.entries(mutation.provenance).map(([key, value]) => [key, String(value ?? '').trim()]))
      : {}
    const nextProvenance = {
      ...(pack.manifest.provenance || {}),
      ...creatorProvenance
    }
    const mergedManifest = {
      ...pack.manifest,
      displayName: nextDisplayName,
      version: nextVersion,
      provenance: {
        ...(pack.manifest.provenance || {}),
        sourceUrl: nextProvenance.sourceUrl || '',
        assetAuthor: nextProvenance.assetAuthor || '',
        license: nextProvenance.license || '',
        licenseUrl: nextProvenance.licenseUrl || '',
        importedAt: pack.manifest.provenance?.importedAt || '',
        originalFormat: pack.manifest.provenance?.originalFormat || ''
      }
    }

    if (errors.length === 0) normalizePetPackManifest(mergedManifest)

    return {
      ok: errors.length === 0,
      errors,
      warnings: [],
      manifest: cloneCreatorPackManifestView({ manifest: mergedManifest, source: pack.source })
    }
  }

  const applyActiveCreatorPackManifestMutation = (mutation = {}) => {
    const validation = validateActiveCreatorPackManifestMutation(mutation)
    if (!validation.ok) {
      throw new Error(`Creator pack manifest mutation is invalid: ${validation.errors.join('; ')}`)
    }
    const current = getSettings()
    const activePackId = current.activePackId
    const targetDir = path.join(userPacksDir, activePackId)
    const manifestPath = path.join(targetDir, 'pet.json')
    const rawManifest = readJsonFile(manifestPath)
    const nextManifest = {
      ...rawManifest,
      displayName: validation.manifest.displayName,
      version: validation.manifest.version,
      sourceUrl: validation.manifest.provenance.sourceUrl,
      assetAuthor: validation.manifest.provenance.assetAuthor,
      license: validation.manifest.provenance.license,
      licenseUrl: validation.manifest.provenance.licenseUrl,
      provenance: {
        ...(rawManifest.provenance || {}),
        sourceUrl: validation.manifest.provenance.sourceUrl,
        assetAuthor: validation.manifest.provenance.assetAuthor,
        license: validation.manifest.provenance.license,
        licenseUrl: validation.manifest.provenance.licenseUrl
      }
    }
    normalizePetPackManifest(nextManifest)
    writeJsonFile(manifestPath, nextManifest)
    return cloneCreatorPackManifestView(loadInstalledPack(activePackId))
  }

  const getPackManifest = (packId) => {
    if (!isSafePackId(packId)) throw new Error('Pet pack id is invalid')
    if (packId === BUILT_IN_PACK_ID) return structuredClone(getBuiltInPack().manifest)
    const bundledPack = getBundledPack(packId)
    if (bundledPack) {
      assertPackAllowed({ id: packId, packageHash: getDirectoryPackageHash(bundledPack.rootPath) })
      return structuredClone(bundledPack.manifest)
    }
    const metadata = getSettings().installed[packId]
    assertPackAllowed({ id: packId, packageHash: metadata?.packageHash || '', sourceSha256: metadata?.sourcePackageHash || '' })
    return structuredClone(loadInstalledPack(packId).manifest)
  }

  const setActivePack = async (packId) => {
    if (!isSafePackId(packId)) throw new Error('Pet pack id is invalid')
    const metadata = getSettings().installed[packId]
    const bundledPolicyInput = getBundledPackPolicyInput(packId)
    assertPackAllowed(bundledPolicyInput || { id: packId, packageHash: metadata?.packageHash || '', sourceSha256: metadata?.sourcePackageHash || '' })
    if (!bundledPolicyInput && packId !== BUILT_IN_PACK_ID) {
      await validatePackSprites(loadInstalledPack(packId, { checkCompleteness: false }))
    }
    const current = getSettings()
    const nextSettings = savePetPackSettings({ ...current, activePackId: packId })
    return { activePackId: nextSettings.activePackId, pack: createPackSummary(getActivePetPack(), { active: true }) }
  }

  const removePack = (packId) => {
    if (!isSafePackId(packId)) throw new Error('Pet pack id is invalid')
    const current = getSettings()
    const builtIn = isBuiltInPackId(packId)
    if (!Object.hasOwn(current.installed, packId)) {
      if (builtIn) throw new Error('Cannot remove the built-in pet pack')
      if (current.activePackId === packId) throw new Error('Cannot remove the active pet pack')
      throw new Error(`Pet pack is not installed: ${packId}`)
    }
    if (!builtIn && current.activePackId === packId) throw new Error('Cannot remove the active pet pack')
    if (fs.existsSync(userPacksDir)) {
      const targetDir = path.join(fs.realpathSync(userPacksDir), packId)
      const protectedRoots = [...listBundledPackRoots(bundledPacksDir), projectRoot]
      if (protectedRoots.some((root) => {
        if (!fs.existsSync(root)) return false
        const realRoot = fs.realpathSync(root)
        return realRoot === targetDir || realRoot.startsWith(`${targetDir}${path.sep}`)
      })) throw new Error('Cannot remove the built-in pet pack')
      fs.rmSync(targetDir, { recursive: true, force: true })
    }
    const nextInstalled = { ...current.installed }
    delete nextInstalled[packId]
    const nextSettings = savePetPackSettings({ ...current, installed: nextInstalled })
    return { petPacks: nextSettings }
  }

  return {
    getActivePackId,
    getActivePetPack,
    getPackManifest,
    listPacks,
    inspectPackDirectory,
    inspectPackSource,
    clearPendingSelection,
    importPack,
    exportPack,
    updateActivePetPackManifest,
    getActiveCreatorPackManifest,
    validateActiveCreatorPackManifestMutation,
    applyActiveCreatorPackManifestMutation,
    setActivePack,
    removePack
  }
}

module.exports = {
  BUILT_IN_PACK_ID,
  createPetPackService,
  isSafePackId,
  normalizePetPackSettings
}
