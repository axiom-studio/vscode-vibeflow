import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CliConfig {
  serverUrl?: string;
  apiToken?: string;
  defaultProject?: string;
}

/**
 * Read the vibeflow-cli config file at ~/.vibeflow-cli/config.yaml
 * Returns undefined if the file doesn't exist.
 *
 * Lets users who have the CLI installed skip the VSCode Setup wizard —
 * the extension auto-connects using the same credentials.
 */
export function readCliConfig(): CliConfig | undefined {
  const configPath = path.join(os.homedir(), '.vibeflow-cli', 'config.yaml');
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
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { continue; }

    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (!match) { continue; }

    const key = match[1];
    let value = match[2].trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
