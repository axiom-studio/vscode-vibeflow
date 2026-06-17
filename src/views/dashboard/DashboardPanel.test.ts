import { describe, it, expect } from 'vitest';
import { tallyPersonaQueues } from './DashboardPanel.js';
import type { VibeFlowSwimlaneItem, VibeFlowSwimlaneResult } from '../../api/types.js';

/**
 * Unit tests for `tallyPersonaQueues` — the host-side reducer that turns the
 * org-scoped swimlane into per-persona queue-badge counts.
 *
 * Regression target: issue #2855. The swimlane carries container rows
 * (`type: 'feature' | 'project'`) alongside work items in every status
 * column. Those containers never flow through a persona's status pipeline,
 * so they must NOT count toward any persona badge. Before the fix a `done`
 * feature (whose `security_reviewed` is null on the wire) was counted as
 * "needs security review", and features in other columns inflated the
 * product_manager / code-queue / ux_designer badges the same way.
 *
 * Pure function, pure data — no mocks (project testing policy).
 */

const PROJECT = 28;
const OTHER_PROJECT = 99;

/** Build a swimlane item with work-item-ish defaults; override per test. */
function mk(over: Partial<VibeFlowSwimlaneItem> = {}): VibeFlowSwimlaneItem {
  return {
    type: 'todo',
    id: 1,
    name: 'item',
    status: 'done',
    updated_at: '2026-06-16T00:00:00.000Z',
    project_id: PROJECT,
    ...over,
  };
}

/** All eight columns empty; tests fill in only the columns they exercise. */
function emptySwimlane(): VibeFlowSwimlaneResult {
  return {
    in_review: [],
    needs_pm_input: [],
    needs_ux_input: [],
    planning: [],
    ready_to_implement: [],
    architecture_review_complete: [],
    implementing: [],
    done: [],
  };
}

