import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_SPARSE_CHECKOUT_RUNTIME_CAPABILITY,
  TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { startFederatedWorker } from './federated-worker-start'

describe('federated Trae launch preferences', () => {
  const databases: OrchestrationDb[] = []
  const selection = {
    agent: 'trae',
    model: 'gpt-5.6-sol',
    effort: 'high',
    backendVariant: 'max'
  }

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  function setup(
    options: { legacy?: boolean; effective?: typeof selection | null; sparse?: boolean } = {}
  ) {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Trae launch',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    const relay = vi
      .spyOn(runtime, 'ensureOrchestrationFederationRelay')
      .mockImplementation(() => {})
    const createDispatch = vi.spyOn(db, 'createStartingWorkerDispatch')
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
              ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
              ...(options.legacy ? [] : [TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY]),
              ...(options.sparse ? [ORCHESTRATION_WORKER_SPARSE_CHECKOUT_RUNTIME_CAPABILITY] : [])
            ]
          }
        }
        return {
          dispatchId: z.object({ dispatchId: z.string() }).parse(params).dispatchId,
          state: 'ready',
          runtimeEpoch: 'runtime_remote',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote',
          ...(options.effective === null
            ? {}
            : {
                launch: {
                  requested: selection,
                  effective: options.effective ?? selection
                }
              })
        }
      })
    return {
      db,
      remoteCall,
      relay,
      createDispatch,
      start: (writableRoots?: string[]) =>
        startFederatedWorker({
          params: {
            task: task.id,
            from: 'term_coord',
            on: 'remote',
            worktree: 'id:worktree_remote',
            ...(writableRoots ? { writableRoots } : {}),
            ...selection
          },
          runtime,
          db,
          runId: run.id,
          task,
          orchestrationMutation: {
            callerFingerprint: 'caller',
            requestId: 'remote_start',
            method: 'orchestration.workerStart',
            payloadHash: 'payload'
          }
        }),
      startSparse: () =>
        startFederatedWorker({
          params: {
            task: task.id,
            from: 'term_coord',
            on: 'remote',
            worktree: 'new-top-level',
            name: 'remote-sparse-worker',
            repo: 'id:repo_remote',
            sparseDirectories: ['packages/web', 'docs'],
            ...selection
          },
          runtime,
          db,
          runId: run.id,
          task,
          orchestrationMutation: {
            callerFingerprint: 'caller',
            requestId: 'remote_sparse_start',
            method: 'orchestration.workerStart',
            payloadHash: 'payload'
          }
        })
    }
  }

  it('refuses writable roots before remote calls, relay attachment or dispatch creation', async () => {
    const { start, remoteCall, relay, createDispatch } = setup()
    await expect(start(['/task/evidence'])).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(remoteCall).not.toHaveBeenCalled()
    expect(relay).not.toHaveBeenCalled()
    expect(createDispatch).not.toHaveBeenCalled()
  })

  it('rejects a legacy runtime before attaching a worker', async () => {
    const { start, remoteCall } = setup({ legacy: true })
    await expect(start()).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(remoteCall).toHaveBeenCalledTimes(1)
    expect(remoteCall.mock.calls[0][1]).toBe('status.get')
  })

  it('forwards the separate override fields and accepts a matching receipt', async () => {
    const { start, remoteCall } = setup()
    await expect(start()).resolves.toMatchObject({
      state: 'ready',
      launch: { requested: selection, effective: selection }
    })
    expect(remoteCall.mock.calls[1][1]).toBe('orchestration.federationAttachStart')
    expect(remoteCall.mock.calls[1][2]).toMatchObject(selection)
  })

  it('refuses remote sparse worker creation when the worker server lacks support', async () => {
    const { startSparse, remoteCall } = setup()
    await expect(startSparse()).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(remoteCall).toHaveBeenCalledTimes(1)
    expect(remoteCall.mock.calls[0][1]).toBe('status.get')
  })

  it('forwards sparse worker creation only after remote capability negotiation', async () => {
    const { startSparse, remoteCall } = setup({ sparse: true })
    await expect(startSparse()).resolves.toMatchObject({ state: 'ready' })
    expect(remoteCall.mock.calls[1][1]).toBe('orchestration.federationAttachStart')
    expect(remoteCall.mock.calls[1][2]).toMatchObject({
      worktree: 'new-top-level',
      sparseDirectories: ['packages/web', 'docs']
    })
  })

  it.each([
    { label: 'missing', effective: null },
    { label: 'mismatched', effective: { ...selection, model: 'DeepSeek-V4-Flash' } }
  ])(
    'keeps $label confirmation outcome unknown without persisting resources',
    async ({ effective }) => {
      const { start, db } = setup({ effective })
      const result = await start()
      expect(result).toMatchObject({
        state: 'outcome_unknown',
        lastError: 'The worker server did not confirm the requested Trae launch preferences.'
      })
      const { dispatchId } = z.object({ dispatchId: z.string() }).parse(result)
      expect(db.getFederatedDispatch(dispatchId)).toMatchObject({
        remote_runtime_epoch: null,
        remote_worktree_id: null,
        remote_terminal_handle: null
      })
    }
  )
})
