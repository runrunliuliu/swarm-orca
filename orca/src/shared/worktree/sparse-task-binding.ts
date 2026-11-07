// M5 (minimum): the persisted half of the task sparse contract.
//
// Why a binding and not the receipt: a receipt is a one-time answer to the caller and is never
// stored, so a later reader (start gate, handoff reviewer) cannot check it. The binding keeps only
// the facts that cannot be re-read — which commit the task started from and what it declared — and
// deliberately omits `actualHead` / `effectiveSparseCone`, which are read back from the worktree
// every time they are needed. Storing snapshot state would make a stale copy look like evidence.

import { createHash } from 'node:crypto'
import {
  SPARSE_TASK_CHECKOUT_MODE,
  type SparseTaskWorkspaceReceipt
} from './create-types'

export const SPARSE_TASK_BINDING_SCHEMA_VERSION = 1 as const

/** Canonical, persisted fields. `bindingDigest` covers exactly these. */
export type SparseTaskBindingFields = {
  schemaVersion: typeof SPARSE_TASK_BINDING_SCHEMA_VERSION
  mode: typeof SPARSE_TASK_CHECKOUT_MODE
  /** Full commit the workspace was created at; the task's baseline, not a movable ref. */
  pinnedSha: string
  baseSource: 'request' | 'default'
  resolvedRef: string
  /** Strictly parsed request cone, first-seen order, deduplicated. */
  requestedSparseCone: string[]
  /** Declared paths the workspace must be able to read, verified at create time. */
  requiredPaths: string[]
  createdAt: number
}

export type SparseTaskWorkspaceBinding = SparseTaskBindingFields & {
  /** sha256 over the canonical fields above; proves the record was not edited after creation. */
  bindingDigest: string
}

const BINDING_KEYS = [
  'schemaVersion',
  'mode',
  'pinnedSha',
  'baseSource',
  'resolvedRef',
  'requestedSparseCone',
  'requiredPaths',
  'createdAt',
  'bindingDigest'
] as const

const FIELD_KEYS = [
  'schemaVersion',
  'mode',
  'pinnedSha',
  'baseSource',
  'resolvedRef',
  'requestedSparseCone',
  'requiredPaths',
  'createdAt'
] as const

/**
 * One serialization for both the digest and its verification.
 *
 * Why fixed key order instead of an object spread: `JSON.stringify` follows insertion order, so a
 * caller-built object with the same values would otherwise hash differently and a valid record
 * would fail its own check.
 */
function canonicalFields(fields: SparseTaskBindingFields): string {
  return JSON.stringify({
    schemaVersion: fields.schemaVersion,
    mode: fields.mode,
    pinnedSha: fields.pinnedSha,
    baseSource: fields.baseSource,
    resolvedRef: fields.resolvedRef,
    requestedSparseCone: fields.requestedSparseCone,
    requiredPaths: fields.requiredPaths,
    createdAt: fields.createdAt
  })
}

export function sparseTaskBindingDigest(fields: SparseTaskBindingFields): string {
  return createHash('sha256').update(canonicalFields(fields), 'utf8').digest('hex')
}

/** The persisted form of a successful task create. Nothing here may be inferred from a failure. */
export function createSparseTaskWorkspaceBinding(
  receipt: SparseTaskWorkspaceReceipt,
  createdAt: number
): SparseTaskWorkspaceBinding {
  const fields: SparseTaskBindingFields = {
    schemaVersion: SPARSE_TASK_BINDING_SCHEMA_VERSION,
    mode: SPARSE_TASK_CHECKOUT_MODE,
    pinnedSha: receipt.pinnedSha.toLowerCase(),
    baseSource: receipt.baseSource,
    resolvedRef: receipt.resolvedRef,
    requestedSparseCone: [...receipt.requestedSparseCone],
    requiredPaths: [...receipt.requiredPaths],
    createdAt
  }
  return { ...fields, bindingDigest: sparseTaskBindingDigest(fields) }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  // Why own properties: `'toString' in value` is true for every object, so an inherited name would
  // otherwise pass for a stored field and let a missing field read as present.
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/**
 * Read a persisted binding, or `null`.
 *
 * Why `null` instead of throwing: this runs on metadata written by an older build or edited by
 * hand, so "not a valid binding" is an ordinary state. Callers decide; nothing here repairs a
 * record, and a digest mismatch is never downgraded to a warning.
 */
export function parseSparseTaskWorkspaceBinding(
  value: unknown
): SparseTaskWorkspaceBinding | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (!hasExactKeys(record, BINDING_KEYS)) {
    return null
  }
  if (record.schemaVersion !== SPARSE_TASK_BINDING_SCHEMA_VERSION) {
    return null
  }
  if (record.mode !== SPARSE_TASK_CHECKOUT_MODE) {
    return null
  }
  if (typeof record.pinnedSha !== 'string' || !/^[0-9a-f]{40,64}$/.test(record.pinnedSha)) {
    return null
  }
  if (record.baseSource !== 'request' && record.baseSource !== 'default') {
    return null
  }
  if (typeof record.resolvedRef !== 'string' || record.resolvedRef.length === 0) {
    return null
  }
  if (!isStringArray(record.requestedSparseCone) || !isStringArray(record.requiredPaths)) {
    return null
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
    return null
  }
  if (typeof record.bindingDigest !== 'string') {
    return null
  }
  const fields: SparseTaskBindingFields = {
    schemaVersion: SPARSE_TASK_BINDING_SCHEMA_VERSION,
    mode: SPARSE_TASK_CHECKOUT_MODE,
    pinnedSha: record.pinnedSha,
    baseSource: record.baseSource,
    resolvedRef: record.resolvedRef,
    requestedSparseCone: record.requestedSparseCone,
    requiredPaths: record.requiredPaths,
    createdAt: record.createdAt
  }
  if (sparseTaskBindingDigest(fields) !== record.bindingDigest) {
    return null
  }
  return { ...fields, bindingDigest: record.bindingDigest }
}

/**
 * Does a persisted binding describe the same create as this receipt?
 *
 * Why compare fields and not the digest: the receipt never carries a digest, so the only honest
 * question is whether they name the same baseline and the same declarations.
 */
export function sparseTaskBindingMatchesReceipt(
  binding: SparseTaskWorkspaceBinding,
  receipt: SparseTaskWorkspaceReceipt
): boolean {
  const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((entry, index) => entry === right[index])
  return (
    binding.pinnedSha === receipt.pinnedSha.toLowerCase() &&
    binding.baseSource === receipt.baseSource &&
    binding.resolvedRef === receipt.resolvedRef &&
    sameList(binding.requestedSparseCone, receipt.requestedSparseCone) &&
    sameList(binding.requiredPaths, receipt.requiredPaths)
  )
}

/** Exported so a reader can reject an unknown future schema rather than misread it as v1. */
export function isKnownSparseTaskBindingSchema(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).schemaVersion === SPARSE_TASK_BINDING_SCHEMA_VERSION
  )
}

export { FIELD_KEYS as SPARSE_TASK_BINDING_FIELD_KEYS }
