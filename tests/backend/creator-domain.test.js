"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const sharp = require("sharp")
const { createMessageHandler } = require("../../apps/desktop/src/sidecar/message-handler")

async function fixture() {
	const [{ openDatabase }, { migrate }, { createCreatorDomain }] = await Promise.all([
		import("../../services/backend/store/db.js"),
		import("../../services/backend/store/migrate.js"),
		import("../../services/backend/domains/creator/index.js"),
	])
	const db = await openDatabase({ file: ":memory:" })
	migrate({ db })
	const requests = []
	const queued = []
	const shell = {
		request: async (request) => {
			requests.push(request)
			return {
				body: {
					type: "creator.result",
					operation: request.operation,
					ok: true,
					result: request.operation === "bind-reference"
						? { reference: { fileName: "front.png", relativePath: "runs/run-1/inputs/front.png", contentHash: "a".repeat(64), width: 128, height: 128 } }
						: { run: { runId: "run-1", mode: "single-action", status: "completed", sourcePath: "/private/secret.png" } },
			},
			}
		},
	}
	const creator = createCreatorDomain({ db, shell, enqueueJob: (input) => { queued.push(input); return { id: input.id } } })
	return { db, creator, requests, queued }
}

test("Creator domain persists flow/reference metadata without absolute paths or tokens", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const flow = ctx.creator.createFlow({ name: "default", config: { apiKey: "sk-secret", prompt: "front" } })
	assert.equal(flow.config.apiKey, "[redacted]")
	assert.equal(ctx.creator.listFlows()[0].config.apiKey, "[redacted]")
	const bound = await ctx.creator.bindReference({ targetType: "editable-action-host", targetId: "legacy-editable-host", referenceToken: "opaque-token" })
	assert.equal(bound.reference.relativePath, "runs/run-1/inputs/front.png")
	assert.equal(ctx.requests[0].payload.referenceToken, "opaque-token")
	const persisted = ctx.db.prepare("SELECT token_hash, relative_path, metadata_json FROM creator_references").get()
	assert.equal(persisted.token_hash, require("node:crypto").createHash("sha256").update("opaque-token").digest("hex"))
	assert.equal(persisted.relative_path.includes("/"), true)
	assert.equal(persisted.metadata_json.includes("/private"), false)
})

test("Creator jobs keep secret input in memory and persist only redacted payload", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const queued = ctx.creator.enqueueCharacter({ characterName: "Cat", stylePrompt: "clean", referenceImageToken: "opaque-token" })
	assert.equal(queued.jobId, ctx.queued[0].id)
	assert.deepEqual(ctx.queued[0].input, {
		operation: "creator.character",
		flowId: "",
		characterName: "Cat",
		stylePrompt: "clean",
	})
	assert.equal(ctx.creator.getJobInput(queued.jobId).referenceImageToken, "opaque-token")
})

test("Creator result serialization strips absolute paths from public run state", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const state = await ctx.creator.getState()
	assert.equal(JSON.stringify(state).includes("/private/secret.png"), false)
})

test("Creator state resolves through the Shell bridge and preserves structured errors", async (t) => {
	const [
		{ openDatabase }, { migrate }, { createCreatorDomain }, { createShellClient },
	] = await Promise.all([
		import("../../services/backend/store/db.js"),
		import("../../services/backend/store/migrate.js"),
		import("../../services/backend/domains/creator/index.js"),
		import("../../services/backend/bridge/shell-client.js"),
	])
	const db = await openDatabase({ file: ":memory:" })
	t.after(() => db.close())
	migrate({ db })

	const warnings = []
	const state = { ok: true, lastRun: null, dashboard: { available: true } }
	let sent
	let unavailable = false
	const shell = createShellClient({
		send: (envelope) => { sent = envelope },
		logger: { warn: (_message, details) => warnings.push(details) },
	})
	t.after(() => shell.dispose())
	const handler = createMessageHandler({
		send: shell.receive,
		onCreatorRequest: (request) => {
			assert.deepEqual(request, { operation: "get-state", payload: {} })
			if (unavailable) throw Object.assign(new Error("Creator unavailable"), { code: "BACKEND_UNAVAILABLE" })
			return state
		},
	})
	const creator = createCreatorDomain({ db, shell })

	const pending = creator.getState()
	void pending.catch(() => {})
	assert.equal(await handler.handle(sent), true)
	assert.deepEqual(warnings, [])
	assert.deepEqual(await pending, state)

	unavailable = true
	const rejected = assert.rejects(creator.getState(), { code: "BACKEND_UNAVAILABLE", message: "Creator unavailable" })
	assert.equal(await handler.handle(sent), true)
	assert.deepEqual(warnings, [])
	await rejected
})

