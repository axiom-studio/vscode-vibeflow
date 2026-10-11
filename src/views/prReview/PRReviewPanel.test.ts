import { describe, expect, it } from 'vitest';
import type { VibeFlowClient } from '../../api/client.js';
import type { PRReviewSummary } from '../../api/prReviewTypes.js';
import type { PRReviewPageHostMessage } from '../../core/webviewMessages.js';
import { PRReviewPanel } from './PRReviewPanel.js';

const summaryAt = (version: number) => ({ review: { id: 'job', version, number: 11, provider: 'github', repository_link_id: 46 } } as unknown as PRReviewSummary);

/** A panel over a fake webview and a client whose summary/findings calls the test resolves by hand. */
function harness() {
  const posted: PRReviewPageHostMessage[] = [];
  const decisions: Array<{ expected_version: number }> = [];
  const summaries: Array<(s: PRReviewSummary) => void> = [];
  const findings: Array<() => void> = [];
  const client = {
    getPRReviewSummary: () => new Promise<PRReviewSummary>(r => summaries.push(r)),
    listPRReviewFindings: () => new Promise(r => findings.push(() => r({ items: [], nextAfterId: '' }))),
    controlPRReviewFinding: async (_p: number, _j: string, _f: string, body: { expected_version: number }) => { decisions.push(body); },
  } as unknown as VibeFlowClient;
  const panel = { webview: { postMessage: async (m: PRReviewPageHostMessage) => { posted.push(m); } } };
  const Ctor = PRReviewPanel as unknown as new (...a: unknown[]) => { handleMessage(m: unknown): Promise<void>; load(): Promise<void> };
  const instance = new Ctor(panel, client, 28, 'job', undefined);
  const tick = () => new Promise(r => setTimeout(r, 0));
  const lastSnapshot = () => {
    const data = posted.filter(m => m.type === 'prReviewData').at(-1);
    return data?.type === 'prReviewData' ? data.payload.generatedAt : '';
  };
  const dismiss = (snapshot: string) => instance.handleMessage({ type: 'prReviewFindingControl', snapshot, payload: { findingId: 'f1', action: 'dismiss', reason: 'r' } });
  return { instance, summaries, findings, decisions, tick, lastSnapshot, dismiss };
}

describe('PRReviewPanel controls', () => {
  it('sends the version of the snapshot on screen while a newer one is still loading', async () => {
    const h = harness();
    const first = h.instance.load();
    h.summaries[0](summaryAt(1)); await h.tick(); h.findings[0](); await first;
    const shown = h.lastSnapshot();

    void h.instance.load(); // refresh: v2 summary arrives, its findings are still pending
    h.summaries[1](summaryAt(2)); await h.tick();

    const action = h.dismiss(shown);
    h.summaries[2]?.(summaryAt(2)); // the post-action reload
    await h.tick();
    expect(h.decisions).toEqual([expect.objectContaining({ expected_version: 1 })]);
    void action;
  });

  it('refuses an action taken on a snapshot that a newer one replaced', async () => {
    const h = harness();
    const first = h.instance.load();
    h.summaries[0](summaryAt(1)); await h.tick(); h.findings[0](); await first;
    const stale = h.lastSnapshot();
    const second = h.instance.load();
    h.summaries[1](summaryAt(2)); await h.tick(); h.findings[1](); await second;

    void h.dismiss(stale);
    await h.tick();
    expect(h.decisions).toEqual([]);
  });
});
