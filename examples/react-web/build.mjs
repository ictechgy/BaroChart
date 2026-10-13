import {build} from 'esbuild';
import {mkdir, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
await mkdir(join(root, 'dist'), {recursive: true});
await build({absWorkingDir: root, entryPoints: ['main.tsx'], bundle: true,
  outfile: join(root, 'dist/main.js'), format: 'esm', platform: 'browser', target: 'es2022',
  preserveSymlinks: true, minify: true, legalComments: 'eof',
  define: {'process.env.NODE_ENV': '"production"'}});
for (const file of ['index.html', 'style.css']) await copyFile(join(root, file), join(root, 'dist', file));
console.log('Built React web example in examples/react-web/dist');
