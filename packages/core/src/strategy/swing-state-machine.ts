import {
  SWING_EVIDENCE_EFFECTS,
  SWING_THESIS_STATES,
  type SwingEvidenceRecord,
  type SwingFeatureSnapshot,
  type SwingThesisTransition,
  type SwingTradeThesis,
  type SwingTradeThesisState,
} from '@helix/contracts/swing'

const THESIS_TRANSITIONS: Record<SwingTradeThesisState, ReadonlySet<SwingTradeThesisState>> = {
  CANDIDATE: new Set(['ACTIVE', 'REJECTED', 'EXPIRED']),
  ACTIVE: new Set(['ENTRY_ELIGIBLE', 'INVALIDATED', 'EXPIRED']),
  ENTRY_ELIGIBLE: new Set(['TRIGGERED', 'INVALIDATED', 'EXPIRED']),
  TRIGGERED: new Set(['ACTIVE', 'INVALIDATED', 'CLOSED']),
  REJECTED: new Set(),
  INVALIDATED: new Set(),
  EXPIRED: new Set(),
  CLOSED: new Set(),
}

type NewSwingTradeThesis = Omit<SwingTradeThesis, 'state' | 'updatedAt' | 'evidence'>

type ThesisTransitionInput = {
  toState: SwingTradeThesisState
  occurredAt: number
  reasonCodes: string[]
  featureSnapshot?: SwingFeatureSnapshot
}

function nonEmptyText(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} is required`)
}

function timestamp(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer timestamp`)
}

