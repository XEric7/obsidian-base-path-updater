import { build, context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  outfile: 'main.js',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  await (await context(options)).watch();
} else {
  await build(options);
  await mkdir('dist/base-path-updater', { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    await copyFile(file, `dist/base-path-updater/${file}`);
  }
}
