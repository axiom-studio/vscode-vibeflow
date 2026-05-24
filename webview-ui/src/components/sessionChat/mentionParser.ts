// Re-export shim. Canonical implementation lives at
// `src/views/sessions/mentionParser.ts` so host + webview stay in
// lockstep without dual-life maintenance.
//
// Webview Vite bundle resolves the relative path naturally;
// `webview-ui/tsconfig.json` `include` adds the host file to the
// webview compile graph. Same precedent as
// `webview-ui/src/components/comments/types.ts` re-exporting from
// `../../../../src/api/types`.
export {
  MENTION_KINDS,
  parseMentionState,
  formatMentionToken,
  applyMention,
  shouldFetch,
} from '../../../../src/views/sessions/mentionParser';
export type { MentionKind, MentionState } from '../../../../src/views/sessions/mentionParser';
