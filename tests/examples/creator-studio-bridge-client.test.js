const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { setTimeout: delay } = require('node:timers/promises')

const { callBridge } = require('../../examples/plugins/creator-studio/lib/bridge-client')

test('creator repair waits for delayed headers without the fetch deadline and respects abort', async (t) => {
  let requestStarted
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, '/studio/creator/repair')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, 'Bearer service-token')
    assert.equal(request.headers['x-openpet-creator-studio-repair-token'], 'caller-token')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { command: 'retry-action' })
    requestStarted?.()
    await delay(50)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, result: { repaired: true } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  t.mock.property(process, 'env', {
    ...process.env,
    OPENPET_BRIDGE_URL: undefined,
    OPENPET_BRIDGE_TOKEN: undefined,
    OPENPET_SERVICE_BRIDGE_URL: `http://127.0.0.1:${server.address().port}/studio`,
    OPENPET_SERVICE_BRIDGE_TOKEN: 'service-token'
  })
  t.mock.method(globalThis, 'fetch', async () => {
    await delay(10)
    throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })
  })

  const payload = { command: 'retry-action' }
  assert.deepEqual(await callBridge('/creator/repair', payload, { repairToken: 'caller-token' }), { ok: true, result: { repaired: true } })

  const started = new Promise((resolve) => { requestStarted = resolve })
  const controller = new AbortController()
  const pending = callBridge('/creator/repair', payload, { signal: controller.signal, repairToken: 'caller-token' })
  await started
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('creator bridge client uses the service-scoped endpoint and token in the dashboard', async (t) => {
  t.mock.property(process, 'env', {
    ...process.env,
    OPENPET_BRIDGE_URL: 'http://127.0.0.1:1234/unused-command',
    OPENPET_BRIDGE_TOKEN: undefined,
    OPENPET_SERVICE_BRIDGE_URL: 'http://127.0.0.1:1234/studio',
    OPENPET_SERVICE_BRIDGE_TOKEN: 'service-token'
  })
  const config = { model: 'gpt-image-2' }
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, config }))
  assert.deepEqual(await callBridge('/creator/model-settings'), { ok: true, config })
  assert.equal(fetch.mock.calls[0].arguments[0], 'http://127.0.0.1:1234/studio/creator/model-settings')
  assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, 'Bearer service-token')
})

test('creator bridge client preserves structured provider attempt diagnostics', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      ok: false,
      error: 'Image Provider generation failed with HTTP 524',
      code: 'video_provider_network_error',
      retryable: true,
      errorDetails: {
        modelAttempts: [{
          model: 'gpt-image-2',
          ok: false,
          errorCode: 'provider_http_error',
          httpStatus: 524,
          timeoutMs: 120000,
          durationMs: 119000,
          requestId: 'request-524'
        }]
      }
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const previousUrl = process.env.OPENPET_BRIDGE_URL
  const previousToken = process.env.OPENPET_BRIDGE_TOKEN
  process.env.OPENPET_BRIDGE_URL = `http://127.0.0.1:${address.port}`
  process.env.OPENPET_BRIDGE_TOKEN = 'bridge-token'

  try {
    await assert.rejects(() => callBridge('/creator/model-image-generate'), (error) => {
      assert.equal(error.code, 'video_provider_network_error')
      assert.equal(error.retryable, true)
      assert.deepEqual(error.modelAttempts, [{
        model: 'gpt-image-2',
        ok: false,
        errorCode: 'provider_http_error',
        httpStatus: 524,
        timeoutMs: 120000,
        durationMs: 119000,
        requestId: 'request-524'
      }])
      return true
    })
  } finally {
    if (previousUrl === undefined) delete process.env.OPENPET_BRIDGE_URL
    else process.env.OPENPET_BRIDGE_URL = previousUrl
    if (previousToken === undefined) delete process.env.OPENPET_BRIDGE_TOKEN
    else process.env.OPENPET_BRIDGE_TOKEN = previousToken
    await new Promise((resolve) => server.close(resolve))
  }
})
