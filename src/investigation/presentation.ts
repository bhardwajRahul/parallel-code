import { nodeTrail } from '../mindmap/model';
import type { InvestigationRecord, Snapshot } from './state';

import { defaultAppearance, noteTypes } from '../mindmap/presentation';
export { noteTypes } from '../mindmap/presentation';

/** Compact panes keep readable text while reducing branch width. */
export function notePresentation(kind: InvestigationRecord['kind'], compact = false) {
  if (!kind) return defaultAppearance({}, compact);
  const type = noteTypes[kind];
  if (!compact) return type;
  return { ...type, width: kind === 'goal' || kind === 'question' ? 160 : 112 };
}

export function recordTrail(snapshot: Snapshot, id: string): InvestigationRecord[] {
  return nodeTrail(snapshot.records, id);
}
