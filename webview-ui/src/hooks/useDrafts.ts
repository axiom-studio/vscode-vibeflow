import { useState, useCallback, useMemo } from 'react';

/**
 * In-memory draft state for comment composition.
 * Keyed by sectionIndex to match axiomcloud's DocumentPopoutModal behavior.
 * Phase 1: no persistence. Phase 2 will swap for workspace state.
 */
export function useDrafts() {
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const setDraft = useCallback((sectionIndex: number, content: string) => {
    setDrafts(prev => ({ ...prev, [sectionIndex]: content }));
  }, []);

  const clearDraft = useCallback((sectionIndex: number) => {
    setDrafts(prev => {
      const next = { ...prev };
      delete next[sectionIndex];
      return next;
    });
  }, []);

  const clearAllDrafts = useCallback(() => {
    setDrafts({});
  }, []);

  const hasDrafts = useMemo(
    () => Object.values(drafts).some(c => c.trim().length > 0),
    [drafts],
  );

  return { drafts, setDraft, clearDraft, clearAllDrafts, hasDrafts };
}