test("Desktop Creator jobs can finish after the dialog deadline or be canceled while the shell is busy", { timeout: 5_000 }, async (t) => {
	const [
		{ openDatabase }, { migrate }, { createCreatorDomain }, { createShellClient }, { DIALOG_RESULT_TIMEOUT_MS },
		{ createCreatorJobHandlers }, { createJobsRepository }, { createQueue }, { createRunner },
	] = await Promise.all([
		import("../../services/backend/store/db.js"),
		import("../../services/backend/store/migrate.js"),
		import("../../services/backend/domains/creator/index.js"),
		import("../../services/backend/bridge/shell-client.js"),
		import("../../services/backend/bridge/message-schema.js"),
		import("../../services/backend/jobs/handlers/creator.js"),
		import("../../services/backend/store/repositories/jobs.js"),
		import("../../services/backend/jobs/queue.js"),
		import("../../services/backend/jobs/runner.js"),
	])
	const db = await openDatabase({ file: ":memory:" })
	t.after(() => db.close())
	migrate({ db })
	t.mock.timers.enable({ apis: ["setTimeout"] })

	const result = {
		state: "preview-ready",
		run: { runId: "slow-character", mode: "full-pet", state: "preview-ready" },
		availableActionIds: ["idle"],
	}
	const { promise: dispatched, resolve: dispatch } = Promise.withResolvers()
	const { promise: started, resolve: start } = Promise.withResolvers()
	const { promise: cancelDispatched, resolve: dispatchCancelable } = Promise.withResolvers()
	const { promise: cancelStarted, resolve: startCancelable } = Promise.withResolvers()
	const { promise: providerAborted, resolve: abortProvider } = Promise.withResolvers()
	const { promise: allowLateResult, resolve: releaseLateResult } = Promise.withResolvers()
	const shellReplies = []
	const cancels = []
	const lateResult = { ...result, run: { ...result.run, runId: "canceled-character" } }
	const shell = createShellClient({ send: (envelope) => {
		if (envelope.body.type === "creator.cancel") {
			cancels.push(envelope)
			void handler.handle(envelope)
			return
		}
		if (envelope.body.payload.characterName === "Cancel Cat") dispatchCancelable(envelope)
		else dispatch(envelope)
	} })
	t.after(() => shell.dispose())
	const handler = createMessageHandler({
		send: (envelope) => {
			shellReplies.push(envelope)
			shell.receive(envelope)
		},
		onCreatorRequest: async ({ operation, payload }, { signal }) => {
			assert.equal(operation, "generate-character")
			if (payload.characterName === "Cancel Cat") {
				const provider = new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true })
				})
				startCancelable()
				await assert.rejects(provider, { name: "AbortError" })
				abortProvider()
				await allowLateResult
				return lateResult
			}
			const generation = new Promise((resolve) => setTimeout(resolve, DIALOG_RESULT_TIMEOUT_MS + 1_000))
			start()
			await generation
			return result
		},
	})
	const repo = createJobsRepository({ db })
	const queue = createQueue({ repo })
	const creator = createCreatorDomain({ db, shell, enqueueJob: (input) => queue.enqueue(input) })
	const runner = createRunner({ repo, queue, handlers: createCreatorJobHandlers({ creator }) })

	const { jobId } = creator.enqueueCharacter({ characterName: "Cat", referenceImageToken: "opaque-token" })
	const running = runner.run()
	const handling = handler.handle(await dispatched)
	await started
	t.mock.timers.tick(DIALOG_RESULT_TIMEOUT_MS + 1)
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(repo.byId(jobId).status, "running")

	t.mock.timers.tick(999)
	assert.equal(await handling, true)
	assert.equal((await running).status, "succeeded")
	assert.deepEqual(repo.byId(jobId).result, result)

	const shortRequest = assert.rejects(creator.getState(), { code: "PROVIDER_TIMEOUT" })
	t.mock.timers.tick(DIALOG_RESULT_TIMEOUT_MS)
	await shortRequest

	const { jobId: canceledJobId } = creator.enqueueCharacter({
		characterName: "Cancel Cat",
		referenceImageToken: "opaque-token",
	})
	const cancelable = runner.run()
	const request = await cancelDispatched
	const lateHandling = handler.handle(request)
	await cancelStarted
	const cancellation = runner.cancel(canceledJobId)
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(repo.byId(canceledJobId).status, "canceled")
	assert.equal((await cancellation).status, "canceled")
	await cancelable

	assert.deepEqual(cancels.map(({ id, body }) => ({ id, body })), [{ id: request.id, body: { type: "creator.cancel" } }])
	await providerAborted
	releaseLateResult()
	t.mock.timers.tick(DIALOG_RESULT_TIMEOUT_MS + 1_000)
	assert.equal(await lateHandling, true)
	assert.equal(shellReplies.some(({ id }) => id === request.id), false)
	const unsolicited = []
	shell.on("creator.result", (reply) => unsolicited.push(reply))
	shell.receive({ ...request, body: { type: "creator.result", operation: "generate-character", ok: true, result: lateResult } })
	assert.deepEqual(unsolicited, [])
	assert.equal(repo.byId(canceledJobId).status, "canceled")
	assert.equal(repo.byId(canceledJobId).result, null)
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM creator_runs WHERE id = ?").get("canceled-character").count, 0)
})

