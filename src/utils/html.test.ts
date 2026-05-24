import { describe, it, expect } from 'vitest';
import { escapeHtml } from './html.js';

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
