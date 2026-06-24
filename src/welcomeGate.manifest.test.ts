import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Locks the startup setup-gate contract (todo #2058). The activity-bar must
 * show a Welcome / Get Started view when the extension is NOT configured and
 * the four work sections only once `vibeflow.configured` is true. That
 * routing lives entirely in package.json `when` clauses + the `viewsWelcome`
 * contribution, so we assert against the real manifest — no mocks.
 */

interface ViewContribution {
  id: string;
  name: string;
  type: string;
  when?: string;
}
interface ViewsWelcome {
  view: string;
  contents: string;
}

// vitest runs from the repo root, so the manifest sits at <cwd>/package.json.
const manifestPath = join(process.cwd(), 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  contributes: {
    views: { vibeflow: ViewContribution[] };
    viewsWelcome: ViewsWelcome[];
  };
};

const vibeflowViews = manifest.contributes.views.vibeflow;
const viewById = (id: string) => vibeflowViews.find(v => v.id === id);

const GATED_SECTION_VIEWS = [
  'vibeflow.agentFleet',
  'vibeflow.workItems',
  'vibeflow.browse',
  'vibeflow.pullRequests',
  'vibeflow.documents',
];

describe('startup setup-gate (todo #2058) — package.json contract', () => {
  it('contributes a dedicated Welcome view shown only when NOT configured', () => {
    const welcome = viewById('vibeflow.welcome');
    expect(welcome, 'vibeflow.welcome view must exist in the vibeflow container').toBeDefined();
    // `!vibeflow.configured` is what makes the gate default-open on a fresh
    // install (the context key is undefined → falsy → welcome shows).
    expect(welcome?.when).toBe('!vibeflow.configured');
  });

  it.each(GATED_SECTION_VIEWS)('gates the "%s" section behind vibeflow.configured', viewId => {
    const view = viewById(viewId);
    expect(view, `${viewId} must still be contributed`).toBeDefined();
    expect(view?.when).toBe('vibeflow.configured');
  });

  it('the Welcome and section gates are exact complements (no overlap, no gap)', () => {
    // Exactly one of {welcome, sections} renders for any value of the key.
    const welcome = viewById('vibeflow.welcome');
    const sections = GATED_SECTION_VIEWS.map(viewById);
    expect(welcome?.when).toBe('!vibeflow.configured');
    for (const s of sections) {
      expect(s?.when).toBe('vibeflow.configured');
    }
  });

  it('the Welcome view offers a Get Started button wired to the Setup command', () => {
    const entry = manifest.contributes.viewsWelcome.find(w => w.view === 'vibeflow.welcome');
    expect(entry, 'a viewsWelcome entry for vibeflow.welcome must exist').toBeDefined();
    // The button text + command link are the actual onboarding affordance.
    expect(entry?.contents).toContain('[Get Started](command:vibeflow.setup)');
    // Sanity: the copy tells the user what the wizard will ask for.
    expect(entry?.contents.toLowerCase()).toContain('api key');
  });
});
