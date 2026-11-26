const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { createAiSidecarProxy } = require('../../apps/desktop/src/services/ai-sidecar-proxy')
const { createPluginCommandBridgeServer, createPluginBridgeKey } = require('../../apps/desktop/src/services/plugin-command-bridge-server')
const { callBridge } = require('../../examples/plugins/creator-studio/lib/bridge-client')

async function setup(t, { providerResponse } = {}) {
  const { createAiDomain } = await import('../../services/backend/domains/ai/core.js')
  const { createEmptyState } = await import('../../services/backend/domains/ai/talk-store.js')
  const { createRouter } = await import('../../services/backend/http/router.js')
  const middleware = await import('../../services/backend/http/middleware.js')
  const { registerAiRuntimeRoutes } = await import('../../services/backend/routes/ai-runtime.js')
  let state = createEmptyState()
  let settings = { version: 0, values: { ai: {
    enabled: true,
    provider: 'openai-compatible',
    baseUrl: 'https://chat.example/v1',
    model: 'chat-model',
    vision: { mode: 'override', provider: 'openai-compatible', baseUrl: 'https://vision.example/v1', model: 'vision-model', apiKeyRef: 'ai.vision' }
  } } }
  const calls = []
  const patches = []
  const failures = []
  const providerLogs = []
  const domain = createAiDomain({
    repository: { loadState: () => structuredClone(state), commitState: (next) => { state = structuredClone(next) } },
    settings: { read: () => structuredClone(settings) },
    mutationAuthority: { patch: (request) => {
      assert.equal(request.ifVersion, settings.version)
      patches.push(request)
      settings = { version: settings.version + 1, values: { ...settings.values, ...request.patch } }
    } },
    secrets: { get: (ref) => ({ 'ai.default': 'chat-secret', 'ai.vision': 'vision-secret', 'ai.hatch-pet': 'hatch-secret', 'other-secret': 'unrelated-secret' })[ref] || '' },
    getActivePetPack: async () => ({ manifest: { id: 'cat', displayName: 'Cat', actions: [] } }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (providerResponse) return providerResponse()
      return Response.json({ choices: [{ message: { content: 'ok', tool_calls: [{ type: 'function', function: { name: 'inspect', arguments: '{"ok":true}' } }] }, finish_reason: 'tool_calls' }] })
    },
    logger: {
      warn: (message, details) => failures.push({ message, details }),
      error: (message, details) => providerLogs.push({ message, details }),
    },
  })
  const router = createRouter({ basePath: '/api/v1' })
  router.use(middleware.requestId())
  router.use(middleware.errorBoundary())
  router.use(middleware.bearerAuth({ getSessionToken: () => 'session' }))
  router.use(middleware.jsonBody())
  registerAiRuntimeRoutes(router, { getDomain: () => domain })
  const server = createServer((req, res) => void router.handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await domain.dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`
  return { domain, calls, patches, failures, providerLogs, baseUrl, send: (path, body, method = 'POST') => fetch(`${baseUrl}${path}`, {
    method, headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) }
}

const request = { messages: [{ role: 'user', content: 'inspect' }], tool: { type: 'function', function: { name: 'inspect', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } } }

test('HTTP completions reject caller-owned provider routing before invoking any provider', async (t) => {
  const { send, calls } = await setup(t)
  for (const override of [{ configOverride: { baseUrl: 'https://untrusted.example/v1', apiKeyRef: 'other-secret', model: 'x' } }, { apiKeyRef: 'other-secret' }, { signal: {} }]) {
    const response = await send('/ai/completions', { method: 'completeStructuredTool', request: { ...request, ...override } })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'VALIDATION_FAILED')
  }
  assert.equal(calls.length, 0)
})

test('Hatch completions resolve the latest configuration and its canonical secret in the backend', async (t) => {
  const { send, calls, patches } = await setup(t)
  const config = await send('/ai/hatch/config', { config: { configMode: 'override', baseUrl: 'https://hatch.example/v1', provider: 'openai-compatible', model: 'hatch-model' } }, 'PATCH')
  assert.equal(config.status, 200)
  assert.equal(patches.length, 1)
  const response = await send('/ai/completions', { method: 'completeStructuredTool', capability: 'hatch-pet', request })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://hatch.example/v1/chat/completions')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer hatch-secret')
  assert.equal(JSON.parse(calls[0].options.body).model, 'hatch-model')
  assert.equal(JSON.stringify(await config.json()).includes('hatch-secret'), false)
})

test('Hatch visual evaluations use the backend-owned vision configuration', async (t) => {
  const { send, calls } = await setup(t)
  const response = await send('/ai/completions', { method: 'completeStructuredTool', capability: 'hatch-pet-vision', request })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://vision.example/v1/chat/completions')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer vision-secret')
  assert.equal(JSON.parse(calls[0].options.body).model, 'vision-model')
})

test('Hatch completions distinguish upstream HTTP failures from invalid tool arguments without leaking response data', async (t) => {
  const responses = [
    [Response.json({ error: { message: 'private provider payload' } }, { status: 503 }), { category: 'provider_http', upstreamStatus: 503 }],
    [Response.json({ error: { message: 'private provider payload' } }, { status: 429 }), { category: 'provider_http', upstreamStatus: 429 }],
    [Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'inspect', arguments: 'private provider payload' } }] } }] }), { category: 'tool_arguments' }],
    [Object.assign(new Error('private provider payload'), { name: 'TimeoutError' }), { category: 'provider_timeout' }],
    [new Error('private provider payload'), { category: 'internal' }],
  ]
  let index = 0
  const { send, failures, providerLogs } = await setup(t, { providerResponse: () => {
    const [response] = responses[index++]
    if (response instanceof Error) throw response
    return response
  } })
  for (const [, completionError] of responses) {
    const response = await send('/ai/completions', { method: 'completeStructuredTool', capability: 'hatch-pet-vision', request })
    assert.equal(response.status, 500)
    const { error } = await response.json()
    assert.equal(error.code, 'INTERNAL')
    assert.equal(error.message, '后端内部错误')
    assert.deepEqual(error.details, { completionError })
    assert.deepEqual(failures.at(-1)?.details, { method: 'completeStructuredTool', capability: 'hatch-pet-vision', completionError })
  }
  assert.doesNotMatch(JSON.stringify([...failures, ...providerLogs]), /private provider payload/)
})

test('Creator evaluator bridge preserves completion categories in Desktop and resident Backend modes', async (t) => {
  const { domain, baseUrl } = await setup(t, { providerResponse: () => new Response(null, { status: 503 }) })
  const { createPluginRuntimeServer } = await import('../../services/backend/bridge/plugin-runtime-server.js')
  const pluginId = 'creator-studio'
  const commandId = 'evaluate'
  const runId = 'test-run'
  const token = 'test-token'
  const { hatchAiService } = createAiSidecarProxy({ getBackend: () => ({ baseUrl, sessionToken: 'session' }) })
  const desktop = createPluginCommandBridgeServer({ commandBridgeRuntimes: new Map([
    [createPluginBridgeKey(pluginId, commandId, runId), {
      token, status: 'running',
      handlers: { creatorHatchPetEvaluate: (_payload, { signal }) => hatchAiService.completeStructuredVisionTool({ ...request, signal }) },
    }],
  ]) })
  await desktop.ensureStarted()
  t.after(() => desktop.close())
  const backend = createPluginRuntimeServer({
    plugins: { get: () => ({ id: pluginId, permissions: ['model:image-generate'] }) },
    creator: {
      hatchPetEvaluate: (_pluginId, _payload, { signal }) => domain.complete({ method: 'completeStructuredTool', capability: 'hatch-pet-vision', request }, { signal }),
    },
  })
  const resident = await backend.listen({ pluginId, token })
  t.after(() => backend.close())
  const previousUrl = process.env.OPENPET_BRIDGE_URL
  const previousToken = process.env.OPENPET_BRIDGE_TOKEN
  try {
    process.env.OPENPET_BRIDGE_TOKEN = token
    for (const bridgeUrl of [desktop.createBridgeBaseUrl({ pluginId, commandId, runId }), resident.url]) {
      process.env.OPENPET_BRIDGE_URL = bridgeUrl
      await assert.rejects(() => callBridge('/creator/hatch-pet/evaluate'), (error) => {
        assert.equal(error.message, '后端内部错误')
        assert.deepEqual(error.completionError, { category: 'provider_http', upstreamStatus: 503 })
        return true
      })
    }
  } finally {
    if (previousUrl === undefined) delete process.env.OPENPET_BRIDGE_URL
    else process.env.OPENPET_BRIDGE_URL = previousUrl
    if (previousToken === undefined) delete process.env.OPENPET_BRIDGE_TOKEN
    else process.env.OPENPET_BRIDGE_TOKEN = previousToken
  }
})