test("Shell native approval revocation cancels the Create Job without dropping its workflow result", async (t) => {
	const { db } = await fixture()
	t.after(() => db.close())
	const [{ createCreatorDomain }, { createJobsRepository }, { createQueue }, { createRunner }, { createCreatorJobHandlers }] = await Promise.all([
		import("../../services/backend/domains/creator/index.js"),
		import("../../services/backend/store/repositories/jobs.js"),
		import("../../services/backend/jobs/queue.js"),
		import("../../services/backend/jobs/runner.js"),
		import("../../services/backend/jobs/handlers/creator.js"),
	])
	const result = {
		ok: true, state: "cancelled", code: "native_execution_revoked", message: "Native execution approval revoked.",
		run: { runId: "interrupted-run", mode: "full-pet", state: "cancelled", commandId: "retry-action" },
		diagnostics: { runStatus: "cancelled", progress: { availableActionIds: ["idle"] } },
	}
	const shell = {
		request: async ({ operation }) => ({
			body: { type: "creator.result", operation, ok: true, result },
		}),
	}
	const repo = createJobsRepository({ db })
	const queue = createQueue({ repo })
	const creator = createCreatorDomain({ db, shell, enqueueJob: (input) => queue.enqueue(input) })
	const events = []
	const runner = createRunner({ repo, queue, handlers: createCreatorJobHandlers({ creator }), emit: (event) => events.push(event) })
	const { jobId } = creator.enqueueWorkflow({ runId: result.run.runId, operation: "retry-action", actionId: "waving" })

	await runner.run()

	const job = repo.byId(jobId)
	assert.equal(job.status, "canceled")
	assert.equal(job.progress.phase, "canceled")
	assert.ok(job.progress.percent < 100)
	assert.equal(job.progress.message, result.message)
	assert.deepEqual(job.result, result)
	assert.ok(events.includes("job.canceled"))
	assert.ok(!events.includes("job.succeeded"))
	assert.equal(db.prepare("SELECT status FROM creator_runs WHERE id = ?").get(result.run.runId).status, "cancelled")
})

