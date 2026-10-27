// Bundles the MCP server and its dependencies into server/dist/index.js,
// so the Claude Code plugin works straight from a git checkout (no npm install).
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.js'],
  outfile: 'server/dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'linked',
  // ws uses require() for optional native addons; give the ESM bundle a real require.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
console.log('Built server/dist/index.js');
