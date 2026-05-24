import { describe, it, expect } from 'vitest';
import {
  parsePathReference,
  isValidCommitHash,
  tokenizeChatMessage,
  composeSelectionPrompt,
} from './chatRenderer.js';

describe('isValidCommitHash', () => {
  it('accepts a 7-char hex (git --abbrev=7 default)', () => {
    expect(isValidCommitHash('b0dd753')).toBe(true);
  });

  it('accepts a 40-char hex (full sha1)', () => {
    expect(isValidCommitHash('a'.repeat(40))).toBe(true);
    expect(isValidCommitHash('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it('accepts every length in [7..40]', () => {
    for (let n = 7; n <= 40; n++) {
      expect(isValidCommitHash('a'.repeat(n))).toBe(true);
    }
  });

  it('rejects too short (<7)', () => {
    expect(isValidCommitHash('')).toBe(false);
    expect(isValidCommitHash('abc')).toBe(false);
    expect(isValidCommitHash('123456')).toBe(false);
  });

  it('rejects too long (>40)', () => {
    expect(isValidCommitHash('a'.repeat(41))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidCommitHash('zzzzzzz')).toBe(false);
    expect(isValidCommitHash('b0dd75g')).toBe(false); // g is not hex
    expect(isValidCommitHash('B0DD753')).toBe(false); // uppercase is not accepted
  });

  it('rejects whitespace / leading-or-trailing punctuation', () => {
    expect(isValidCommitHash(' b0dd753')).toBe(false);
    expect(isValidCommitHash('b0dd753 ')).toBe(false);
    expect(isValidCommitHash('#b0dd753')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    // Defensive check at the function entry — caller might pass through
    // an untrusted webview message.
    expect(isValidCommitHash(undefined as unknown as string)).toBe(false);
    expect(isValidCommitHash(null as unknown as string)).toBe(false);
    expect(isValidCommitHash(123456789 as unknown as string)).toBe(false);
  });
});

describe('parsePathReference', () => {
  it('parses a workspace-relative path', () => {
    expect(parsePathReference('src/foo.ts')).toEqual({ path: 'src/foo.ts' });
  });

  it('parses path:line', () => {
    expect(parsePathReference('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42 });
  });

  it('parses path:line:column', () => {
    expect(parsePathReference('src/foo.ts:42:7')).toEqual({ path: 'src/foo.ts', line: 42, column: 7 });
  });

  it('accepts leading ./ and ../', () => {
    expect(parsePathReference('./foo.ts')).toBeDefined();
    expect(parsePathReference('../foo.ts')).toBeDefined();
  });

  it('returns undefined for an extensionless path (regex requires .ext)', () => {
    expect(parsePathReference('src/foo')).toBeUndefined();
  });

  it('returns undefined for empty / whitespace', () => {
    expect(parsePathReference('')).toBeUndefined();
    expect(parsePathReference('   ')).toBeUndefined();
  });

  it('returns undefined when the input is not a single clean reference', () => {
    // Input must be the WHOLE match — embedded paths are rejected so
    // the host's openPath handler can't be tricked by extra trailing
    // tokens. The match has to consume the whole input string.
    expect(parsePathReference('src/foo.ts and src/bar.ts')).toBeUndefined();
    expect(parsePathReference('see src/foo.ts')).toBeUndefined();
  });

  it('returns undefined for inputs with whitespace inside the path', () => {
    expect(parsePathReference('src/file with spaces.ts')).toBeUndefined();
  });

  it('returns undefined for bare filenames like "x" — needs an extension', () => {
    expect(parsePathReference('readme')).toBeUndefined();
  });
});

describe('tokenizeChatMessage — quick coverage of the core path', () => {
  // Heavier coverage of tokenizeChatMessage's overlapping-priority logic
  // would balloon the test file; the helpers above (parsePathReference +
  // isValidCommitHash) are the security-critical surface. tokenizeChatMessage
  // is tested at a smoke level here just to keep the export honest.

  it('returns an empty array for empty input', () => {
    expect(tokenizeChatMessage('')).toEqual([]);
  });

  it('returns a single plain segment for plain text', () => {
    expect(tokenizeChatMessage('hello world')).toEqual([{ kind: 'plain', text: 'hello world' }]);
  });

  it('tokenizes a code fence as a codeBlock segment', () => {
    const out = tokenizeChatMessage('before\n```ts\nconst x = 1;\n```\nafter');
    const cb = out.find(s => s.kind === 'codeBlock');
    // The closing ``` matches AFTER the trailing newline (per RE_CODE_FENCE),
    // so the text content keeps the newline. Renderers wrap in `<pre>` which
    // preserves whitespace identically — locking the shape.
    expect(cb).toMatchObject({ kind: 'codeBlock', text: 'const x = 1;\n', language: 'ts' });
  });

  it('tokenizes inline code', () => {
    const out = tokenizeChatMessage('see `foo()` for details');
    expect(out.some(s => s.kind === 'inlineCode' && s.text === 'foo()')).toBe(true);
  });

  it('tokenizes a commit hash in prose', () => {
    const out = tokenizeChatMessage('fix in b0dd753 lands the change');
    expect(out.some(s => s.kind === 'commitHash' && s.hash === 'b0dd753')).toBe(true);
  });

  it('does NOT tokenize a 7-hex fragment of a UUID (issue #2326 regression)', () => {
    const out = tokenizeChatMessage('prompt 80998aa-42ec-4d21-b8c4-6989d270abcd done');
    expect(out.every(s => s.kind !== 'commitHash')).toBe(true);
  });

  it('tokenizes bold (**…**)', () => {
    const out = tokenizeChatMessage('hello **world** stuff');
    expect(out.some(s => s.kind === 'bold' && s.text === 'world')).toBe(true);
  });

  it('tokenizes italic (*…*) but does not split bold', () => {
    expect(tokenizeChatMessage('an *italic* word').some(s => s.kind === 'italic' && s.text === 'italic')).toBe(true);
    // **foo** should be bold, NOT italic-italic — bold beats italic on priority.
    const bold = tokenizeChatMessage('**foo**');
    expect(bold.some(s => s.kind === 'bold' && s.text === 'foo')).toBe(true);
    expect(bold.every(s => s.kind !== 'italic')).toBe(true);
  });

  it('tokenizes a markdown link', () => {
    const out = tokenizeChatMessage('see [docs](https://example.com) for info');
    expect(out.some(s => s.kind === 'link' && s.href === 'https://example.com' && s.label === 'docs')).toBe(true);
  });

  it('tokenizes a path with line + column', () => {
    const out = tokenizeChatMessage('see src/foo.ts:42:7 for details');
    expect(out.some(s => s.kind === 'path' && s.path === 'src/foo.ts' && s.line === 42 && s.column === 7)).toBe(true);
  });

  it('tokenizes a path with just a line', () => {
    const out = tokenizeChatMessage('check src/foo.ts:10 please');
    expect(out.some(s => s.kind === 'path' && s.line === 10 && s.column === undefined)).toBe(true);
  });

  it('inline code beats bold inside the backticks', () => {
    const out = tokenizeChatMessage('use `**not-bold**` here');
    expect(out.some(s => s.kind === 'inlineCode' && s.text === '**not-bold**')).toBe(true);
    expect(out.every(s => s.kind !== 'bold')).toBe(true);
  });

  it('merges adjacent plain segments after tokenization (no spurious spans)', () => {
    const out = tokenizeChatMessage('plain text with no markdown');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('plain');
  });

  it('handles a code fence with no language label', () => {
    const out = tokenizeChatMessage('```\nbody\n```');
    const cb = out.find(s => s.kind === 'codeBlock');
    expect(cb).toMatchObject({ kind: 'codeBlock', text: 'body\n', language: undefined });
  });
});

describe('composeSelectionPrompt', () => {
  it('renders a single-line selection header', () => {
    const out = composeSelectionPrompt({
      relativePath: 'src/foo.ts',
      startLine: 0,
      endLine: 0,
      text: 'const x = 1;',
      languageId: 'typescript',
    });
    expect(out).toContain('From `src/foo.ts:1`');
    expect(out).toContain('```typescript\nconst x = 1;\n```');
  });

  it('renders a multi-line range header with both start and end (1-indexed, inclusive)', () => {
    const out = composeSelectionPrompt({
      relativePath: 'src/foo.ts',
      startLine: 5,
      endLine: 9,
      text: 'block',
    });
    expect(out).toContain('From `src/foo.ts:6-10`');
  });

  it('renders with an empty fence label when no languageId is given', () => {
    const out = composeSelectionPrompt({
      relativePath: 'x.txt',
      startLine: 0,
      endLine: 0,
      text: 'hi',
    });
    expect(out).toContain('```\nhi\n```');
  });
});
