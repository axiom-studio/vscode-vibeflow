import { describe, expect, it } from 'vitest';
import { findRepoRoot } from './PRReviewPanel.js';

describe('findRepoRoot', () => {
  const repos = [
    { rootUri: { fsPath: '/w/other' }, state: { remotes: [{ fetchUrl: 'git@github.com:acme/other.git' }] } },
    { rootUri: { fsPath: '/w/repo' }, state: { remotes: [{ fetchUrl: 'git@github.com:Axiom-Studio/vscode-vibeflow.git' }] } },
  ];

  it('returns the root of the repository whose remote matches the reviewed clone URL', () => {
    // A subfolder workspace (/w/repo/src) still resolves finding paths against /w/repo.
    expect(findRepoRoot(repos, ['https://github.com/axiom-studio/vscode-vibeflow.git'])).toBe('/w/repo');
  });

  it('returns undefined when the reviewed repository is not open', () => {
    expect(findRepoRoot(repos, ['https://github.com/acme/missing.git'])).toBeUndefined();
  });
});
