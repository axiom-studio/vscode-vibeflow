/**
 * Persona classification — code agents vs advisory agents.
 * Code agents modify git and get visible terminals by default.
 * Advisory agents don't touch code and run hidden in hybrid mode.
 *
 * Must stay in sync with codeAgentKeys in:
 * - vibeflow-cli/internal/vibeflowcli/tui_wizard.go
 * - axiomcloud/database/vibeflow_models.go GitModifyingPersonas
 */
export const CODE_AGENT_PERSONAS = new Set([
  'developer',
  'architect',
  'principal_engineer',
]);

export function isCodeAgent(personaKey: string): boolean {
  return CODE_AGENT_PERSONAS.has(personaKey);
}

export const PERSONA_DISPLAY_NAMES: Record<string, string> = {
  developer: 'Developer',
  architect: 'Architect',
  principal_engineer: 'Principal Engineer',
  security_lead: 'Security Lead',
  qa_lead: 'QA Lead',
  product_manager: 'Product Manager',
  project_manager: 'Project Manager',
  ux_designer: 'UX Designer',
  customer: 'Customer',
};

export function personaDisplayName(key: string): string {
  return PERSONA_DISPLAY_NAMES[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
