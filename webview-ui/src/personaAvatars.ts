/**
 * Persona avatar paths served by axiomcloud at
 * `{serverUrl}/persona/professional/{Char}_{Role}.jpg`. Mirrors the seed
 * migration in `axiomcloud/migrations/{postgres,sqlite}/*_add_*_persona.up.sql`
 * (persona_key → professional avatar path) — keep in sync if a persona is
 * added on the backend.
 *
 * Shared between DashboardView (agent topology nodes) and the Session Chat
 * panel (chat header + message bubbles) so the two surfaces stay visually
 * consistent. Single source of truth for the persona → portrait mapping.
 */
export const AVATAR_BY_PERSONA: Record<string, string> = {
  developer: '/persona/professional/Alex_Developer.jpg',
  architect: '/persona/professional/Morgan_Architect.jpg',
  principal_engineer: '/persona/professional/Kai_PrincipalEngineer.jpg',
  security_lead: '/persona/professional/Sophie_Security.jpg',
  qa_lead: '/persona/professional/Quinn_QA.jpg',
  product_manager: '/persona/professional/Aria_Product.jpg',
  project_manager: '/persona/professional/Parker_Project.jpg',
  ux_designer: '/persona/professional/Dana_UXDesigner.jpg',
  customer: '/persona/professional/Casey_Customer.jpg',
};

/**
 * Compose the absolute avatar URL for a persona. Returns undefined when the
 * persona key is unknown or the serverUrl is missing (callers fall back to
 * a letter glyph in that case).
 */
export function personaAvatarUrl(personaKey: string, serverUrl: string | undefined): string | undefined {
  const path = AVATAR_BY_PERSONA[personaKey];
  if (!path || !serverUrl) { return undefined; }
  return `${serverUrl.replace(/\/$/, '')}${path}`;
}
