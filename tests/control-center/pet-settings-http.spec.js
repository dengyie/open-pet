const { test, expect } = require('@playwright/test')

test('a Home anchor notification preserves a draft size preview and updates the save version', async ({ page }) => {
  const home = { enabled: true, radius: 'medium', anchor: { displayId: '1', x: 100, y: 200 } }
  let snapshot = { version: 1, values: { scale: 1, petBehavior: { grounded: true, home } } }
  const previews = []
  const patches = []
  await page.route(/\/api\/v1\/settings(?:\/preview-scale)?$/, async (route) => {
    const request = route.request()
    let data = snapshot
    if (request.method() === 'POST') {
      data = request.postDataJSON()
      previews.push(data.scale)
    } else if (request.method() === 'PATCH') {
      const body = request.postDataJSON()
      patches.push(body)
      snapshot = { version: snapshot.version + 1, values: { ...snapshot.values, ...body.patch } }
      data = { version: snapshot.version, changedPaths: Object.keys(body.patch) }
    }
    await route.fulfill({ json: { ok: true, data, meta: { requestId: 'pet-settings-browser', elapsedMs: 1 } } })
  })
  await page.addInitScript(() => {
    window.openpetBackend = { getBackend: () => ({ baseUrl: location.origin + '/api/v1', sessionToken: 'pet-settings-fixture' }) }
    const fetch = window.fetch.bind(window)
    window.settingsEventStreams = new Set()
    window.fetch = async (url, init) => {
      if (!String(url).includes('/api/v1/events?')) return fetch(url, init)
      return new Response(new ReadableStream({ start(controller) {
        window.settingsEventStreams.add(controller)
        init.signal.addEventListener('abort', () => window.settingsEventStreams.delete(controller), { once: true })
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
  })
  await page.goto('/')
  await expect(page.getByRole('switch', { name: 'Enable home anchor' })).toHaveAttribute('aria-checked', 'true')
  const scale = page.getByRole('slider', { name: 'Pet size' })
  await scale.evaluate((input) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '135')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect.poll(() => previews).toEqual([1.35])
  await expect.poll(() => page.evaluate(() => window.settingsEventStreams.size)).toBeGreaterThan(0)

  snapshot = { version: 2, values: { scale: 1, petBehavior: { grounded: true, home: { ...home, anchor: { displayId: '1', x: 350, y: 200 } } } } }
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/v1/settings') && response.request().method() === 'GET')
  await page.evaluate(() => {
    const event = new TextEncoder().encode('id: 2\nevent: settings.changed\ndata: {"version":2,"paths":["petBehavior.home.anchor"]}\n\n')
    for (const stream of window.settingsEventStreams) stream.enqueue(event)
  })
  await (await refreshed).finished()
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect.poll(() => patches, { message: 'saving must preserve the preview and use the refreshed version' }).toEqual([
    { ifVersion: 2, patch: { scale: 1.35 } }
  ])
  await expect(scale).toHaveValue('135')
})