test("Retained Desktop Creator action repairs outlive the dialog deadline and can be canceled", async (t) => {
	const { db } = await fixture()
	t.after(() => db.close())
	const [{ createCreatorDomain }, { createShellClient }, { DIALOG_RESULT_TIMEOUT_MS }] = await Promise.all([
		import("../../services/backend/domains/creator/index.js"),
		import("../../services/backend/bridge/shell-client.js"),
		import("../../services/backend/bridge/message-schema.js"),
	])
	t.mock.timers.enable({ apis: ["setTimeout"] })
	let sent
	const shell = createShellClient({ send: (envelope) => { sent = envelope } })
	t.after(() => shell.dispose())
	const runId = "retained-shell-run"
	const result = { run: { runId, mode: "full-pet", state: "preview-ready" }, availableActionIds: ["jumping"] }
	const handler = createMessageHandler({
		send: shell.receive,
		onCreatorRequest: async ({ operation, payload }) => {
			assert.equal(operation, "retry-action")
			assert.equal(payload.runId, runId)
			return result
		},
	})
	const creator = createCreatorDomain({ db, shell })
	const input = { operation: "retry-action", runId, actionId: "jumping" }
	const repair = creator.runWorkflow(input)
	void repair.catch(() => {})
	t.mock.timers.tick(DIALOG_RESULT_TIMEOUT_MS + 1)
	assert.equal(await handler.handle(sent), true)
	assert.deepEqual(await repair, result)

	const controller = new AbortController()
	const canceled = assert.rejects(creator.runWorkflow(input, { signal: controller.signal }), { name: "AbortError" })
	controller.abort()
	t.mock.timers.tick(DIALOG_RESULT_TIMEOUT_MS)
	await canceled
})

test("Creator asset preview round-trips without bypassing metadata redaction", async (t) => {
	const [
		{ openDatabase }, { migrate }, { createCreatorDomain }, { createShellClient },
	] = await Promise.all([
		import("../../services/backend/store/db.js"),
		import("../../services/backend/store/migrate.js"),
		import("../../services/backend/domains/creator/index.js"),
		import("../../services/backend/bridge/shell-client.js"),
	])
	const db = await openDatabase({ file: ":memory:" })
	t.after(() => db.close())
	migrate({ db })
	const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "orange" } }).png({ compressionLevel: 0 }).toBuffer()
	const dataUrl = `data:image/png;base64,${png.toString("base64")}`
	assert.ok(dataUrl.length > 12_000)
	const request = { runId: "run-1", relativePath: "runs/run-1/sprites.png" }
	const response = { ok: true, previewDataUrl: dataUrl, message: "x".repeat(12_000), sourcePath: "/private/sprites.png", apiKey: "test-secret" }
	const shell = createShellClient({ send: (envelope) => { void handler.handle(envelope) } })
	t.after(() => shell.dispose())
	const handler = createMessageHandler({
		send: shell.receive,
		onCreatorRequest: (body) => {
			assert.deepEqual(body, { operation: "asset-preview", payload: request })
			return response
		},
	})
	const creator = createCreatorDomain({ db, shell })
	const result = await creator.getAssetPreview(request)
	assert.equal(result.previewDataUrl.length, dataUrl.length)
	assert.equal(result.previewDataUrl, dataUrl)
	assert.equal(result.message, "x".repeat(8_000))
	assert.equal(result.sourcePath, "[path-redacted]")
	assert.equal(result.apiKey, "[redacted]")

	response.previewDataUrl = `data:image/png;base64,${Buffer.alloc(1_500_001).toString("base64")}`
	await assert.rejects(creator.getAssetPreview(request), { code: "CONFLICT" })
	for (const previewDataUrl of ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,not!base64"]) {
		response.previewDataUrl = previewDataUrl
		await assert.rejects(creator.getAssetPreview(request), { code: "INTERNAL" })
	}
})

test("Backend Creator reads terminal state from the validated plugin run file", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-creator-run-state-sync-"))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const runId = "run-disk-failed"
	const runDir = path.join(dataDir, "runs", runId)
	fs.mkdirSync(runDir, { recursive: true })
	fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
		runId,
		status: "failed",
		currentStep: "final-package",
		reviewStatus: "pending",
		importStatus: "not-imported",
		error: "visual-defect-board-unreadable",
		backendStatus: { state: "failed", message: "visual-defect-board-unreadable" },
	}))
	ctx.db.prepare("INSERT INTO creator_runs (id, owner, flow_id, mode, status, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run(runId, "desktop", null, "full-pet", "awaiting_identity_review", JSON.stringify({ runId, creatorExecution: "backend" }), 1, 2)
	const creator = (await import("../../services/backend/domains/creator/index.js")).createCreatorDomain({
		db: ctx.db,
		creatorDataDir: () => dataDir,
		runPluginCommand: async () => { throw new Error("not expected") },
	})
	const state = await creator.getState()
	assert.equal(state.backendLastRun.status, "failed")
	assert.equal(state.backendLastRun.state.currentStep, "final-package")
	assert.equal(state.backendLastRun.state.error, "visual-defect-board-unreadable")
	assert.equal(state.backendLastRun.diagnostics.runStatus, "failed")
	const last = await creator.getLastRun()
	assert.equal(last.run.status, "failed")
})

