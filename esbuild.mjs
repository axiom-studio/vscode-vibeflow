import * as esbuild from 'esbuild';
import * as path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * In production, swap the dev-only activity simulator for a stub that
 * throws if anything tries to use it. The
 * `vibeflow.debug.simulateActivity` setting is documented as dev-only
 * and ships defaulted to false, so the stub is unreachable under
 * normal use. This keeps the simulator's fake personas + sample log
 * content out of the shipped .vsix entirely.
 *
 * Implemented as an `onResolve` plugin (rather than the `alias` option)
 * because `alias` only matches bare module specifiers cleanly — relative
 * paths like `./views/activity/simulateActivity.js` are best handled by
 * intercepting the resolver directly.
 */
const stripDevSimulator = {
  name: 'strip-dev-simulator',
  setup(build) {
    if (!production) { return; }
    build.onResolve({ filter: /(^|\/)simulateActivity\.js$/ }, args => {
      // Only redirect imports from inside our own source tree — third-party
      // packages happening to share the filename would be left alone.
      if (!args.importer.includes(`${path.sep}src${path.sep}`) && !args.importer.includes('/src/')) {
        return undefined;
      }
      return {
        path: path.resolve('src/views/activity/simulateActivity.prod-stub.ts'),
      };
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: 'info',
  plugins: [stripDevSimulator],
});

if (watch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
