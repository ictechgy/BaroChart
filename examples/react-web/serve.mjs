import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import './build.mjs';
const root = fileURLToPath(new URL('./dist/', import.meta.url));
const files = {'/': ['index.html', 'text/html'], '/main.js': ['main.js', 'text/javascript'], '/style.css': ['style.css', 'text/css']};
const server = createServer(async (request, response) => {
  const match = files[new URL(request.url, 'http://127.0.0.1').pathname];
  if (!match) {response.writeHead(404); response.end(); return;}
  try {response.writeHead(200, {'Content-Type': match[1], 'Cache-Control': 'no-store'}); response.end(await readFile(join(root, match[0])));}
  catch {response.writeHead(500); response.end('Run npm run build first.');}
});
server.listen(Number(process.env.PORT ?? 5174), '127.0.0.1', () => console.log(`React example: http://127.0.0.1:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit()));
