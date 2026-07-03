import { describe, it, expect } from 'vitest';
import { escapeHtml, serverOriginForCsp } from './html.js';

describe('escapeHtml', () => {
  it('escapes ampersand first to avoid double-escaping subsequent entities', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    // If `&` were escaped LAST, the `&` in `&lt;` would itself get
    // re-escaped to `&amp;lt;`. Regression-asserts the order.
    expect(escapeHtml('< &')).toBe('&lt; &amp;');
  });

  it('escapes the four HTML-special characters', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml('&')).toBe('&amp;');
  });

  it('escapes a script-tag payload', () => {
    expect(escapeHtml('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('preserves single quotes and other punctuation verbatim', () => {
    // Single quote is deliberately NOT escaped — HTML attributes in
    // this codebase use double quotes, so apostrophe-in-text doesn't
    // need entity treatment. Lock that behavior.
    expect(escapeHtml(`it's`)).toBe(`it's`);
    expect(escapeHtml('!@#$%^*()_+`~/\\?,.')).toBe('!@#$%^*()_+`~/\\?,.');
  });

  it('passes the empty string through unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('handles a string with no escapable chars unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes repeated occurrences', () => {
    expect(escapeHtml('<<>>')).toBe('&lt;&lt;&gt;&gt;');
    expect(escapeHtml('&&&')).toBe('&amp;&amp;&amp;');
  });

  it('escapes a mixed sentence with all four specials', () => {
    expect(escapeHtml('Tom & Jerry said "<hi>"'))
      .toBe('Tom &amp; Jerry said &quot;&lt;hi&gt;&quot;');
  });
});

/**
 * CSP origin derivation for webview img-src (#2773): the token must carry
 * the environment's REAL scheme — http for local test servers, https in
 * prod — and must be safe to drop ('' return) on garbage input.
 */
describe('serverOriginForCsp', () => {
  it('returns the origin for http and https server URLs, dropping paths and trailing slashes', () => {
    expect(serverOriginForCsp('http://localhost:8080')).toBe('http://localhost:8080');
    expect(serverOriginForCsp('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(serverOriginForCsp('https://cloud.axiomstudio.ai/some/prefix')).toBe('https://cloud.axiomstudio.ai');
  });

  it('preserves nonstandard ports and drops default ones like the URL spec does', () => {
    expect(serverOriginForCsp('http://192.168.1.10:9000')).toBe('http://192.168.1.10:9000');
    expect(serverOriginForCsp('https://example.com:443')).toBe('https://example.com');
  });

  it('returns empty for unparseable input and non-http(s) schemes', () => {
    expect(serverOriginForCsp('')).toBe('');
    expect(serverOriginForCsp('not a url')).toBe('');
    expect(serverOriginForCsp('ftp://example.com')).toBe('');
    expect(serverOriginForCsp('javascript:alert(1)')).toBe('');
  });
});
