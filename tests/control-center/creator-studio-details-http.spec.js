const { test, expect } = require('@playwright/test')

const pluginId = 'openpet.creator-studio'
const runId = 'details-regression'
const run = { runId, state: 'review-required', mode: 'single-action' }
const dashboard = { available: true, pluginId, dashboardId: 'main' }
const plugin = {
  id: pluginId,
  name: 'Creator Studio',
  version: '1.0.0',
  source: 'bundled',
  enabled: true,
  requiresNativeExecution: true,
  nativeExecutionApproved: true,
  entries: {
    services: [{ id: 'studio' }],
    dashboards: [{ id: 'main', title: 'Creator Studio' }]
  }
}

for (const [pane, initiallyRunning] of [['Create', false], ['Plugins', false], ['Create', true], ['Plugins', true]]) {
  const scenario = initiallyRunning ? 'opens the native dashboard without restarting Creator Studio' : 'starts Creator Studio over HTTP before opening its native dashboard'
  test(`${pane} ${scenario}`, async ({ page }) => {
    const operations = []
    let running = initiallyRunning
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const path = url.pathname.replace('/api/v1', '')
      let data
      let status = 200
      if (path === '/creator/state') {
        data = { ok: true, provider: { ready: true }, hatchPetAgent: {}, editableTarget: {}, editableReference: {}, dashboard: { ...dashboard, serviceStatus: running ? 'running' : 'stopped' } }
      } else if (path === '/creator/sprites/generate') {
        data = { jobId: runId }
        status = 202
      } else if (path === `/jobs/${runId}`) {
        data = { jobId: runId, status: 'succeeded', result: { ok: true, state: run.state, code: run.state, message: 'Ready for review', run } }
      } else if (path === '/plugins') {
        data = { items: [plugin] }
      } else if (path === '/plugins/openpet.im-gateway/config') {
        data = {}
      } else if (path === `/plugins/${pluginId}/logs`) {
        data = { items: [] }
      } else if (path === `/plugins/${pluginId}/start`) {
        const operation = url.searchParams.get('operation')
        operations.push([request.method(), operation, request.postDataJSON()])
        if (operation === null && running) {
          return route.fulfill({
            status: 503,
            json: { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'Plugin production request failed' } }
          })
        }
        if (operation === null) running = true
        const health = { status: running ? (operation === 'health' ? 'healthy' : 'unknown') : 'unhealthy' }
        data = { ok: true, pluginId, serviceId: 'studio', health, runtime: { status: running ? 'running' : 'stopped', health } }
      } else {
        return route.abort()
      }
      await route.fulfill({ status, json: { ok: true, data, meta: { requestId: 'details-http-test', elapsedMs: 1 } } })
    })

    await page.addInitScript(() => {
      window.openpetBackend = { getBackend: () => ({ baseUrl: location.origin + '/api/v1', sessionToken: 'details-http-test' }) }
    })
    await page.goto('/')
    await page.exposeFunction('recordDashboardOpen', (...args) => operations.push(['dashboard', ...args]))
    await page.evaluate(async () => {
      const { demoControlCenterAPI } = await import('/src/api/demo-control-center-api.ts')
      const { startPluginService, checkPluginServiceHealth, ...nativeApi } = demoControlCenterAPI
      window.controlCenterAPI = {
        ...nativeApi,
        openPluginDashboard: (id, dashboardId, options) => window.recordDashboardOpen(id, dashboardId, options)
      }
    })

    await page.getByRole('button', { name: pane, exact: true }).click()
    if (pane === 'Create') {
      await page.getByTestId('creator-mode-existing').click()
      await page.getByLabel('Action name').fill('Wave')
      await page.getByLabel('Motion prompt').fill('Wave once')
      await page.getByTestId('creator-generate-existing-action').click()
      await page.getByRole('button', { name: initiallyRunning ? '打开 Creator Studio 详情' : '启动并打开 Creator Studio 详情' }).click()
    } else {
      await page.getByRole('button', { name: '启动并查看任务详情' }).click()
    }

    const health = ['POST', 'health', { serviceId: 'studio' }]
    const start = ['POST', null, { serviceId: 'studio' }]
    await expect.poll(() => operations).toEqual([
      ...(!initiallyRunning && pane === 'Plugins' ? [health] : []),
      ...(!initiallyRunning ? [start] : []),
      health,
      ['dashboard', pluginId, 'main', pane === 'Create' ? { query: { runId } } : undefined]
    ])
  })
}
