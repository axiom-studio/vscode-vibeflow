import { useMemo } from 'react';

export interface Section {
  heading: string;
  lines: string[];
}

/**
 * Parse markdown content into sections split by H2 headings.
 * Matches axiomcloud's parseSections() from DocumentPopoutModal.jsx line 8-29 exactly.
 * Identical output is required so section_heading strings align with the web UI.
 */
export function parseSections(content: string): Section[] {
  if (!content) { return []; }
  const lines = content.split('\n');
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      if (current) { sections.push(current); }
      current = { heading: h2Match[1], lines: [line] };
    } else {
      if (!current) {
        current = { heading: '', lines: [line] };
      } else {
        current.lines.push(line);
      }
    }
  }
  if (current) { sections.push(current); }
  return sections;
}

/**
 * React hook wrapper around parseSections with memoization.
 */
export function useSections(markdown: string): Section[] {
  return useMemo(() => parseSections(markdown), [markdown]);
}

/**
 * Re-assemble a section back into a markdown string.
 */
export function sectionToMarkdown(section: Section): string {
  return section.lines.join('\n');
}