test("Creator reference deletion is delegated to Shell before metadata removal", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	ctx.db.prepare("INSERT INTO creator_references (id, owner, target_type, target_id, token_hash, file_name, width, height, content_hash, relative_path, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run("ref-1", "desktop", "editable-action-host", "legacy-editable-host", "hash", "front.png", 1, 1, "", "runs/front.png", "{}", 1, 1)
	const result = await ctx.creator.deleteReference({ targetType: "editable-action-host", targetId: "legacy-editable-host" })
	assert.deepEqual(result, { deleted: true, targetType: "editable-action-host", targetId: "legacy-editable-host" })
	assert.equal(ctx.requests.at(-1).operation, "delete-reference")
	assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM creator_references").get().count, 0)
})

test("Creator backend image mode owns generation and persists a reviewable image artifact", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const calls = []
	const ai = {
		createWebImageInput: (input, jobId) => {
			calls.push(["input", input, jobId])
			return { ...input, output: { dataDir: "/data", dataRelativeDir: `creator-web/runs/${jobId}` } }
		},
		prepareGeneratedImage: async (input, options) => {
			calls.push(["prepare", input, options])
			return { result: { ok: true, outputs: [{ dataRelativePath: "creator-web/runs/job-1/0001.png", mimeType: "image/png", sha256: "b".repeat(64) }] }, tmpDir: "/tmp/job-1", destination: input.output }
		},
		commitGeneratedImage: async (prepared) => {
			calls.push(["commit", prepared])
			return prepared.result
		},
	}
	const creator = (await import("../../services/backend/domains/creator/index.js")).createCreatorDomain({
		db: ctx.db,
		shell: ctx.creator ? { request: ctx.creator.authority } : null,
		ai,
		enqueueJob: (input) => { ctx.queued.push(input); return { id: input.id } },
	})
	const result = await creator.runCharacter({
		backend: "web",
		jobId: "job-1",
		characterName: "Mango Fox",
		stylePrompt: "orange fox",
		referenceImage: { mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3egAAAAASUVORK5CYII=" },
	}, { job: { id: "job-1" }, tmpDir: "/tmp/job-1", report() {}, finalize: async (fn) => fn() })
	assert.equal(result.run.status, "ready_for_review")
	assert.equal(result.run.mode, "web-image")
	assert.equal(result.run.state.generatedImage.outputs[0].dataRelativePath, "creator-web/runs/job-1/0001.png")
	assert.equal(calls[0][0], "input")
	assert.equal(calls.at(-1)[0], "commit")
})

test("Backend web Creator submits a retained reference and the complete quality-first pet task", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-creator-backend-flow-"))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const calls = []
	const shellCalls = []
	const creator = (await import("../../services/backend/domains/creator/index.js")).createCreatorDomain({
		db: ctx.db,
		shell: { request: async (request) => {
			shellCalls.push(request)
			return { body: { type: "creator.result", operation: request.operation, ok: true, result: { run: { runId: "run-web-1", mode: "full-pet", status: "imported" } } } }
		} },
		creatorDataDir: () => dataDir,
		runPluginCommand: async (command, payload) => {
			calls.push({ command, payload })
			return command === "create-run"
				? { run: { runId: "run-web-1", status: "draft" } }
				: { run: { runId: "run-web-1", status: "awaiting_identity_review", creatorExecution: "backend" }, message: "Identity candidates ready" }
		},
	})
	const result = await creator.runCharacter({
		backend: "web",
		characterName: "Mango Fox",
		stylePrompt: "orange fox",
		referenceImage: { mimeType: "image/png", fileName: "fox.png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3egAAAAASUVORK5CYII=" },
	})
	assert.deepEqual(calls.map(({ command }) => command), ["create-run", "run-step"])
	assert.equal(calls[0].payload.creatorExecution, "backend")
	assert.equal(calls[0].payload.generationTask.mode, "full-pet")
	assert.equal(calls[0].payload.generationTask.pipeline, "quality-first-v1")
	assert.deepEqual(calls[0].payload.generationTask.actions.map(({ actionId }) => actionId), ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"])
	const referencePath = path.join(dataDir, calls[0].payload.referenceImage.relativePath)
	assert.equal(fs.existsSync(referencePath), true)
	assert.equal(result.run.id, "run-web-1")
	assert.equal(result.run.state.creatorExecution, "backend")
	await creator.runWorkflow({ runId: "run-web-1", operation: "import-actions", activate: true })
	assert.equal(shellCalls.at(-1).operation, "import-actions")
	const persistedLastRun = await creator.getLastRun()
	assert.equal(persistedLastRun.backendLastRun.id, "run-web-1")
	assert.equal(persistedLastRun.backendLastRun.state.creatorExecution, "backend")
})

