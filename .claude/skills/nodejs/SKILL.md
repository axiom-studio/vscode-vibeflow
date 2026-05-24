# Node.js Skill

You are working on a Node.js project. Apply these best practices.

## ES Modules

- Use `"type": "module"` in `package.json` for native ESM.
- Always include the file extension in relative imports: `import { foo } from './foo.js'`.
- Use `import.meta.url` and `fileURLToPath` to get `__filename` / `__dirname`:
  ```ts
  import { fileURLToPath } from 'node:url';
  import { dirname } from 'node:path';
  const __dirname = dirname(fileURLToPath(import.meta.url));
  ```

## Built-in Modules

- Prefix built-in imports with `node:` to distinguish from npm packages: `import { readFile } from 'node:fs/promises'`.
- Use `node:fs/promises` instead of callback-based `fs` for async file operations.
- Use `node:crypto` for hashing and cryptographic operations — never implement crypto manually.
- Use `node:os.homedir()` instead of `process.env.HOME` for the home directory (cross-platform).

## Async Patterns

- Use `async/await` with `try/catch` for sequential async operations.
- Use `Promise.all()` for concurrent operations; `Promise.allSettled()` when you need all results regardless of failures.
- Use `AbortController` + `AbortSignal` for cancellable operations and fetch timeouts.

## Process & Environment

- Access env vars via `process.env.VAR_NAME ?? 'default'` — validate at startup with a schema.
- Handle `process.on('uncaughtException')` and `process.on('unhandledRejection')` for graceful shutdown logging.
- Use `process.exitCode = 1` instead of `process.exit(1)` when possible to allow drain.

## Child Processes

- Use `execa` or `node:child_process`'s `execFile` (not `exec`) to run shell commands safely — never interpolate user input into shell strings.
- Stream large outputs with `child.stdout.pipe(process.stdout)`.

## Performance

- Use `worker_threads` for CPU-intensive work to avoid blocking the event loop.
- Use `stream.pipeline()` (not `.pipe()`) for stream error handling.
- Profile with `--inspect` and Chrome DevTools or `clinic.js` before optimizing.

## Security

- Never use `eval()` or `new Function()` with user-provided strings.
- Validate all environment variables and external inputs at the boundary.
- Use `crypto.timingSafeEqual()` for comparing secrets — never `===`.
