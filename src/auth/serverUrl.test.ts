import { describe, it, expect } from 'vitest';
import { validateServerUrl } from './serverUrl.js';

/**
 * Regression cohort for #1947 — `validateServerUrl` was silently
 * deleted in `e0ef3ad` and only caught by Sophie's QA walk days
 * later. These assertions are intended to fail loudly the next time
 * a refactor weakens the policy. Update the comment when the policy
 * itself changes (which would also require a #1947-class threat
 * model review).
 */

describe('validateServerUrl — accepts (ok branches)', () => {
  it('accepts plain https URL', () => {
    const r = validateServerUrl('https://cloud.axiomstudio.ai');
    expect(r.ok).toBe(true);
    expect(r.url?.protocol).toBe('https:');
  });

  it('accepts https with port + path + query + fragment', () => {
    const r = validateServerUrl('https://example.com:8443/api?x=1#frag');
    expect(r.ok).toBe(true);
    expect(r.url?.hostname).toBe('example.com');
  });

  it('accepts http://localhost (local dev escape hatch)', () => {
    const r = validateServerUrl('http://localhost');
    expect(r.ok).toBe(true);
  });

  it('accepts http://localhost:3000', () => {
    const r = validateServerUrl('http://localhost:3000');
    expect(r.ok).toBe(true);
  });

  it('accepts http://127.0.0.1', () => {
    const r = validateServerUrl('http://127.0.0.1');
    expect(r.ok).toBe(true);
  });

  it('accepts http://[::1] (IPv6 loopback)', () => {
    const r = validateServerUrl('http://[::1]');
    expect(r.ok).toBe(true);
  });

  it('accepts http://[::1]:3000', () => {
    const r = validateServerUrl('http://[::1]:3000');
    expect(r.ok).toBe(true);
  });

  it('strips surrounding whitespace before validating', () => {
    const r = validateServerUrl('  https://example.com  ');
    expect(r.ok).toBe(true);
  });
});

describe('validateServerUrl — rejects (security branches)', () => {
  it('rejects empty string with a "required" message', () => {
    const r = validateServerUrl('');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/required/i);
  });

  it('rejects whitespace-only input', () => {
    const r = validateServerUrl('   \t\n  ');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/required/i);
  });

  it('rejects a non-URL string', () => {
    const r = validateServerUrl('not a url');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not a valid url/i);
  });

  it('rejects bare hostnames (no scheme)', () => {
    const r = validateServerUrl('cloud.axiomstudio.ai');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not a valid url/i);
  });

  it('rejects http:// for a non-local hostname — the core #1947 case', () => {
    const r = validateServerUrl('http://cloud.axiomstudio.ai');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/HTTPS/i);
    expect(r.message).toMatch(/localhost/i);
  });

  it('rejects http:// against a non-local IP', () => {
    const r = validateServerUrl('http://8.8.8.8');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/HTTPS/i);
  });

  it('rejects http:// against a hostname that LOOKS local but is not (e.g. localhost.evil.com)', () => {
    const r = validateServerUrl('http://localhost.evil.com');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/HTTPS/i);
  });

  it('rejects file:// scheme', () => {
    const r = validateServerUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unsupported scheme/i);
    expect(r.message).toContain('file:');
  });

  it('rejects javascript: scheme — XSS-class vector', () => {
    const r = validateServerUrl('javascript:alert(1)');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unsupported scheme/i);
  });

  it('rejects data: scheme', () => {
    const r = validateServerUrl('data:text/plain,hello');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unsupported scheme/i);
  });

  it('rejects ftp:// scheme', () => {
    const r = validateServerUrl('ftp://example.com');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unsupported scheme/i);
  });

  it('rejects ws:// scheme (would need its own allowlist)', () => {
    const r = validateServerUrl('ws://example.com');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unsupported scheme/i);
  });
});

describe('validateServerUrl — shape contract', () => {
  it('returns a `url` property only when ok is true', () => {
    const okR = validateServerUrl('https://example.com');
    expect(okR.url).toBeInstanceOf(URL);
    const badR = validateServerUrl('http://example.com');
    expect(badR.url).toBeUndefined();
  });

  it('returns a `message` property only when ok is false', () => {
    const okR = validateServerUrl('https://example.com');
    expect(okR.message).toBeUndefined();
    const badR = validateServerUrl('');
    expect(typeof badR.message).toBe('string');
  });
});
