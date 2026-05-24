# TypeScript Skill

You are working in a TypeScript codebase. Apply strict TypeScript practices.

## Compiler Settings

- Enable `"strict": true` — this activates `strictNullChecks`, `noImplicitAny`, and others.
- Enable `"noUncheckedIndexedAccess": true` — array/object index access returns `T | undefined`.
- Enable `"exactOptionalPropertyTypes": true` — distinguishes `{ x?: string }` from `{ x: string | undefined }`.
- Use `"moduleResolution": "NodeNext"` for Node.js projects with ESM.

## Type Definitions

- Prefer `interface` for objects that can be extended; use `type` for unions, intersections, and aliases.
- Use discriminated unions for state machines: `type State = { status: 'loading' } | { status: 'error'; error: Error } | { status: 'success'; data: Data }`.
- Avoid `any` — use `unknown` when the type is genuinely unknown, then narrow with type guards.
- Use `satisfies` to validate an expression matches a type without widening it.
- Use `as const` for literal types and tuple inference.

## Utility Types

- `Partial<T>` — all properties optional
- `Required<T>` — all properties required
- `Readonly<T>` — immutable
- `Pick<T, K>` / `Omit<T, K>` — select or exclude properties
- `ReturnType<typeof fn>` — infer return type of a function
- `Parameters<typeof fn>` — infer parameter tuple type
- `Awaited<T>` — unwrap a Promise type

## Narrowing

- Use `typeof x === 'string'`, `Array.isArray(x)`, `x instanceof Date` for runtime narrowing.
- Write type predicates: `function isUser(x: unknown): x is User { return … }`.
- Use `in` operator for discriminated union narrowing on string literal fields.

## Common Pitfalls

- `Object.keys(obj)` returns `string[]`, not `(keyof typeof obj)[]` — cast when needed.
- `JSON.parse()` returns `any` — always validate with Zod or another schema parser.
- `Date` comparisons: use `.getTime()` or convert to number for reliable comparison.
- Optional chaining (`?.`) and nullish coalescing (`??`) are your friends for safe access.

## Imports

- Use type-only imports for types that are erased at runtime: `import type { User } from './types.js'`.
- With `"module": "NodeNext"`, always include the `.js` extension in relative imports (even for `.ts` files).
