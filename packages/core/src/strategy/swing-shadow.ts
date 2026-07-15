import type { StoredSwingJournalEntry, SwingShadowAction } from '@helix/contracts/swing'
import type { StrategyManifestIdentity } from '@helix/contracts/strategy'
import { SwingStrategyJournal, type SwingJournalWrite } from './swing-journal'

type ShadowDecisionInput = Omit<SwingJournalWrite, 'runMode' | 'shadowAction'> & {
  action: SwingShadowAction
}

export function appendSwingShadowDecision(
  journal: SwingStrategyJournal,
  manifest: StrategyManifestIdentity,
  input: ShadowDecisionInput,
): StoredSwingJournalEntry {
  const { action, ...entry } = input
  return journal.append(manifest, {
    ...entry,
    runMode: 'shadow',
    shadowAction: action,
  })
}
