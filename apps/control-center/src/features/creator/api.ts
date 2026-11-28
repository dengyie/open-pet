import * as v from '../../../../desktop/src/shared/browser-validation.ts'
import type { Job } from '@openpet/contracts'
import { backendClient } from '../../api/backend-client.ts'
import { controlCenterAPI } from '../../api/control-center-api.ts'
import type { ApiClient } from '../../api/client.ts'
import type {
  CreatorAssetPreviewRequest,
  CreatorAssetPreviewResult,
  CreatorBindReferenceRequest,
  CreatorBindReferenceResult,
  CreatorExportRecoveryBundleRequest,
  CreatorExportRecoveryBundleResult,
  CreatorGenerateExistingActionRequest,
  CreatorGenerateNewCharacterRequest,
  CreatorImportAvailableActionsRequest,
  CreatorLastRunResult,
  CreatorLastRunViewState,
  CreatorReferencePickerResult,
  CreatorRetryActionRequest,
  CreatorRetryIdentityRequest,
  CreatorStateViewState,
  CreatorWorkflowResult
} from '@openpet/shared/src/openpet-contracts.ts'

const object = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

const firstText = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && value.trim().length > 0) || ''

const backendRunState = (status: string): CreatorLastRunViewState['state'] => {
  switch (status) {
    case 'cancelled': return 'cancelled'
    case 'generating': return 'generating'
    case 'awaiting_identity_review': return 'awaiting-identity-review'
    case 'ready_for_review':
    case 'approved': return 'review-required'
    case 'failed':
    case 'recovery-required': return 'recovery-required'
    case 'imported':
    case 'completed': return 'completed'
    default: return 'missing-input'
  }
}

const normalizePersistedRun = (value: unknown): CreatorLastRunViewState | null => {
  if (!object(value) || !object(value.state)) return null
  const persisted = value.state
  const runId = firstText(value.runId, persisted.runId, value.id)
  if (!runId) return null
  return {
    runId,
    state: backendRunState(firstText(value.status, persisted.status)),
    mode: firstText(value.mode, persisted.mode),
    commandId: firstText(persisted.commandId),
    message: firstText(persisted.message, persisted.error),
    importedActionId: firstText(persisted.importedActionId),
    importedPackId: firstText(persisted.importedPackId),
    activatedPackId: firstText(persisted.activatedPackId),
    diagnostics: (value.diagnostics ?? persisted.diagnostics) as CreatorLastRunViewState['diagnostics']
  }
}

type CreatorProgressRun = CreatorLastRunViewState & { jobId?: string }
type CreatorState = CreatorStateViewState & {
  lastRun: CreatorProgressRun | null
  desktopLastRun?: CreatorProgressRun
}

export function creatorProgressRun(
  state: CreatorState,
  jobId: string,
  runId = ''
): CreatorProgressRun | null {
  return [state.desktopLastRun, state.lastRun].find((run) =>
    run && (!runId || run.runId === runId) &&
      (run.jobId ? run.jobId === jobId : Boolean(runId))
  ) ?? null
}

const stateSchema = v.custom<CreatorState>((value) => (
  object(value) && value.ok === true && object(value.provider) && object(value.hatchPetAgent)
    && object(value.editableTarget) && object(value.dashboard)
))
const lastRunSchema = v.custom<CreatorLastRunResult>((value) => (
  object(value) && value.ok === true && (value.run === null || object(value.run))
))
const workflowSchema = v.custom<CreatorWorkflowResult>((value) => (
  object(value) && value.ok === true && typeof value.state === 'string' && typeof value.code === 'string'
    && typeof value.message === 'string'
))
const bindSchema = v.custom<CreatorBindReferenceResult>((value) => (
  object(value) && value.ok === true && typeof value.replaced === 'boolean' && object(value.reference)
))
const previewSchema = v.custom<CreatorAssetPreviewResult>((value) => (
  object(value) && typeof value.ok === 'boolean' && typeof value.previewDataUrl === 'string'
    && typeof value.relativePath === 'string'
))
const exportSchema = v.custom<CreatorExportRecoveryBundleResult>((value) => (
  object(value) && typeof value.ok === 'boolean' && typeof value.runId === 'string'
    && typeof value.relativePath === 'string' && typeof value.sha256 === 'string'
    && typeof value.byteSize === 'number'
))
const jobStartSchema = v.object({ jobId: v.pipe(v.string(), v.minLength(1)) })

