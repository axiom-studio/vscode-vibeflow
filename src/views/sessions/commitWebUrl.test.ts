import { describe, expect, it } from 'vitest';
import { commitWebUrl } from './commitWebUrl.js';

const HASH = '575542919a42a19aaa654a5d0c1a8a6232d0e8dd';

describe('commitWebUrl', () => {
  it('builds GitHub URLs from scp-like and https remotes', () => {
    expect(commitWebUrl('git@github.com:axiom-studio/vscode-vibeflow.git', HASH))
      .toBe(`https://github.com/axiom-studio/vscode-vibeflow/commit/${HASH}`);
    expect(commitWebUrl('https://github.com/axiom-studio/vscode-vibeflow.git', HASH))
      .toBe(`https://github.com/axiom-studio/vscode-vibeflow/commit/${HASH}`);
    expect(commitWebUrl('https://github.com/axiom-studio/vscode-vibeflow', HASH))
      .toBe(`https://github.com/axiom-studio/vscode-vibeflow/commit/${HASH}`);
  });

  it('builds ssh:// form URLs and drops user info', () => {
    expect(commitWebUrl('ssh://git@github.com/owner/repo.git', HASH))
      .toBe(`https://github.com/owner/repo/commit/${HASH}`);
  });

  it('uses /commits/ for Bitbucket', () => {
    expect(commitWebUrl('git@bitbucket.org:workspace/slug.git', HASH))
      .toBe(`https://bitbucket.org/workspace/slug/commits/${HASH}`);
    expect(commitWebUrl('https://user@bitbucket.org/workspace/slug.git', HASH))
      .toBe(`https://bitbucket.org/workspace/slug/commits/${HASH}`);
  });

  it('uses /-/commit/ for GitLab hosts (including self-hosted)', () => {
    expect(commitWebUrl('git@gitlab.com:group/project.git', HASH))
      .toBe(`https://gitlab.com/group/project/-/commit/${HASH}`);
    expect(commitWebUrl('https://gitlab.example.com/group/project.git', HASH))
      .toBe(`https://gitlab.example.com/group/project/-/commit/${HASH}`);
  });

  it('accepts short hashes and rejects malformed ones', () => {
    expect(commitWebUrl('git@github.com:o/r.git', 'abc1234'))
      .toBe('https://github.com/o/r/commit/abc1234');
    expect(commitWebUrl('git@github.com:o/r.git', 'ABC1234')).toBeUndefined();
    expect(commitWebUrl('git@github.com:o/r.git', 'abc')).toBeUndefined();
    expect(commitWebUrl('git@github.com:o/r.git', `${HASH}x`)).toBeUndefined();
  });

  it('returns undefined for unparseable or path-less remotes', () => {
    expect(commitWebUrl('', HASH)).toBeUndefined();
    expect(commitWebUrl('not a remote', HASH)).toBeUndefined();
    expect(commitWebUrl('https://github.com/', HASH)).toBeUndefined();
    expect(commitWebUrl('/local/path/repo.git', HASH)).toBeUndefined();
  });

  it('tolerates trailing slashes and nested group paths', () => {
    expect(commitWebUrl('https://gitlab.com/group/sub/project/', HASH))
      .toBe(`https://gitlab.com/group/sub/project/-/commit/${HASH}`);
  });
});
