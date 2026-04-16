import * as vscode from 'vscode';

const GLOBAL_STATE_KEY = 'vibeflow.stickyModels';

/**
 * Default model assignments per persona.
 * Architect → Opus (reasoning), Developer/PE → Sonnet (speed), QA → Haiku (cost).
 */
const DEFAULT_MODELS: Record<string, string> = {
  developer: 'claude-sonnet-4-6',
  principal_engineer: 'claude-sonnet-4-6',
  architect: 'claude-opus-4-6',
  qa_lead: 'claude-haiku-4-5',
  security_lead: 'claude-sonnet-4-6',
  product_manager: 'claude-opus-4-6',
  project_manager: 'claude-sonnet-4-6',
  ux_designer: 'claude-sonnet-4-6',
  customer: 'claude-sonnet-4-6',
};

/**
 * Known models grouped by provider for the model picker.
 */
export const KNOWN_MODELS: Record<string, string[]> = {
  claude: [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ],
  codex: ['codex-mini', 'o3', 'o4-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  cursor: ['claude-sonnet-4-6', 'gpt-4.1'],
};

/**
 * Manages per-persona model preferences stored in globalState.
 * Each persona remembers its last-used model across sessions.
 */
export class StickyModels {
  private models: Record<string, string>;

  constructor(private readonly globalState: vscode.Memento) {
    const stored = globalState.get<Record<string, string>>(GLOBAL_STATE_KEY);
    this.models = { ...DEFAULT_MODELS, ...stored };
  }

  /**
   * Get the sticky model for a persona. Falls back to default.
   */
  getModel(persona: string): string {
    return this.models[persona] ?? DEFAULT_MODELS[persona] ?? 'claude-sonnet-4-6';
  }

  /**
   * Set the sticky model for a persona and persist.
   */
  async setModel(persona: string, model: string): Promise<void> {
    this.models[persona] = model;
    await this.globalState.update(GLOBAL_STATE_KEY, this.models);
  }

  /**
   * Get all persona → model mappings.
   */
  getAll(): Record<string, string> {
    return { ...this.models };
  }

  /**
   * Reset a persona to its default model.
   */
  async resetToDefault(persona: string): Promise<void> {
    const defaultModel = DEFAULT_MODELS[persona] ?? 'claude-sonnet-4-6';
    this.models[persona] = defaultModel;
    await this.globalState.update(GLOBAL_STATE_KEY, this.models);
  }
}
