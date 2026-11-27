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

for (const scenario of ['keeps the review and recovery controls', 'shows saved repairs', 'keeps preview and pending retries']) test(`Create ${scenario} after native approval is revoked during action retry`, async ({ page }) => {
  const repairSaved = scenario === 'shows saved repairs'
  const retainedPreview = scenario === 'keeps preview and pending retries'
  const reviewRun = { runId, state: retainedPreview ? 'completed' : 'review-required', mode: 'full-pet' }
  const cancelledRun = { ...reviewRun, state: 'cancelled', commandId: 'retry-action' }
  let retried = false
  let retryPayload
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace('/api/v1', '')
    let data
    let status = 200
    switch (pathname) {
      case '/creator/state':
        data = {
          ok: true, provider: { ready: true }, editableTarget: {}, dashboard,
          hatchPetAgent: { ok: true },
          lastRun: retried ? cancelledRun : reviewRun
        }
        break
      case '/creator/characters/generate':
        status = 202
        data = { jobId: 'review-job' }
        break
      case '/jobs/review-job':
        data = {
          jobId: 'review-job', status: 'succeeded',
          result: {
            ok: true, state: reviewRun.state, code: 'review_required', message: 'Ready for review',
            run: reviewRun, availableActionIds: ['idle'], failedActionIds: ['waving'],
            ...(retainedPreview ? { clickAction: 'idle', importedAction: { actionId: 'idle', label: 'Idle' } } : {})
          }
        }
        break
      case `/creator/runs/${runId}/retry-action`:
        retryPayload = request.postDataJSON()
        retried = true
        status = 202
        data = { jobId: 'retry-job' }
        break
      case '/jobs/retry-job':
        data = {
          jobId: 'retry-job', status: 'canceled',
          result: {
            ok: true, state: 'cancelled', code: 'native_execution_revoked',
            message: 'Native execution approval was revoked; generation cancelled.',
            run: cancelledRun,
            ...(repairSaved || retainedPreview ? {
              availableActionIds: repairSaved ? ['idle', 'waving'] : ['idle'],
              failedActionIds: [],
              diagnostics: {
                progress: {
                  runStatus: 'cancelled',
                  failureReason: 'Native execution approval was revoked; generation cancelled.',
                  actions: [
                    { actionId: 'idle', status: 'passed', importable: true },
                    repairSaved ? {
                      actionId: 'waving', status: 'passed', importable: true,
                      assets: [{ kind: 'row', relativePath: `runs/${runId}/waving/repaired.png`, label: 'Saved waving candidate' }]
                    } : { actionId: 'waving', status: 'pending', importable: false }
                  ]
                }
              }
            } : {})
          }
        }
        break
      default:
        return route.abort()
    }
    await route.fulfill({ status, json: { ok: true, data, meta: { requestId: 'retry-http-test', elapsedMs: 1 } } })
  })
  await page.addInitScript(() => {
    window.openpetBackend = { getBackend: () => ({ baseUrl: location.origin + '/api/v1', sessionToken: 'retry-http-test' }) }
  })
  await page.goto('/')
  await page.evaluate(async () => {
    const { demoControlCenterAPI } = await import('/src/api/demo-control-center-api.ts')
    window.controlCenterAPI = demoControlCenterAPI
  })
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByLabel('Character name').fill('Retry Cat')
  await page.getByTestId('creator-new-reference-input').click()
  await page.getByTestId('creator-generate-new-character').click()

  const result = page.getByTestId('creator-result')
  const retry = result.getByTestId('creator-retry-failed-actions')
  const importAvailable = result.getByTestId('creator-import-available-actions')
  const preview = result.getByTestId('creator-preview-result')
  if (retainedPreview) await expect(preview).toBeEnabled()
  else await expect(importAvailable).toHaveText('导入可用动作（1）')
  await retry.click()
  await expect(result).toContainText('Native execution approval was revoked; generation cancelled.')
  if (retainedPreview) {
    await expect(result.getByTestId('creator-action-chip-waving')).toHaveAttribute('data-status', 'pending')
    await expect(retry).toBeEnabled()
    await expect(preview).toBeEnabled()
  } else {
    await expect(result).toContainText('需要复查')
    await expect(importAvailable).toBeEnabled()
  }
  if (repairSaved) {
    await expect(result.getByTestId('creator-progress')).toContainText('Run status cancelled')
    await expect(result.getByTestId('creator-progress-failure')).toContainText('取消原因')
    await expect(importAvailable).toHaveText('导入可用动作（2）')
    await expect(result.getByTestId('creator-action-chip-waving')).toHaveAttribute('data-status', 'passed')
    await expect(result.getByTestId('creator-asset-review')).toContainText('Saved waving candidate')
    await expect(retry).toHaveCount(0)
  } else {
    await expect(retry).toBeEnabled()
  }
  expect(retryPayload.actionId).toBe('waving')
})