test("Backend web Creator can continue from a hash-verified generated image artifact", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-creator-generated-reference-"))
	const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-creator-generated-reference-plugin-"))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	t.after(() => fs.rmSync(pluginDataDir, { recursive: true, force: true }))
	const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
	const relativePath = "creator-web/runs/image-generate:123e4567-e89b-12d3-a456-426614174000/0001.png"
	const outputPath = path.join(dataDir, relativePath)
	fs.mkdirSync(path.dirname(outputPath), { recursive: true })
	fs.writeFileSync(outputPath, bytes)
	const { createAiService } = require("../../services/backend/domains/ai/image-generation.js")
	const ai = createAiService({
		settings: { read: () => ({ version: 1, values: { models: { imageGeneration: {} } } }), patch: () => ({}) },
		secrets: { get: () => "" },
		userDataDir: dataDir,
	})
	const calls = []
	const creator = (await import("../../services/backend/domains/creator/index.js")).createCreatorDomain({
		db: ctx.db,
		ai,
		creatorDataDir: () => pluginDataDir,
		runPluginCommand: async (command, payload) => {
			calls.push({ command, payload })
			return command === "create-run"
				? { run: { runId: "run-generated-1", status: "draft" } }
				: { run: { runId: "run-generated-1", status: "awaiting_identity_review", creatorExecution: "backend" } }
		},
	})
	const sha256 = require("node:crypto").createHash("sha256").update(bytes).digest("hex")
	assert.deepEqual([...creator.referencedImageContentHashes()], [])
	const result = await creator.runCharacter({
		backend: "web",
		characterName: "Mango Fox",
		stylePrompt: "orange fox",
		generatedImage: { relativePath, sha256 },
	})
	assert.deepEqual(calls.map(({ command }) => command), ["create-run", "run-step"])
	assert.equal(result.run.id, "run-generated-1")
	assert.deepEqual([...creator.referencedImageContentHashes()], [sha256])
	const reference = calls[0].payload.referenceImage
	assert.equal(reference.fileName, "0001.png")
	assert.deepEqual(fs.readFileSync(path.join(pluginDataDir, reference.relativePath)), bytes)
	await assert.rejects(() => creator.runCharacter({
		backend: "web",
		characterName: "Mango Fox",
		stylePrompt: "orange fox",
		generatedImage: { relativePath, sha256: "0".repeat(64) },
	}), /changed after preview/)
})

test("Backend Creator refuses to stage browser references through a symlink", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-creator-reference-symlink-plugin-"))
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-creator-reference-symlink-outside-"))
	t.after(() => fs.rmSync(pluginDataDir, { recursive: true, force: true }))
	t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }))
	fs.symlinkSync(outsideDir, path.join(pluginDataDir, "incoming"), "dir")
	let pluginCalls = 0
	const creator = (await import("../../services/backend/domains/creator/index.js")).createCreatorDomain({
		db: ctx.db,
		creatorDataDir: () => pluginDataDir,
		runPluginCommand: async () => { pluginCalls += 1; return { run: { runId: "unexpected", status: "draft" } } },
	})
	await assert.rejects(() => creator.runCharacter({
		backend: "web",
		characterName: "Mango Fox",
		stylePrompt: "orange fox",
		referenceImage: { mimeType: "image/png", dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") },
	}), /staging directory is invalid/)
	assert.equal(pluginCalls, 0)
	assert.deepEqual(fs.readdirSync(outsideDir), [])
})

