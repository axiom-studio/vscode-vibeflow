import { describe, it, expect } from 'vitest';
import {
  CODE_AGENT_PERSONAS,
  isCodeAgent,
  PERSONA_DISPLAY_NAMES,
  personaDisplayName,
} from './personas.js';

describe('CODE_AGENT_PERSONAS', () => {
  it('contains exactly the three code-agent keys (and no advisory personas)', () => {
    // Stays in sync with vibeflow-cli + axiomcloud — see file comment.
    // A regression that adds an advisory persona here would silently
    // grant it a visible terminal in hybrid mode (wrong).
    expect(CODE_AGENT_PERSONAS).toEqual(new Set(['developer', 'architect', 'principal_engineer']));
  });

  it('is a frozen Set in spirit — modifying it would leak across imports', () => {
    // We don't deep-freeze (Sets aren't Object.freeze-able), but any
    // refactor that switches to an array should keep the membership.
    expect(CODE_AGENT_PERSONAS.has('developer')).toBe(true);
    expect(CODE_AGENT_PERSONAS.has('architect')).toBe(true);
    expect(CODE_AGENT_PERSONAS.has('principal_engineer')).toBe(true);
  });
});

describe('isCodeAgent', () => {
  it('returns true for the three code agents', () => {
    expect(isCodeAgent('developer')).toBe(true);
    expect(isCodeAgent('architect')).toBe(true);
    expect(isCodeAgent('principal_engineer')).toBe(true);
  });

  it('returns false for advisory personas', () => {
    expect(isCodeAgent('security_lead')).toBe(false);
    expect(isCodeAgent('qa_lead')).toBe(false);
    expect(isCodeAgent('product_manager')).toBe(false);
    expect(isCodeAgent('project_manager')).toBe(false);
    expect(isCodeAgent('ux_designer')).toBe(false);
    expect(isCodeAgent('customer')).toBe(false);
  });

  it('returns false for unknown keys', () => {
    expect(isCodeAgent('unknown')).toBe(false);
    expect(isCodeAgent('')).toBe(false);
  });

  it('is case-sensitive — the table uses lowercase keys', () => {
    expect(isCodeAgent('Developer')).toBe(false);
    expect(isCodeAgent('DEVELOPER')).toBe(false);
    expect(isCodeAgent('Principal_Engineer')).toBe(false);
  });
});

describe('PERSONA_DISPLAY_NAMES', () => {
  it('maps every code-agent persona to a human-readable name', () => {
    for (const key of CODE_AGENT_PERSONAS) {
      expect(PERSONA_DISPLAY_NAMES[key]).toBeTruthy();
    }
  });

  it('maps every known advisory persona', () => {
    expect(PERSONA_DISPLAY_NAMES.security_lead).toBe('Security Lead');
    expect(PERSONA_DISPLAY_NAMES.qa_lead).toBe('QA Lead');
    expect(PERSONA_DISPLAY_NAMES.product_manager).toBe('Product Manager');
    expect(PERSONA_DISPLAY_NAMES.project_manager).toBe('Project Manager');
    expect(PERSONA_DISPLAY_NAMES.ux_designer).toBe('UX Designer');
    expect(PERSONA_DISPLAY_NAMES.customer).toBe('Customer');
  });
});

describe('personaDisplayName', () => {
  it('returns the mapped name for known keys', () => {
    expect(personaDisplayName('developer')).toBe('Developer');
    expect(personaDisplayName('principal_engineer')).toBe('Principal Engineer');
    expect(personaDisplayName('qa_lead')).toBe('QA Lead');
  });

  it('falls back to a title-cased, space-separated rendering for unknown keys', () => {
    expect(personaDisplayName('compliance_officer')).toBe('Compliance Officer');
    expect(personaDisplayName('foo_bar_baz')).toBe('Foo Bar Baz');
  });

  it('title-cases single-word unknown keys', () => {
    expect(personaDisplayName('intern')).toBe('Intern');
  });

  it('handles empty string by returning empty string', () => {
    expect(personaDisplayName('')).toBe('');
  });
});
