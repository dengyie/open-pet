const http = require('node:http')
const https = require('node:https')

const postRepair = async (url, { method, headers, signal, body }) => {
  const endpoint = new URL(url)
  const transport = endpoint.protocol === 'https:' ? https : http
  const response = await new Promise((resolve, reject) => {
    const request = transport.request(endpoint, { method, headers, signal, timeout: 0 }, resolve)
    request.on('error', reject)
    request.end(body)
  })
  const chunks = []
  for await (const chunk of response) chunks.push(chunk)
  const status = response.statusCode
  return { ok: status >= 200 && status < 300, status, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }
}

const callBridge = async (route, payload = {}, { signal } = {}) => {
  const hasCommandBridge = process.env.OPENPET_BRIDGE_URL && process.env.OPENPET_BRIDGE_TOKEN
  const baseUrl = hasCommandBridge ? process.env.OPENPET_BRIDGE_URL : process.env.OPENPET_SERVICE_BRIDGE_URL
  const token = hasCommandBridge ? process.env.OPENPET_BRIDGE_TOKEN : process.env.OPENPET_SERVICE_BRIDGE_TOKEN
  if (!baseUrl || !token) throw new Error('OpenPet bridge is not available')
  const post = route === '/creator/repair' ? postRepair : fetch
  const response = await post(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    signal,
    body: JSON.stringify(payload)
  })
  const body = await response.json()
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error || `OpenPet bridge request failed: ${response.status}`)
    const errorCode = String(body.errorCode || body.code || '').trim()
    if (/^[a-z0-9][a-z0-9_]{0,79}$/.test(errorCode)) error.code = errorCode
    if (typeof body.retryable === 'boolean') error.retryable = body.retryable
    if (Array.isArray(body?.errorDetails?.modelAttempts)) {
      error.modelAttempts = body.errorDetails.modelAttempts
    }
    throw error
  }
  return body
}

module.exports = { callBridge }