test("Backend Creator verifies retained recovery bundles without calling a nonexistent plugin command", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-creator-recovery-"))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const calls = []
	const runId = "run-web-recovery"
	const recoveryRelativePath = `runs/${runId}/recovery/recovery.json`
	const recoveryBody = JSON.stringify({ version: 1, runId, files: [] })
	const recoveryHash = require("node:crypto").createHash("sha256").update(recoveryBody).digest("hex")
	const recoveryPath = path.join(dataDir, recoveryRelativePath)
	fs.mkdirSync(path.dirname(recoveryPath), { recursive: true })
	fs.writeFileSync(recoveryPath, recoveryBody)
	fs.writeFileSync(path.join(dataDir, "runs", runId, "run.json"), JSON.stringify({
		runId,
		qualityFirst: { recovery: { relativePath: recoveryRelativePath, sha256: recoveryHash } },
	}))
	const creator = (await import("../../services/backend/domains/creator/index.js")).createCreatorDomain({
		db: ctx.db,
		creatorDataDir: () => dataDir,
		runPluginCommand: async (command) => {
			calls.push(command)
			if (command === "create-run") return { run: { runId, status: "draft" } }
			if (command === "run-step") return { run: { runId, status: "recovery-required", creatorExecution: "backend" } }
			throw new Error(`Creator Studio command is not declared: ${command}`)
		},
	})
	await creator.runCharacter({
		backend: "web",
		characterName: "Mango Fox",
		stylePrompt: "orange fox",
		referenceImage: { mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3egAAAAASUVORK5CYII=" },
	})
	const result = await creator.runExport({ runId }, { finalize: async (commit) => commit() })
	assert.deepEqual(calls, ["create-run", "run-step"])
	assert.equal(result.ok, true)
	assert.equal(result.code, "recovery_bundle_ready")
	assert.equal(result.runId, runId)
	assert.equal(result.relativePath, recoveryRelativePath)
	assert.equal(result.sha256, recoveryHash)
	assert.equal(result.byteSize, Buffer.byteLength(recoveryBody))
	assert.equal(result.run.state.creatorExecution, "backend")
})

test("Backend Creator retry progress does not lock the new Job to the prior run's terminal percentage", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	t.mock.timers.enable({ apis: ["setInterval"] })
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-creator-retry-progress-"))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const runId = "run-retry-progress"
	const runDir = path.join(dataDir, "runs", runId)
	fs.mkdirSync(runDir, { recursive: true })
	const runPath = path.join(runDir, "run.json")
	const writeRun = (status, phase) => fs.writeFileSync(runPath, JSON.stringify({
		runId, status, currentStep: "idle", qualityFirst: { phase, actionResults: {} },
	}))
	writeRun("recovery-required", "recovery-required")
	const frames = []
	const { createProgressThrottle } = await import("../../services/backend/jobs/progress.js")
	const throttle = createProgressThrottle({ onEmit: (frame) => frames.push(frame) })
	const creator = (await import("../../services/backend/domains/creator/index.js")).createCreatorDomain({
		db: ctx.db,
		creatorDataDir: () => dataDir,
		runPluginCommand: async () => {
			writeRun("generating", "generating-idle")
			t.mock.timers.tick(1_500)
			assert.equal(frames.at(-1).percent, 30)
			assert.notEqual(frames.at(-1).phase, "资产恢复")
			return { run: { runId, status: "ready_for_review", creatorExecution: "backend" } }
		},
	})
	await creator.runWorkflow({ runId, operation: "retry-action", actionId: "idle" }, { report: throttle.report })
})

test("Backend Creator retries force a fresh Hatch budget window", async (t) => {
	const ctx = await fixture()
	t.after(() => ctx.db.close())
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-creator-retry-budget-window-"))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const runId = "run-retry-budget-window"
	const renewals = []
	const creator = (await import("../../services/backend/domains/creator/index.js")).createCreatorDomain({
		db: ctx.db,
		creatorDataDir: () => dataDir,
		runPluginCommand: async () => ({ run: { runId, status: "ready_for_review", creatorExecution: "backend" } }),
		hatchPetAgent: () => ({ renewBudgetWindow: (input) => { renewals.push(input) } }),
	})

	await creator.runWorkflow({ runId, operation: "retry-action", actionId: "idle" })

	assert.deepEqual(renewals, [{ runId, reason: "retry-action", force: true }])
})
