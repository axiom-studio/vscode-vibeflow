// MentionPicker — React port of the @mention autocomplete popup
// (todo #1614). Presentational: parent owns mention state, selected
// index, and the host-result queue. Picker renders the kind chooser
// when `state.kind === undefined` and the item list otherwise.
//
// Keyboard handling lives in the parent (SessionChatView) so the
// textarea's keydown can hijack arrow/Enter/Escape only while
// `state.active` is true. The picker exposes nothing imperative —
// just two render paths driven by props.

import { MENTION_KINDS, type MentionKind, type MentionState } from './mentionParser';
import type { MentionItem } from './sessionChatTypes';

interface MentionPickerProps {
  state: MentionState;
  /** Items returned by the host for the current resolved kind. */
  items: MentionItem[];
  /** Selected index — applies to either the kind list (when kind is undefined) or items. */
  selectedIndex: number;
  /** True while a chatMentionQuery is in flight (no fresh chatMentionResults yet). */
  loading: boolean;
  onPick: (index: number) => void;
  onHoverIndex: (index: number) => void;
}

export function MentionPicker(props: MentionPickerProps) {
  const { state, items, selectedIndex, loading, onPick, onHoverIndex } = props;
  if (!state.active) { return null; }

  // Kind chooser path — no `:` typed yet, or typed kind isn't recognized.
  if (state.kind === undefined) {
    const filterText = state.query.toLowerCase();
    const filteredKinds: MentionKind[] = (MENTION_KINDS as readonly MentionKind[])
      .filter(k => filterText === '' || k.startsWith(filterText));
    if (filteredKinds.length === 0) {
      return (
        <div className="mention-picker" role="listbox" aria-label="@mention type">
          <div className="mention-picker-empty">No matching mention type.</div>
        </div>
      );
    }
    return (
      <div className="mention-picker" role="listbox" aria-label="@mention type">
        <div className="mention-picker-header">Type</div>
        {filteredKinds.map((k, idx) => (
          <button
            key={k}
            type="button"
            role="option"
            aria-selected={idx === selectedIndex}
            className={`mention-row${idx === selectedIndex ? ' selected' : ''}`}
            onMouseDown={e => { e.preventDefault(); onPick(idx); }}
            onMouseEnter={() => onHoverIndex(idx)}
          >
            <span className="mention-row-name">@{k}</span>
            <span className="mention-row-detail">{kindHint(k)}</span>
          </button>
        ))}
      </div>
    );
  }

  // Item list path — kind is resolved; render the host-fetched list.
  if (loading && items.length === 0) {
    return (
      <div className="mention-picker" role="listbox" aria-label={`@${state.kind} results`}>
        <div className="mention-picker-header">@{state.kind}{state.query ? `: ${state.query}` : ''}</div>
        <div className="mention-picker-empty">Searching…</div>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="mention-picker" role="listbox" aria-label={`@${state.kind} results`}>
        <div className="mention-picker-header">@{state.kind}{state.query ? `: ${state.query}` : ''}</div>
        <div className="mention-picker-empty">No matches.</div>
      </div>
    );
  }
  return (
    <div className="mention-picker" role="listbox" aria-label={`@${state.kind} results`}>
      <div className="mention-picker-header">@{state.kind}{state.query ? `: ${state.query}` : ''}</div>
      {items.map((item, idx) => (
        <button
          key={`${item.id}`}
          type="button"
          role="option"
          aria-selected={idx === selectedIndex}
          className={`mention-row${idx === selectedIndex ? ' selected' : ''}`}
          onMouseDown={e => { e.preventDefault(); onPick(idx); }}
          onMouseEnter={() => onHoverIndex(idx)}
        >
          <span className="mention-row-name">{item.name}</span>
          {item.detail && <span className="mention-row-detail">{item.detail}</span>}
        </button>
      ))}
    </div>
  );
}

function kindHint(k: MentionKind): string {
  switch (k) {
    case 'document': return 'design doc';
    case 'context': return 'agent context';
    case 'todo': return 'work item';
    case 'issue': return 'bug / standalone';
    case 'feature': return 'feature container';
    case 'reference': return 'external doc (Confluence/ClickUp)';
    case 'symbol': return 'workspace symbol (VS Code LSP)';
  }
}
