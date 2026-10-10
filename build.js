/* 构建脚本：数据源 data/site-data.json + 模板 index.html → 两份产物
 * 1) 根 index.html：单文件版（dataURI 全内嵌，本地预览/双击打开可用）
 * 2) dist/index.html + dist/assets/*：拆分版（>100KB 的 dataURI 资源拆为独立文件），
 *    符合 Cloudflare Pages 单文件 25MiB 上限，用于部署
 * 用法：npm run build（或 node build.js）
 * 首次运行会自动从模板 index.html 内嵌的 <script id="site-data"> 提取数据初始化 data/site-data.json，
 * 之后数据源以 data/site-data.json 为准（内容工坊「保存并导出」会自动更新它）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TPL = path.join(ROOT, 'index.html');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'site-data.json');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_FILE = path.join(DIST_DIR, 'index.html');
const SITE_DATA_RE = /(<script id="site-data"[^>]*>)([\s\S]*?)(<\/script>)/;
const INLINE_KEEP = 100 * 1024; // <100KB 的 dataURI 保留内嵌（控制请求数），超过的拆为 assets 文件
const EXT_OF_MIME = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };

/* 从模板 HTML 提取内嵌 site-data JSON（仅用于首次初始化数据源） */
function extractFromTemplate(html) {
  const m = html.match(SITE_DATA_RE);
  if (!m) throw new Error('模板中未找到 <script id="site-data">');
  return JSON.parse(m[2].trim());
}

/* 把 data 对象里 >100KB 的 dataURI 字段拆写为 dist/assets/ 文件并替换为相对 URL（返回统计） */
function splitAssets(data, distDir) {
  const assetsDir = path.join(distDir, 'assets');
  let count = 0, bytes = 0;
  const seen = new Map(); // 相同 dataURI 复用同一文件（如图片同时用于主页与展示区）
  function splitUri(uri, baseName) {
    const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(uri);
    if (!m) return uri; // 非 dataURI（如 B 站封面外链）原样保留
    if (seen.has(uri)) return seen.get(uri);
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < INLINE_KEEP) return uri;
    const ext = EXT_OF_MIME[m[1]] || (m[1].split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
    const file = `${baseName}.${ext}`;
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, file), buf);
    const url = 'assets/' + file;
    seen.set(uri, url);
    count++; bytes += buf.length;
    return url;
  }
  (data.works || []).forEach((w, i) => {
    if (typeof w.src === 'string' && w.src.startsWith('data:')) w.src = splitUri(w.src, w.id || 'w' + i);
    if (typeof w.cover === 'string' && w.cover.startsWith('data:')) w.cover = splitUri(w.cover, 'cover_' + (w.id || 'w' + i));
  });
  if (data.site && typeof data.site.heroBg === 'string' && data.site.heroBg.startsWith('data:')) {
    data.site.heroBg = splitUri(data.site.heroBg, 'heroBg');
  }
  return { count, bytes };
}

function build() {
  const html = fs.readFileSync(TPL, 'utf8');
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(extractFromTemplate(html)));
    console.log('[build] 已从模板初始化数据源 data/site-data.json');
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(data.works)) throw new Error('data/site-data.json 格式错误：缺少 works 数组');
  /* 注入 HTML 前 < 转义为 \u003c，防 </script> 提前闭合（与浏览器端导出逻辑一致） */

  // 产物 1：根 index.html 单文件版（dataURI 内嵌）
  const singleJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const singleOut = html.replace(SITE_DATA_RE, (m, open) => open + '\n' + singleJson + '\n</script>');
  fs.writeFileSync(TPL, singleOut);

  // 产物 2：dist/ 拆分版（大资源 → assets/ 文件，HTML 引用相对路径）
  fs.rmSync(DIST_DIR, { recursive: true, force: true }); // 清旧产物，防残留已删除作品的 assets
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const distData = JSON.parse(JSON.stringify(data));
  const assets = splitAssets(distData, DIST_DIR);
  const distJson = JSON.stringify(distData).replace(/</g, '\\u003c');
  const distOut = html.replace(SITE_DATA_RE, (m, open) => open + '\n' + distJson + '\n</script>');
  fs.writeFileSync(DIST_FILE, distOut);

  const mb = (Buffer.byteLength(distOut) / 1048576).toFixed(1);
  const total = ((assets.bytes + Buffer.byteLength(distOut)) / 1048576).toFixed(1);
  console.log(`[build] works=${data.works.length}`);
  console.log(`[build] 根 index.html（单文件预览版）→ ${(Buffer.byteLength(singleOut) / 1048576).toFixed(1)}MB`);
  console.log(`[build] dist/index.html → ${mb}MB + assets ${assets.count} 个文件（${(assets.bytes / 1048576).toFixed(1)}MB），部署总量 ${total}MB`);
  if (Buffer.byteLength(distOut) > 25 * 1024 * 1024) {
    console.warn('[build] 警告：dist/index.html 超过 Cloudflare Pages 单文件 25MiB 限制，请增大资源拆分比例');
  }
  return { ok: true, works: data.works.length, bytes: Buffer.byteLength(distOut), mb, assets: assets.count, total };
}

if (require.main === module) {
  try { build(); } catch (e) { console.error('[build] 失败：', e.message); process.exit(1); }
}
module.exports = { build };
