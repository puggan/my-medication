// Bundle the server and its dependencies into one file, so the deployed copy needs only Node
import { build } from 'esbuild';

await build({
    entryPoints: ['src/main.ts'],
    outfile: 'dist/server.mjs',
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    // Some dependencies still call require(); give the ESM bundle one
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'info',
});