export type CreatorJobStart = { jobId: string } | { result: CreatorWorkflowResult | CreatorExportRecoveryBundleResult }
export type CreatorJobResolution =
  | { kind: 'pending' }
  | { kind: 'succeeded'; result: CreatorWorkflowResult | CreatorExportRecoveryBundleResult }
  | { kind: 'cancelled'; result: CreatorWorkflowResult }
  | { kind: 'failed'; message: string }

export function resolveCreatorJob(job: Job | null): CreatorJobResolution {
  if (!job || job.status === 'queued' || job.status === 'running') return { kind: 'pending' }
  if (job.status === 'succeeded') {
    const parsedWorkflow = v.safeParse(workflowSchema, job.result)
    if (parsedWorkflow.success) return { kind: 'succeeded', result: parsedWorkflow.output }
    const result = job.result
    if (object(result) && result.ok === true && object(result.repair) &&
      result.repair.scope === 'action' && result.repair.actionId === 'running-left' && typeof result.message === 'string') {
      const run = normalizePersistedRun(result.run)
      if (run) return { kind: 'succeeded', result: {
        ok: true, state: run.state, code: 'action_repair_review_required', message: result.message,
        run, diagnostics: run.diagnostics
      } }
    }
    const parsedExport = v.safeParse(exportSchema, job.result)
    if (parsedExport.success) return { kind: 'succeeded', result: parsedExport.output }
    return { kind: 'failed', message: 'Creator Job returned an invalid result.' }
  }
  if (job.status === 'canceled') {
    const workflow = v.safeParse(workflowSchema, job.result)
    if (workflow.success && workflow.output.state === 'cancelled') return { kind: 'cancelled', result: workflow.output }
    return { kind: 'failed', message: 'Creator Job was canceled.' }
  }
  return { kind: 'failed', message: job.error?.message || 'Creator Job failed or was interrupted.' }
}

export function createCreatorHttpApi(client: ApiClient = backendClient) {
  const request = <T>(method: string, path: string, responseSchema: v.GenericSchema<unknown, T>, body?: unknown, job = false): Promise<T> => (
    body === undefined
      ? client.request({ method, path, responseSchema, retry: method === 'GET' })
      : client.request({ method, path, requestSchema: v.unknown(), body, responseSchema, job, retry: false })
  )
  return {
    getState: async () => {
      const state = await request('GET', '/creator/state', stateSchema)
      return { ...state, lastRun: normalizePersistedRun(state.lastRun) ?? state.lastRun }
    },
    getLastRun: async () => {
      const result = await request('GET', '/creator/last-run', lastRunSchema)
      return { ...result, run: normalizePersistedRun(result.run) ?? result.run }
    },
    bindReference: (body: CreatorBindReferenceRequest) => request('POST', '/creator/references', bindSchema, body),
    deleteReference: (body: CreatorBindReferenceRequest) => request('DELETE', `/creator/references?targetType=${encodeURIComponent(body.targetType)}&targetId=${encodeURIComponent(body.targetId)}`, v.custom<{ deleted: boolean }>((value) => object(value) && value.deleted === true)),
    generateNewCharacter: (body: CreatorGenerateNewCharacterRequest) => request('POST', '/creator/characters/generate', jobStartSchema, body, true),
    generateExistingAction: (body: CreatorGenerateExistingActionRequest) => request('POST', '/creator/sprites/generate', jobStartSchema, body, true),
    retryAction: (body: CreatorRetryActionRequest) => request('POST', `/creator/runs/${encodeURIComponent(body.runId)}/retry-action`, jobStartSchema, body, true),
    retryIdentity: (body: CreatorRetryIdentityRequest) => request('POST', `/creator/runs/${encodeURIComponent(body.runId)}/retry-identity`, jobStartSchema, body, true),
    acceptIdentity: (body: Record<string, unknown>) => request('POST', `/creator/runs/${encodeURIComponent(String(body.runId || ''))}/accept-identity`, jobStartSchema, body, true),
    acceptActionCandidate: (body: Record<string, unknown>) => request('POST', `/creator/runs/${encodeURIComponent(String(body.runId || ''))}/accept-action-candidate`, jobStartSchema, body, true),
    exportRecoveryBundle: (body: CreatorExportRecoveryBundleRequest) => request('POST', '/creator/export', jobStartSchema, body, true),
    importAvailableActions: (body: CreatorImportAvailableActionsRequest) => request('POST', `/creator/runs/${encodeURIComponent(body.runId)}/import-actions`, jobStartSchema, body, true),
    getAssetPreview: (body: CreatorAssetPreviewRequest) => request('GET', `/creator/assets/preview?runId=${encodeURIComponent(body.runId)}&relativePath=${encodeURIComponent(body.relativePath)}`, previewSchema),
    pickReferenceImage: (): Promise<CreatorReferencePickerResult> => controlCenterAPI.pickCreatorReferenceImage(),
  }
}