function score(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${field} must be between 0 and 100`)
}

function normalizeReasonCodes(reasonCodes: string[]) {
  if (reasonCodes.length === 0) throw new Error('reasonCodes must not be empty')
  return reasonCodes.map((reasonCode) => {
    const normalized = reasonCode.trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) throw new Error(`invalid reason code ${reasonCode}`)
    return normalized
  })
}

function normalizeFeatureSnapshot(snapshot: SwingFeatureSnapshot = {}) {
  const normalized: Record<string, number | string | boolean | null> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    if (!key.trim()) throw new Error('feature snapshot keys must not be empty')
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`feature ${key} must be finite`)
    normalized[key] = value
  }
  return normalized
}

function assertEvidence(evidence: SwingEvidenceRecord) {
  nonEmptyText(evidence.id, 'evidence.id')
  nonEmptyText(evidence.thesisId, 'evidence.thesisId')
  nonEmptyText(evidence.type, 'evidence.type')
  timestamp(evidence.time, 'evidence.time')
  if (!SWING_EVIDENCE_EFFECTS.includes(evidence.effect)) throw new Error(`invalid Evidence effect ${evidence.effect}`)
  if (!Number.isFinite(evidence.scoreDelta)) throw new Error('evidence.scoreDelta must be finite')
  normalizeReasonCodes(evidence.reasonCodes)
  normalizeFeatureSnapshot(evidence.featureSnapshot)
}

export function isSwingThesisTransitionAllowed(fromState: SwingTradeThesisState, toState: SwingTradeThesisState) {
  return THESIS_TRANSITIONS[fromState].has(toState)
}

export function assertSwingTradeThesis(thesis: SwingTradeThesis) {
  nonEmptyText(thesis.id, 'thesis.id')
  nonEmptyText(thesis.symbol, 'thesis.symbol')
  nonEmptyText(thesis.type, 'thesis.type')
  nonEmptyText(thesis.contextId, 'thesis.contextId')
  nonEmptyText(thesis.locationId, 'thesis.locationId')
  nonEmptyText(thesis.invalidation.policyId, 'thesis.invalidation.policyId')
  nonEmptyText(thesis.invalidation.type, 'thesis.invalidation.type')
  nonEmptyText(thesis.invalidation.timeframe, 'thesis.invalidation.timeframe')
  nonEmptyText(thesis.expectedMove.targetLocationId, 'thesis.expectedMove.targetLocationId')
  if (!Number.isFinite(thesis.expectedMove.target) || thesis.expectedMove.target <= 0) {
    throw new Error('thesis.expectedMove.target must be positive')
  }
  if (thesis.invalidation.level !== undefined && !Number.isFinite(thesis.invalidation.level)) {
    throw new Error('thesis.invalidation.level must be finite')
  }
  if (!SWING_THESIS_STATES.includes(thesis.state)) throw new Error(`invalid Thesis state ${thesis.state}`)
  score(thesis.score, 'thesis.score')
  timestamp(thesis.createdAt, 'thesis.createdAt')
  timestamp(thesis.expiresAt, 'thesis.expiresAt')
  timestamp(thesis.updatedAt, 'thesis.updatedAt')
  if (thesis.expiresAt <= thesis.createdAt) throw new Error('thesis.expiresAt must be after thesis.createdAt')
  if (thesis.updatedAt < thesis.createdAt) throw new Error('thesis.updatedAt cannot precede thesis.createdAt')
  if ((thesis.state === 'CANDIDATE'
    || thesis.state === 'ACTIVE'
    || thesis.state === 'ENTRY_ELIGIBLE'
    || thesis.state === 'REJECTED'
    || thesis.state === 'INVALIDATED')
    && thesis.updatedAt >= thesis.expiresAt) {
    throw new Error(`Thesis state ${thesis.state} cannot begin after expiry`)
  }
  if (thesis.state === 'EXPIRED' && thesis.updatedAt < thesis.expiresAt) {
    throw new Error('Thesis cannot be EXPIRED before its expiry time')
  }
  normalizeReasonCodes(thesis.reasonCodes)

  const ids = new Set<string>()
  let previousTime = thesis.createdAt
  for (const evidence of thesis.evidence) {
    assertEvidence(evidence)
    if (evidence.thesisId !== thesis.id) throw new Error('Evidence does not belong to this Thesis')
    if (ids.has(evidence.id)) throw new Error(`duplicate Evidence id ${evidence.id}`)
    if (evidence.time < previousTime) throw new Error('Evidence time cannot move backwards')
    if (evidence.time > thesis.updatedAt) throw new Error('Evidence cannot occur after Thesis updatedAt')
    ids.add(evidence.id)
    previousTime = evidence.time
  }
}

export function createSwingTradeThesis(input: NewSwingTradeThesis): SwingTradeThesis {
  const thesis: SwingTradeThesis = {
    ...input,
    state: 'CANDIDATE',
    updatedAt: input.createdAt,
    reasonCodes: normalizeReasonCodes(input.reasonCodes),
    evidence: [],
  }
  assertSwingTradeThesis(thesis)
  return thesis
}

export function transitionSwingTradeThesis(
  thesis: SwingTradeThesis,
  input: ThesisTransitionInput,
): { thesis: SwingTradeThesis; transition: SwingThesisTransition } {
  assertSwingTradeThesis(thesis)
  timestamp(input.occurredAt, 'transition.occurredAt')
  if (input.occurredAt < thesis.updatedAt) throw new Error('Thesis time cannot move backwards')

  const allowed = THESIS_TRANSITIONS[thesis.state]
  if (!isSwingThesisTransitionAllowed(thesis.state, input.toState)) {
    if (allowed.size === 0) throw new Error(`Thesis state ${thesis.state} is terminal`)
    throw new Error(`illegal Thesis transition ${thesis.state} -> ${input.toState}`)
  }

  if (thesis.state !== 'TRIGGERED' && input.occurredAt >= thesis.expiresAt && input.toState !== 'EXPIRED') {
    throw new Error('Thesis expired; only EXPIRED is allowed')
  }
  if (input.toState === 'EXPIRED' && input.occurredAt < thesis.expiresAt) {
    throw new Error('Thesis cannot expire before its configured time')
  }

  const reasonCodes = normalizeReasonCodes(input.reasonCodes)
  const featureSnapshot = normalizeFeatureSnapshot(input.featureSnapshot)
  const next: SwingTradeThesis = {
    ...thesis,
    state: input.toState,
    updatedAt: input.occurredAt,
    reasonCodes,
  }

  return {
    thesis: next,
    transition: {
      thesisId: thesis.id,
      fromState: thesis.state,
      toState: input.toState,
      occurredAt: input.occurredAt,
      reasonCodes,
      featureSnapshot,
    },
  }
}

export function appendSwingEvidence(
  thesis: SwingTradeThesis,
  evidence: SwingEvidenceRecord,
): SwingTradeThesis {
  assertSwingTradeThesis(thesis)
  assertEvidence(evidence)
  if (THESIS_TRANSITIONS[thesis.state].size === 0) throw new Error(`Thesis state ${thesis.state} is terminal`)
  if (evidence.thesisId !== thesis.id) throw new Error('Evidence does not belong to this Thesis')
  if (thesis.evidence.some((candidate) => candidate.id === evidence.id)) {
    throw new Error(`duplicate Evidence id ${evidence.id}`)
  }
  if (evidence.time < thesis.updatedAt) throw new Error('Evidence time cannot move backwards')

  const nextScore = thesis.score + evidence.scoreDelta
  score(nextScore, 'Thesis score after Evidence')
  const next: SwingTradeThesis = {
    ...thesis,
    score: nextScore,
    updatedAt: evidence.time,
    reasonCodes: normalizeReasonCodes(evidence.reasonCodes),
    evidence: [...thesis.evidence, {
      ...evidence,
      reasonCodes: normalizeReasonCodes(evidence.reasonCodes),
      featureSnapshot: normalizeFeatureSnapshot(evidence.featureSnapshot),
    }],
  }
  assertSwingTradeThesis(next)
  return next
}
