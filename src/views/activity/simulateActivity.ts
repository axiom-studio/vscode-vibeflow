import type { ActivityEntry } from '../../api/types.js';

const PERSONAS = [
  { key: 'developer', name: 'Developer' },
  { key: 'architect', name: 'Architect' },
  { key: 'qa_lead', name: 'QA Lead' },
  { key: 'security_lead', name: 'Security Lead' },
  { key: 'product_manager', name: 'Product Manager' },
  { key: 'principal_engineer', name: 'Principal Engineer' },
] as const;

const MESSAGE_TYPES: ActivityEntry['messageType'][] = [
  'status_change', 'thinking', 'action', 'observation',
  'prompt', 'commit', 'completion', 'error', 'summary',
];

const SAMPLE_CONTENT: Record<ActivityEntry['messageType'], string[]> = {
  status_change: [
    'claimed Todo #1234 — moved to planning',
    'moved Todo #1235 to implementing',
    'started session on main',
  ],
  thinking: [
    'Deciding between JWT rotation strategies',
    'Analyzing blast radius for auth middleware change',
    'Evaluating 3 approaches for rate limiting',
  ],
  action: [
    'Modified auth/middleware.go (+89 -12)',
    'Created auth/token.go (+45)',
    'Running go test ./auth/...',
  ],
  observation: [
    'Read auth.go — found existing rate limiter at line 45',
    'Found 3 callers of validateToken()',
    'Build output clean, 0 warnings',
  ],
  prompt: [
    'Should auth tokens expire after 15 min or 1 hour?',
    'Use middleware approach or per-handler rate limiting?',
    'Should I split this into 2 separate PRs?',
  ],
  commit: [
    'Add JWT auth middleware',
    'Fix token refresh race condition',
    'Add rate limiting to API handlers',
  ],
  completion: [
    'Completed Todo #1234 "Auth middleware" (+142 -28)',
    'Completed Issue #567 "API schema review"',
    'Completed Todo #890 "Dependency audit" — 0 critical findings',
  ],
  error: [
    'go test failed: TestCreateUser_DuplicateEmail — expected 409, got 500',
    'Build error: undefined reference to validateSession',
    'Lint error: unused import in handlers/auth.go',
  ],
  summary: [
    'Session summary: 3 todos completed, 5 files modified, +342 -89 lines',
    'Security scan complete: 0 critical, 2 medium, 1 low',
    'Code review: 4 files reviewed, 2 suggestions, 0 blockers',
  ],
};

function randomPick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

let entryCounter = 0;

function createEntry(minutesAgo: number): ActivityEntry {
  const persona = randomPick(PERSONAS);
  const messageType = randomPick(MESSAGE_TYPES);
  const content = randomPick(SAMPLE_CONTENT[messageType]);
  const timestamp = new Date(Date.now() - minutesAgo * 60_000).toISOString();

  const entry: ActivityEntry = {
    id: `sim-${++entryCounter}`,
    timestamp,
    personaKey: persona.key,
    personaName: persona.name,
    messageType,
    content,
  };

  if (messageType === 'commit') {
    entry.metadata = {
      files: ['auth/middleware.go', 'auth/session.go', 'auth/token.go'].slice(
        0, Math.floor(Math.random() * 3) + 1,
      ),
    };
  }

  if (messageType === 'prompt') {
    entry.metadata = { promptId: `prompt-${entryCounter}` };
  }

  return entry;
}

/**
 * Generate a batch of simulated activity entries.
 */
export function generateBatch(count: number): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (let i = count; i > 0; i--) {
    entries.push(createEntry(i * 0.5));
  }
  return entries;
}

/**
 * Create a single new entry as if it just happened.
 */
export function generateOne(): ActivityEntry {
  return createEntry(0);
}
