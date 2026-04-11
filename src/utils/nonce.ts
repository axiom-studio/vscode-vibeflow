import { randomBytes } from 'crypto';

/**
 * Generate a cryptographically secure nonce for CSP script-src.
 * Uses crypto.randomBytes instead of Math.random().
 */
export function getNonce(): string {
  return randomBytes(16).toString('hex');
}