const httpApi = createCreatorHttpApi()
const useDemoApi = () => import.meta.env?.DEV === true && !Boolean((globalThis as { openpetBackend?: unknown }).openpetBackend)
const demoApi = controlCenterAPI

export const creatorApi = {
  getState: () => useDemoApi() ? demoApi.getCreatorState() : httpApi.getState(),
  getLastRun: () => useDemoApi() ? demoApi.getCreatorLastRun() : httpApi.getLastRun(),
  bindReference: (body: CreatorBindReferenceRequest) => useDemoApi() ? demoApi.bindCreatorReference(body) : httpApi.bindReference(body),
  generateNewCharacter: async (body: CreatorGenerateNewCharacterRequest): Promise<CreatorJobStart> => useDemoApi()
    ? { result: await demoApi.generateCreatorNewCharacter(body) } : httpApi.generateNewCharacter(body),
  generateExistingAction: async (body: CreatorGenerateExistingActionRequest): Promise<CreatorJobStart> => useDemoApi()
    ? { result: await demoApi.generateCreatorExistingAction(body) } : httpApi.generateExistingAction(body),
  retryAction: async (body: CreatorRetryActionRequest): Promise<CreatorJobStart> => useDemoApi()
    ? { result: await demoApi.retryCreatorAction(body) } : httpApi.retryAction(body),
  retryIdentity: async (body: CreatorRetryIdentityRequest): Promise<CreatorJobStart> => useDemoApi()
    ? { result: await demoApi.retryCreatorIdentity(body) } : httpApi.retryIdentity(body),
  acceptIdentity: async (body: Record<string, unknown>): Promise<CreatorJobStart> => useDemoApi()
    ? { result: await demoApi.acceptCreatorIdentity(body as any) } : httpApi.acceptIdentity(body),
  acceptActionCandidate: async (body: Record<string, unknown>): Promise<CreatorJobStart> => useDemoApi()
    ? { result: await demoApi.acceptCreatorActionCandidate(body as any) } : httpApi.acceptActionCandidate(body),
  exportRecoveryBundle: async (body: CreatorExportRecoveryBundleRequest): Promise<CreatorJobStart> => useDemoApi()
    ? { result: await demoApi.exportCreatorRecoveryBundle(body) } : httpApi.exportRecoveryBundle(body),
  importAvailableActions: async (body: CreatorImportAvailableActionsRequest): Promise<CreatorJobStart> => useDemoApi()
    ? { result: await demoApi.importCreatorAvailableActions(body) } : httpApi.importAvailableActions(body),
  getAssetPreview: (body: CreatorAssetPreviewRequest) => useDemoApi() ? demoApi.getCreatorAssetPreview(body) : httpApi.getAssetPreview(body),
  pickReferenceImage: () => httpApi.pickReferenceImage()
}

export { jobStartSchema, stateSchema, workflowSchema, exportSchema }