for (const resumePackage of [false, true]) test(`Create offers ${resumePackage ? 'packaging recovery' : 'mirror-only recovery'} for the latest interrupted run after refresh`, async ({ page }) => {
  let retryPayload
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace('/api/v1', '')
    if (pathname === '/creator/state') {
      const data = {
        ok: true, provider: { ready: true }, editableTarget: {}, dashboard, hatchPetAgent: { ok: true },
        lastRun: {
          id: runId, status: 'cancelled', state: { runId, creatorExecution: 'backend', status: 'cancelled' }, mode: 'full-pet', diagnostics: {
            runStatus: 'cancelled', progress: {
              qualityFirst: { pipeline: 'quality-first-v1' },
              ...(resumePackage ? { canResumeRunningLeftPackage: true } : {}),
              actions: [{ actionId: 'running-right', status: 'passed' }, { actionId: 'running-left', status: resumePackage ? 'mirrored' : 'pending' }]
            }
          }
        }
      }
      return route.fulfill({ json: { ok: true, data, meta: { requestId: 'mirror-test', elapsedMs: 1 } } })
    }
    if (pathname === `/creator/runs/${runId}/retry-action`) {
      retryPayload = request.postDataJSON()
      return route.fulfill({ status: 202, json: { ok: true, data: { jobId: 'mirror-job' }, meta: { requestId: 'mirror-test', elapsedMs: 1 } } })
    }
    if (pathname === '/jobs/mirror-job') {
      const data = {
        jobId: 'mirror-job', status: 'succeeded',
        result: {
          ok: true, message: 'Repaired action running-left',
          run: { id: runId, status: 'ready_for_review', mode: 'full-pet', state: { creatorExecution: 'backend' } },
          repair: { scope: 'action', actionId: 'running-left' }
        }
      }
      return route.fulfill({ json: { ok: true, data, meta: { requestId: 'mirror-test', elapsedMs: 1 } } })
    }
    return route.abort()
  })
  await page.addInitScript(() => {
    window.openpetBackend = { getBackend: () => ({ baseUrl: location.origin + '/api/v1', sessionToken: 'mirror-test' }) }
  })
  await page.goto('/')
  await page.evaluate(async () => {
    const { demoControlCenterAPI } = await import('/src/api/demo-control-center-api.ts')
    window.controlCenterAPI = demoControlCenterAPI
  })
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const latestRun = page.getByTestId('creator-last-run')
  await expect(latestRun).toContainText(`Run ID ${runId}`)
  await expect(latestRun).toContainText('State 已取消')
  const recover = latestRun.getByTestId('creator-recover-running-left')
  if (resumePackage) await expect(recover).toHaveText('继续打包已保存的跑步动作')
  await recover.click()
  const result = page.getByTestId('creator-result')
  await expect(result).toContainText('Repaired action running-left')
  await expect(result).toContainText('需要复查')
  expect(retryPayload?.actionId).toBe('running-left')
})

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
