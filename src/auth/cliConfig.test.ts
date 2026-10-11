import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCliConfig, upsertCliConfigScalars, writeCliConfig } from './cliConfig.js';

// Shaped like vibeflow-cli's yaml.Marshal output (SaveConfig): the three
// connection keys first, then everything else the CLI owns.
const CLI_CONFIG = [
  'server_url: https://old.example.com',
  'api_token: old-token',
  'default_project: ""',
  'default_work_dir: /work',
  'providers:',
  '  claude:',
  '    binary: claude',
  'review_concurrency: 2',
  '',
].join('\n');

describe('upsertCliConfigScalars', () => {
  it('replaces the connection keys and leaves every other line alone', () => {
    const out = upsertCliConfigScalars(CLI_CONFIG, {
      serverUrl: 'https://cloud.example.com',
      apiToken: 'new-token',
      defaultProject: 'vscode-vibeflow',
    });
    expect(out).toBe([
      'server_url: "https://cloud.example.com"',
      'api_token: "new-token"',
      'default_project: "vscode-vibeflow"',
      'default_work_dir: /work',
      'providers:',
      '  claude:',
      '    binary: claude',
      'review_concurrency: 2',
      '',
    ].join('\n'));
  });

  it('changes only the fields provided, so a missing project never blanks the CLI default', () => {
    const out = upsertCliConfigScalars('default_project: keep-me\n', { apiToken: 't' });
    expect(out).toBe('api_token: "t"\ndefault_project: keep-me\n');
  });

  it('writes a fresh file when there is no config yet', () => {
    expect(upsertCliConfigScalars('', { serverUrl: 'https://a.example', apiToken: 't' }))
      .toBe('server_url: "https://a.example"\napi_token: "t"\n');
  });

  // #5762: YAML allows spaces before the colon; replace, never duplicate.
  it('replaces a key written with whitespace before the colon', () => {
    const out = upsertCliConfigScalars('api_token : old\nserver_url  :  https://old\n', { apiToken: 'new', serverUrl: 'https://new' });
    expect(out).toBe('api_token: "new"\nserver_url: "https://new"\n');
  });

  it('does not treat a nested key with the same name as the top-level key', () => {
    const out = upsertCliConfigScalars('nested:\n  api_token: inner\n', { apiToken: 'outer' });
    expect(out).toBe('api_token: "outer"\nnested:\n  api_token: inner\n');
  });
});

describe('writeCliConfig', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-cli-config-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates the root directory and a 0600 file the reader understands', () => {
    const configPath = path.join(dir, 'custom-root', 'config.yaml');
    writeCliConfig(configPath, { serverUrl: 'https://cloud.example.com', apiToken: 'tok', defaultProject: 'p1' });

    expect(readCliConfig(configPath)).toEqual({ serverUrl: 'https://cloud.example.com', apiToken: 'tok', defaultProject: 'p1' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });

  it('round-trips a token containing YAML-significant characters', () => {
    const configPath = path.join(dir, 'config.yaml');
    const apiToken = 'a"b:c#d\\e';
    writeCliConfig(configPath, { apiToken });
    expect(readCliConfig(configPath)?.apiToken).toBe(apiToken);
  });

  it('reads only top-level keys, never a nested key with the same name', () => {
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, 'providers:\n  x:\n    api_token: nested\napi_token: top\n');
    expect(readCliConfig(configPath)?.apiToken).toBe('top');
  });

  // #5759: a failed save must leave the CLI's existing config intact.
  it('leaves the original file untouched and no temp file when the write fails', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) { return; }
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, CLI_CONFIG, { mode: 0o600 });
    fs.chmodSync(dir, 0o500); // no new files can be created in the root
    try {
      expect(() => writeCliConfig(configPath, { apiToken: 'rotated' })).toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(CLI_CONFIG);
    expect(fs.readdirSync(dir)).toEqual(['config.yaml']);
  });

  it('tightens an existing looser file to 0600 while preserving its other keys', () => {
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, CLI_CONFIG, { mode: 0o644 });
    writeCliConfig(configPath, { apiToken: 'rotated' });

    const text = fs.readFileSync(configPath, 'utf-8');
    expect(text).toContain('api_token: "rotated"');
    expect(text).toContain('review_concurrency: 2');
    if (process.platform !== 'win32') {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });
});
