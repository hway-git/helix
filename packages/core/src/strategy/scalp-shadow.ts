import type { ScalpShadowAction, StoredScalpJournalEntry } from '@helix/contracts/scalp'
import type { StrategyManifestIdentity } from '@helix/contracts/strategy'
import { ScalpStrategyJournal, type ScalpJournalWrite } from './scalp-journal'

type ShadowDecisionInput = Omit<ScalpJournalWrite, 'runMode' | 'shadowAction'> & {
  action: ScalpShadowAction
}

export function appendScalpShadowDecision(
  journal: ScalpStrategyJournal,
  manifest: StrategyManifestIdentity,
  input: ShadowDecisionInput,
): StoredScalpJournalEntry {
  const { action, ...entry } = input
  return journal.append(manifest, {
    ...entry,
    runMode: 'shadow',
    shadowAction: action,
  })
}
