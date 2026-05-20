/**
 * Framework allowlist + display labels — single source of truth for both
 * the host-side composer (`CompliancePanel.ts`) and the webview
 * (`ComplianceView.tsx`). Lives in this module (no `vscode` import) so
 * the webview bundler can pull it directly without dragging Node-only
 * deps into the browser context.
 *
 * Mirrors axiomcloud's `VibeflowComplianceFramework.IsValid`
 * (axiomcloud/database/vibeflow_models.go).
 */

export const COMPLIANCE_FRAMEWORKS = [
  'hipaa',
  'pcidss',
  'soc2',
  'iso27001',
  'gdpr',
  'cmmc',
  'fedramp',
] as const;

export type ComplianceFramework = typeof COMPLIANCE_FRAMEWORKS[number];

export const FRAMEWORK_LABEL: Record<ComplianceFramework, string> = {
  hipaa: 'HIPAA',
  pcidss: 'PCI-DSS',
  soc2: 'SOC 2',
  iso27001: 'ISO 27001',
  gdpr: 'GDPR',
  cmmc: 'CMMC',
  fedramp: 'FedRAMP',
};
