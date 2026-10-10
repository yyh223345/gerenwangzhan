/* 本地开发与构建服务：npm start 启动（端口 8644，与旧预览地址/origin 一致，保留浏览器 IndexedDB 草稿）
 * - 静态服务根目录（Cache-Control: no-cache，规避旧缓存）
 * - GET  /api/ping   ：构建服务探针（内容工坊导出前探测）
 * - POST /api/export ：「保存并导出」——接收工坊数据 JSON → 写入 data/site-data.json → 触发 build.js
 *   构建（产出 dist/index.html 并同步根 index.html）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { build } = require('./build.js');

const ROOT = __dirname;
const PORT = 8644;
const DATA_FILE = path.join(ROOT, 'data', 'site-data.json');
const MAX_BODY = 64 * 1024 * 1024; // 数据体上限 64MB（当前约 25MB）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, '404 Not Found', 'text/plain; charset=utf-8');
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

/* 接收工坊导出数据：校验 → 写数据源 → 构建 */
function handleExport(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    let body;
    try {
      body = Buffer.concat(chunks).toString('utf8');
      const data = JSON.parse(body);
      if (!data || !Array.isArray(data.works)) throw new Error('数据格式错误：缺少 works 数组');
    } catch (e) {
      return send(res, 400, JSON.stringify({ ok: false, error: '数据无效：' + e.message }));
    }
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, body); // 原文即紧凑 JSON，直接作为数据源
      const r = build();
      console.log(`[export] ${new Date().toLocaleTimeString('zh-CN')} 构建完成 works=${r.works} ${r.mb}MB`);
      send(res, 200, JSON.stringify({ ok: true, works: r.works, mb: r.mb }));
    } catch (e) {
      console.error('[export] 构建失败：', e.message);
      send(res, 500, JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

/* 启动时先构建一次，确保 dist 与数据源同步 */
try { build(); } catch (e) { console.error('[start] 首次构建失败：', e.message); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && u.pathname === '/api/ping') {
    return send(res, 200, JSON.stringify({ ok: true, service: 'chengying-node-builder' }));
  }
  if (req.method === 'POST' && u.pathname === '/api/export') return handleExport(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, u.pathname);
  send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[start] 端口 ${PORT} 被占用：请先停掉占用它的程序（如旧的 python http.server 或其他本服务实例）再运行 npm start`);
  } else { console.error('[start] 服务错误：', e.message); }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[start] 承影站点服务已启动：http://localhost:${PORT}/  （Ctrl+C 停止）`);
  console.log('[start] 保存并导出 = 工坊按钮 → /api/export → data/site-data.json → dist/index.html');
});
