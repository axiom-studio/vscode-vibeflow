import * as fs from 'fs';
import * as path from 'path';

export interface CliConfig {
  serverUrl?: string;
  apiToken?: string;
  defaultProject?: string;
}

/**
 * Read the vibeflow-cli config file at `configPath` (the resolved CLI root's
 * config.yaml; see `currentCliConfigPath`). Returns undefined if it doesn't
 * exist.
 *
 * Lets users who have the CLI installed skip the VSCode Setup wizard —
 * the extension auto-connects using the same credentials.
 */
export function readCliConfig(configPath: string): CliConfig | undefined {
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return parseYaml(content);
  } catch {
    return undefined;
  }
}

/**
 * Minimal YAML parser for the flat fields we care about.
 * We avoid pulling in a YAML dependency for 3 string fields.
 */
function parseYaml(content: string): CliConfig {
  const config: CliConfig = {};
  for (const line of content.split('\n')) {
    // Top-level keys only, like upsertCliConfigScalars: an indented line
    // belongs to a nested mapping, never to these connection fields.
    if (/^\s/.test(line)) { continue; }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { continue; }

    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (!match) { continue; }

    const key = match[1];
    let value = match[2].trim();
    // Unquote. A YAML double-quoted scalar is JSON-compatible (and is what
    // writeCliConfig emits), so decode its escapes; single quotes just strip.
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }

    switch (key) {
      case 'server_url': config.serverUrl = value; break;
      case 'api_token': config.apiToken = value; break;
      case 'default_project': config.defaultProject = value; break;
    }
  }
  return config;
}

/** The connection fields the extension and the CLI share (#4033). */
export type CliConnectionFields = Partial<Record<'serverUrl' | 'apiToken' | 'defaultProject', string>>;

const CLI_CONFIG_KEYS = {
  serverUrl: 'server_url',
  apiToken: 'api_token',
  defaultProject: 'default_project',
} as const;

/**
 * Set top-level scalars in the CLI's config.yaml text, leaving every other
 * line untouched. vibeflow-cli rewrites the file whole with yaml.Marshal
 * (`SaveConfig`), where these three are always single-line top-level
 * scalars, so a line upsert is exact. Values are written as JSON strings,
 * which are valid YAML double-quoted scalars. Only provided fields change.
 */
export function upsertCliConfigScalars(content: string, fields: CliConnectionFields): string {
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  const missing: string[] = [];
  for (const [field, key] of Object.entries(CLI_CONFIG_KEYS) as [keyof CliConnectionFields, string][]) {
    const value = fields[field];
    if (value === undefined) { continue; }
    const line = `${key}: ${JSON.stringify(value)}`;
    // Top-level only; YAML allows spaces before the colon (`api_token : x`).
    const index = lines.findIndex(l => new RegExp(`^${key}\\s*:`).test(l));
    if (index >= 0) { lines[index] = line; } else { missing.push(line); }
  }
  return [...missing, ...lines].join('\n') + '\n';
}

/**
 * Mirror connection fields into the CLI's config.yaml so the extension and
 * the CLI never hold diverging credentials. Creates the root directory if
 * needed; the file is always left at mode 0600 like the CLI writes it.
 */
export function writeCliConfig(configPath: string, fields: CliConnectionFields): void {
  let existing = '';
  try {
    existing = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Atomic replace: write a sibling temp file, then rename over the original,
  // so a failed write (full disk, size limit) never truncates the CLI's file.
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, upsertCliConfigScalars(existing, fields), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, configPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
