// Servidor estático de desenvolvimento que reproduz o GitHub Pages:
// o app é servido em um subdiretório (padrão /guia-financeiro/).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown' };

export function startServer({ port = 0, base = '/guia-financeiro/' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(base)) { res.writeHead(404).end('fora do subdiretório'); return; }
    let rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT) || rel.split('/').some((p) => p === 'node_modules')) { res.writeHead(403).end(); return; }
    try {
      const st = await stat(file);
      const target = st.isDirectory() ? join(file, 'index.html') : file;
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': TYPES[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('não encontrado'); }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}${base}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  startServer({ port }).then(({ url }) => console.log(`Guia Financeiro em ${url}`));
}
