const { LOCAL_PLUGIN_COMMAND_TIMEOUT_MS } = require('./local-plugin-runner-client')
const { createPluginProcessEnv, resolvePluginProcessLaunch } = require('./plugin-process-support')
const {
  sanitizePluginCommandResultValue,
  sanitizePluginCommandText
} = require('./plugin-runtime-safety')

const MAX_PLUGIN_COMMAND_OUTPUT_BYTES = 64 * 1024

const appendLimitedOutput = (current, chunk, maxBytes = MAX_PLUGIN_COMMAND_OUTPUT_BYTES) => {
  const next = `${current}${String(chunk || '')}`
  return next.length > maxBytes ? next.slice(0, maxBytes) : next
}

const parseJsonLine = (line) => {
  try {
    return JSON.parse(line)
  } catch (_) {
    return null
  }
}

const readCommandResult = (stdoutText) => {
  const lines = String(stdoutText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonLine(lines[index])
    if (parsed && typeof parsed === 'object') return parsed
  }
  return null
}

const runPluginCommandEntryProcess = async ({
  plugin,
  commandEntry,
  commandId,
  payload,
  config,
  runtimeKey,
  commandRuntimes,
  commandBridgeRuntimes,
  commandBridgeServer,
  createPluginBridgeRunId,
  createPluginBridgeToken,
  createPluginBridgeKey,
  createPluginBridgeHandlers,
  createPluginCreatorDirs,
  cloneJsonValue,
  resolveCommandCwd,
  beforeSpawn,
  signal,
  spawnCommandProcess,
  stopRuntimeProcessWithFallback,
  resolveStopWaiter,
  appendLog,
  commandProcessTimeoutMs = LOCAL_PLUGIN_COMMAND_TIMEOUT_MS,
  transformParsedResult = (parsedResult) => parsedResult
}) => {
  const pluginId = plugin.manifest.id
  const { file, args, runAsNode } = resolvePluginProcessLaunch(commandEntry.command)
  const cwd = resolveCommandCwd(plugin.manifest, commandEntry.cwd)
  await commandBridgeServer.ensureStarted()
  if (signal?.aborted) {
    commandBridgeServer.unrefWhenIdle()
    signal.throwIfAborted()
  }
  const bridgeRunId = createPluginBridgeRunId()
  const bridgeToken = createPluginBridgeToken()
  const bridgeRuntimeKey = createPluginBridgeKey(pluginId, commandId, bridgeRunId)
  const bridgeBaseUrl = commandBridgeServer.createBridgeBaseUrl({ pluginId, commandId, runId: bridgeRunId })
  const creatorDirs = createPluginCreatorDirs(plugin.manifest)
  const commandContext = {
    pluginId,
    commandId,
    payload: cloneJsonValue(payload, 'payload', { allowUndefined: true }),
    config: cloneJsonValue(config, 'config'),
    ...(pluginId === 'openpet.agent-awareness'
      ? {
          runtime: {
            nativeExecutionApproved: true
          }
        }
      : {}),
    paths: {
      extensionDir: cwd
    }
  }
  beforeSpawn?.()
  const child = spawnCommandProcess(file, args, {
    cwd,
    detached: false,
    env: {
      ...createPluginProcessEnv({ runAsNode }),
      OPENPET_DATA_DIR: creatorDirs.dataDir,
      OPENPET_CACHE_DIR: creatorDirs.cacheDir,
      OPENPET_LOG_DIR: creatorDirs.logDir,
      OPENPET_BRIDGE_URL: bridgeBaseUrl,
      OPENPET_BRIDGE_TOKEN: bridgeToken
    },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const runtime = {
    pluginId,
    commandId,
    status: 'running',
    pid: Number(child.pid) || 0,
    error: '',
    child,
    stop: null,
    failStop: null,
    stopCompleted: null,
    resolveStopCompleted: null
  }
  const bridgeAbort = new AbortController()
  commandBridgeRuntimes.set(bridgeRuntimeKey, {
    pluginId,
    commandId,
    runId: bridgeRunId,
    token: bridgeToken,
    status: 'running',
    signal: bridgeAbort.signal,
    handlers: createPluginBridgeHandlers(plugin, commandId, bridgeRunId)
  })
  commandRuntimes.set(runtimeKey, runtime)
  let stdoutText = ''
  let stderrText = ''

  return new Promise((resolve, reject) => {
    let settled = false
    const safeKillChild = () => {
      try {
        child.kill?.('SIGTERM')
      } catch (_) {}
    }
    const settle = (callback) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (timeoutId) clearTimeout(timeoutId)
      commandRuntimes.delete(runtimeKey)
      commandBridgeRuntimes.delete(bridgeRuntimeKey)
      commandBridgeServer.unrefWhenIdle()
      callback()
    }
    runtime.failStop = (error) => {
      settle(() => {
        resolveStopWaiter(runtime)
        reject(error)
      })
    }
    let stopError
    runtime.stop = ({ reason = 'Command stopped', code, signal = 'SIGTERM' } = {}) => {
      runtime.status = 'stopping'
      runtime.error = ''
      stopError = Object.assign(new Error(reason), { code, openpetLogged: true })
      bridgeAbort.abort(stopError)
      stopRuntimeProcessWithFallback(runtime, signal)
      return true
    }
    const onAbort = () => {
      if (!stopError) runtime.stop({ reason: 'Creator job canceled' })
    }
    const rejectStopped = () => {
      if (!stopError) return false
      runtime.status = 'failed'
      runtime.error = stopError.message
      appendLog({ pluginId, commandId, level: 'error', message: runtime.error })
      reject(stopError)
      return true
    }
    const timeoutMs = Number.isFinite(Number(commandEntry?.timeoutMs))
      ? Math.max(0, Number(commandEntry.timeoutMs))
      : Number.isFinite(Number(commandProcessTimeoutMs))
        ? Math.max(0, Number(commandProcessTimeoutMs))
      : LOCAL_PLUGIN_COMMAND_TIMEOUT_MS
    const timeoutId = timeoutMs > 0
      ? setTimeout(() => {
          settle(() => {
            resolveStopWaiter(runtime)
            if (rejectStopped()) return
            safeKillChild()
            reject(new Error(`Plugin command timed out after ${timeoutMs}ms`))
          })
        }, timeoutMs)
      : null
    timeoutId?.unref?.()

    child.stdout?.on?.('data', (chunk) => {
      stdoutText = appendLimitedOutput(stdoutText, chunk)
      const message = sanitizePluginCommandText(chunk)
      if (message) appendLog({ pluginId, commandId, level: 'info', message: `Command stdout: ${message}`.slice(0, 500) })
    })
    child.stderr?.on?.('data', (chunk) => {
      stderrText = appendLimitedOutput(stderrText, chunk)
      const message = sanitizePluginCommandText(chunk)
      if (message) appendLog({ pluginId, commandId, level: 'error', message: `Command stderr: ${message}`.slice(0, 500) })
    })
    child.on?.('error', (error) => {
      settle(() => {
        resolveStopWaiter(runtime)
        if (rejectStopped()) return
        reject(new Error(sanitizePluginCommandText(error?.message || 'Plugin command failed')))
      })
    })
    child.stdin?.on?.('error', (error) => {
      settle(() => {
        resolveStopWaiter(runtime)
        if (rejectStopped()) return
        safeKillChild()
        reject(new Error(sanitizePluginCommandText(error?.message || 'Plugin command stdin failed')))
      })
    })
    child.on?.('exit', (code, signal) => {
      settle(() => {
        resolveStopWaiter(runtime)
        const exitCode = Number.isFinite(Number(code)) ? Number(code) : null
        if (rejectStopped()) return
        if (exitCode !== 0 || signal) {
          const parsedResult = readCommandResult(stdoutText)
          const parsedError = parsedResult && typeof parsedResult === 'object' && typeof parsedResult.error === 'string'
            ? sanitizePluginCommandText(parsedResult.error)
            : ''
          const message = parsedError || (signal ? `Plugin command exited with signal ${signal}` : `Plugin command exited with code ${exitCode ?? 'unknown'}`)
          const error = new Error(message)
          if (parsedError && /^[a-z0-9][a-z0-9_]{0,79}$/.test(parsedResult.code || '')) error.code = parsedResult.code
          reject(error)
          return
        }
        const parsedResult = transformParsedResult(readCommandResult(stdoutText))
        const sanitizedParsedResult = sanitizePluginCommandResultValue(parsedResult)
        resolve({
          ok: true,
          pluginId,
          commandId,
          exitCode,
          ...(sanitizedParsedResult ? { result: sanitizedParsedResult } : {}),
          ...(!sanitizedParsedResult && stdoutText.trim() ? { stdout: sanitizePluginCommandText(stdoutText.trim()) } : {}),
          ...(stderrText.trim() ? { stderr: sanitizePluginCommandText(stderrText.trim()) } : {})
        })
      })
    })

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    try {
      child.stdin?.end?.(`${JSON.stringify(commandContext)}\n`)
    } catch (error) {
      settle(() => {
        resolveStopWaiter(runtime)
        safeKillChild()
        reject(error)
      })
    }
  })
}

module.exports = {
  appendLimitedOutput,
  readCommandResult,
  runPluginCommandEntryProcess
}