describe('tallyPersonaQueues', () => {
  describe('#2855 — container rows must not inflate the security badge', () => {
    it('counts only reviewable items with security_reviewed === false', () => {
      // Mirrors the issue's suggested fixture: one feature (null), one
      // unreviewed todo (false), one reviewed todo (true) → exactly 1.
      const swim: VibeFlowSwimlaneResult = {
        ...emptySwimlane(),
        done: [
          mk({ type: 'feature', id: 257 }), // security_reviewed null/undefined on the wire
          mk({ type: 'todo', id: 1, security_reviewed: false }),
          mk({ type: 'todo', id: 2, security_reviewed: true }),
        ],
      };
      expect(tallyPersonaQueues(swim, PROJECT, null).security_lead).toBe(1);
    });

    it('reads 0 when the only falsy-flag rows in done are features (the live project-28 case)', () => {
      const swim: VibeFlowSwimlaneResult = {
        ...emptySwimlane(),
        done: [
          mk({ type: 'feature', id: 252 }),
          mk({ type: 'feature', id: 418 }),
          mk({ type: 'feature', id: 257 }),
          mk({ type: 'feature', id: 256 }),
          mk({ type: 'feature', id: 248 }),
          mk({ type: 'todo', id: 10, security_reviewed: true }),
          mk({ type: 'issue', id: 11, security_reviewed: true }),
        ],
      };
      expect(tallyPersonaQueues(swim, PROJECT, null).security_lead).toBe(0);
    });

    it('excludes a feature even if it somehow carries security_reviewed === false', () => {
      // The type guard wins regardless of the flag — containers are never
      // a security-review subject.
      const swim: VibeFlowSwimlaneResult = {
        ...emptySwimlane(),
        done: [
          mk({ type: 'feature', id: 1, security_reviewed: false }),
          mk({ type: 'project', id: 2, security_reviewed: false }),
        ],
      };
      expect(tallyPersonaQueues(swim, PROJECT, null).security_lead).toBe(0);
    });

    it('treats undefined security_reviewed (wire null) on a real work item as not-pending', () => {
      const swim: VibeFlowSwimlaneResult = {
        ...emptySwimlane(),
        done: [mk({ type: 'todo', id: 1 })], // security_reviewed omitted
      };
      expect(tallyPersonaQueues(swim, PROJECT, null).security_lead).toBe(0);
    });
  });

  describe('container rows must not inflate the other persona badges', () => {
    it('product_manager (in_review) ignores features/projects', () => {
      const swim: VibeFlowSwimlaneResult = {
        ...emptySwimlane(),
        in_review: [
          mk({ type: 'feature', id: 1, status: 'in_review' }),
          mk({ type: 'project', id: 2, status: 'in_review' }),
          mk({ type: 'issue', id: 3, status: 'in_review' }),
        ],
      };
      expect(tallyPersonaQueues(swim, PROJECT, null).product_manager).toBe(1);
    });

    it('code-queue personas (planning/ready/arch-review) ignore features', () => {
      const swim: VibeFlowSwimlaneResult = {
        ...emptySwimlane(),
        planning: [mk({ type: 'feature', id: 1, status: 'planning' }), mk({ type: 'todo', id: 2, status: 'planning' })],
        ready_to_implement: [mk({ type: 'feature', id: 3, status: 'ready_to_implement' })],
        architecture_review_complete: [mk({ type: 'issue', id: 4, status: 'architecture_review_complete' })],
      };
      const q = tallyPersonaQueues(swim, PROJECT, null);
      // planning: 1 todo (feature dropped) + ready: 0 (feature dropped) + arch: 1 issue = 2
      expect(q.architect).toBe(2);
      // architect / developer / principal_engineer share one code queue.
      expect(q.developer).toBe(2);
      expect(q.principal_engineer).toBe(2);
    });

    it('ux_designer (needs_ux_input) ignores features', () => {
      const swim: VibeFlowSwimlaneResult = {
        ...emptySwimlane(),
        needs_ux_input: [
          mk({ type: 'feature', id: 1, status: 'needs_ux_input' }),
          mk({ type: 'todo', id: 2, status: 'needs_ux_input' }),
        ],
      };
      expect(tallyPersonaQueues(swim, PROJECT, null).ux_designer).toBe(1);
    });
  });

  describe('project scoping', () => {
    it('counts only rows for the requested project', () => {
      const swim: VibeFlowSwimlaneResult = {
        ...emptySwimlane(),
        in_review: [
          mk({ type: 'issue', id: 1, status: 'in_review', project_id: PROJECT }),
          mk({ type: 'issue', id: 2, status: 'in_review', project_id: OTHER_PROJECT }),
        ],
        done: [
          mk({ type: 'todo', id: 3, security_reviewed: false, project_id: PROJECT }),
          mk({ type: 'todo', id: 4, security_reviewed: false, project_id: OTHER_PROJECT }),
        ],
      };
      const q = tallyPersonaQueues(swim, PROJECT, null);
      expect(q.product_manager).toBe(1);
      expect(q.security_lead).toBe(1);
    });
  });

  describe('real work still counts', () => {
    it('tallies genuine work items across every persona column', () => {
      const swim: VibeFlowSwimlaneResult = {
        ...emptySwimlane(),
        in_review: [mk({ type: 'todo', id: 1, status: 'in_review' }), mk({ type: 'issue', id: 2, status: 'in_review' })],
        planning: [mk({ type: 'todo', id: 3, status: 'planning' })],
        ready_to_implement: [mk({ type: 'issue', id: 4, status: 'ready_to_implement' })],
        architecture_review_complete: [mk({ type: 'todo', id: 5, status: 'architecture_review_complete' })],
        needs_ux_input: [mk({ type: 'todo', id: 6, status: 'needs_ux_input' })],
        done: [
          mk({ type: 'todo', id: 7, security_reviewed: false }),
          mk({ type: 'issue', id: 8, security_reviewed: false }),
        ],
      };
      const q = tallyPersonaQueues(swim, PROJECT, 4);
      expect(q.product_manager).toBe(2);
      expect(q.architect).toBe(3); // 1 planning + 1 ready + 1 arch-review
      expect(q.ux_designer).toBe(1);
      expect(q.security_lead).toBe(2);
      expect(q.qa_lead).toBe(4); // passthrough of qaPending
    });
  });

  describe('passthrough and degraded inputs', () => {
    it('passes qaPending straight through to qa_lead', () => {
      expect(tallyPersonaQueues(emptySwimlane(), PROJECT, 7).qa_lead).toBe(7);
      expect(tallyPersonaQueues(emptySwimlane(), PROJECT, null).qa_lead).toBeNull();
    });

    it('keeps project_manager and customer as null (no status-driven intake)', () => {
      const q = tallyPersonaQueues(emptySwimlane(), PROJECT, 3);
      expect(q.project_manager).toBeNull();
      expect(q.customer).toBeNull();
    });

    it('returns zeros (and qaPending) when the swimlane fetch failed', () => {
      const q = tallyPersonaQueues(undefined, PROJECT, 5);
      expect(q).toEqual({
        product_manager: 0,
        architect: 0,
        developer: 0,
        principal_engineer: 0,
        security_lead: 0,
        qa_lead: 5,
        ux_designer: 0,
        project_manager: null,
        customer: null,
      });
    });

    it('returns all zeros for an empty (but present) swimlane', () => {
      const q = tallyPersonaQueues(emptySwimlane(), PROJECT, null);
      expect(q.product_manager).toBe(0);
      expect(q.architect).toBe(0);
      expect(q.security_lead).toBe(0);
      expect(q.ux_designer).toBe(0);
    });
  });
});
