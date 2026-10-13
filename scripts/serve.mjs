import {createServer} from 'node:http';
import {readFile,stat,realpath} from 'node:fs/promises';
import {resolve,extname,sep,relative} from 'node:path';
const root=resolve(import.meta.dirname,'..'),port=Number(process.env.PORT??5173);
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png'};
const publicPath=name=>name.startsWith('/src/')||name.startsWith('/examples/web/')||name.startsWith('/examples/indicators/')||name.startsWith('/examples/vendor/')||name==='/benchmarks/harness.html'||name.startsWith('/benchmarks/vendor/');
createServer(async(req,res)=>{
 try {
  if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host??'')){res.writeHead(403);res.end('Local host required');return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(name==='/')name='/examples/web/index.html';
  if(name.split('/').some(part=>part.startsWith('.'))||!publicPath(name)){res.writeHead(403);res.end('Public demo assets only');return;}
  let file=resolve(root,'.'+name);if(!file.startsWith(root+sep))throw new Error('Path');if((await stat(file)).isDirectory())file+='/index.html';file=await realpath(file);
  if(!file.startsWith(root+sep)||!publicPath('/'+relative(root,file).split(sep).join('/'))){res.writeHead(403);res.end();return;}
  res.setHeader('Content-Type',types[extname(file)]??'application/octet-stream');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: blob:");
  if(req.method==='HEAD')res.end();else res.end(await readFile(file));
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Aster demo: http://127.0.0.1:${port}/examples/web/`));
