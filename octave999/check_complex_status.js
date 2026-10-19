const axios = require('axios');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const pLimit = require('p-limit');
const fs = require('fs');

// ====== НАСТРОЙКИ ======
let SITEMAP_URL = process.argv[2] || 'https://example.com/sitemap.xml';
const OUTPUT_CSV = 'seo-audit.csv';
const OUTPUT_JSONL = 'seo-audit.jsonl';
const CONCURRENCY = 10;
const TIMEOUT = 15000;
const RETRIES = 1;
const USER_AGENT = 'Mozilla/5.0 (compatible; SeoAuditBot/1.0; +https://example.com/bot)';

// Если передан только домен — подставляем /sitemap.xml
try {
  const u = new URL(SITEMAP_URL);
  if (u.pathname === '/' || u.pathname === '') {
    u.pathname = '/sitemap.xml';
    SITEMAP_URL = u.toString();
    console.log(`Путь не указан, использую: ${SITEMAP_URL}`);
  }
} catch {}
// ========================

const client = axios.create({
  timeout: TIMEOUT,
  maxRedirects: 5,
  validateStatus: () => true,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'ru,en;q=0.9',
  },
});

// ---------- Загрузка sitemap (с поддержкой sitemapindex) ----------
async function findSitemapInRobots(origin) {
  try {
    const res = await client.get(`${origin}/robots.txt`, { responseType: 'text' });
    if (res.status !== 200) return null;
    const m = String(res.data).match(/^\s*Sitemap:\s*(\S+)/im);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

async function loadSitemap(url, visited = new Set()) {
  if (visited.has(url)) return [];
  visited.add(url);

  const res = await client.get(url, { responseType: 'text' });
  const body = String(res.data || '').trimStart();
  const ct = String(res.headers['content-type'] || '');

  const looksLikeXml = body.startsWith('<?xml') || body.startsWith('<urlset') || body.startsWith('<sitemapindex');
  if (!looksLikeXml) {
    if (/text\/html/i.test(ct) || body.startsWith('<!') || body.startsWith('<html')) {
      console.warn(`⚠️  ${url} вернул HTML, ищу sitemap в robots.txt...`);
      const found = await findSitemapInRobots(new URL(url).origin);
      if (found && found !== url) {
        console.warn(`   Нашёл: ${found}`);
        return loadSitemap(found, visited);
      }
    }
    throw new Error(`URL ${url} не является XML (content-type=${ct})`);
  }

  const parsed = await xml2js.parseStringPromise(body);
  const urls = [];

  if (parsed.urlset?.url) {
    for (const entry of parsed.urlset.url) {
      if (entry.loc?.[0]) urls.push(entry.loc[0].trim());
    }
  }

  if (parsed.sitemapindex?.sitemap) {
    for (const entry of parsed.sitemapindex.sitemap) {
      if (entry.loc?.[0]) {
        const child = await loadSitemap(entry.loc[0].trim(), visited);
        urls.push(...child);
      }
    }
  }

  return urls;
}

// ---------- Парсинг одной страницы ----------
function parseHtml(html, pageUrl) {
  const $ = cheerio.load(html);

  const title = ($('head title').first().text() || '').trim();
  const description = ($('meta[name="description"]').attr('content') || '').trim();
  const canonical = ($('link[rel="canonical"]').attr('href') || '').trim();

  // robots meta: собираем все значения
  const robotsMetas = [];
  $('meta[name="robots"], meta[name="yandex"], meta[name="googlebot"]').each((_, el) => {
    const content = ($(el).attr('content') || '').toLowerCase();
    if (content) robotsMetas.push(content);
  });
  const robotsJoined = robotsMetas.join(', ');

  const noindex = /noindex/.test(robotsJoined);
  const nofollow = /nofollow/.test(robotsJoined);

  // X-Robots-Tag из HTTP-заголовков мы обрабатываем отдельно в fetchPage

  // H1 (для справки)
  const h1Count = $('h1').length;
  const h1Text = ($('h1').first().text() || '').trim().replace(/\s+/g, ' ').slice(0, 200);

  // lang
  const lang = ($('html').attr('lang') || '').trim();

  return {
    title,
    title_length: title.length,
    description,
    description_length: description.length,
    canonical,
    noindex,
    nofollow,
    robots_meta: robotsJoined,
    h1_count: h1Count,
    h1: h1Text,
    lang,
    final_url: pageUrl,
  };
}

async function fetchPage(url) {
  const started = Date.now();
  let attempt = 0;
  let lastErr = null;

  while (attempt <= RETRIES) {
    try {
      const res = await client.get(url, {
        // для HTML нужен responseType text/stream
        responseType: 'text',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru,en;q=0.9',
        },
      });

      const html = typeof res.data === 'string' ? res.data : String(res.data);

      // X-Robots-Tag из заголовков
      const xRobots = String(res.headers['x-robots-tag'] || '').toLowerCase();
      const xNoindex = /noindex/.test(xRobots);
      const xNofollow = /nofollow/.test(xRobots);

      const parsed = /html/i.test(String(res.headers['content-type'] || ''))
        ? parseHtml(html, url)
        : { title: '', title_length: 0, description: '', description_length: 0,
            canonical: '', noindex: false, nofollow: false, robots_meta: '',
            h1_count: 0, h1: '', lang: '' };

      return {
        url,
        status: res.status,
        time_ms: Date.now() - started,
        error: '',
        redirect_to: (res.request?.res?.responseUrl && res.request.res.responseUrl !== url)
          ? res.request.res.responseUrl
          : '',
        x_robots_tag: xRobots,
        noindex: parsed.noindex || xNoindex,
        nofollow: parsed.nofollow || xNofollow,
        ...parsed,
      };
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt <= RETRIES) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  }

  return {
    url,
    status: 0,
    time_ms: Date.now() - started,
    error: lastErr?.code || lastErr?.message || 'unknown',
    redirect_to: '',
    x_robots_tag: '',
    noindex: false,
    nofollow: false,
    title: '', title_length: 0,
    description: '', description_length: 0,
    canonical: '',
    robots_meta: '',
    h1_count: 0, h1: '', lang: '',
  };
}

// ---------- Утилиты ----------
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  'url', 'status', 'time_ms', 'error', 'redirect_to',
  'title', 'title_length',
  'description', 'description_length',
  'canonical',
  'noindex', 'nofollow',
  'robots_meta', 'x_robots_tag',
  'h1_count', 'h1', 'lang',
];

// ---------- Main ----------
async function main() {
  console.log(`Загружаю sitemap: ${SITEMAP_URL}`);
  const allUrls = await loadSitemap(SITEMAP_URL);
  const uniqueUrls = [...new Set(allUrls)];
  console.log(`Найдено URL: ${allUrls.length}, уникальных: ${uniqueUrls.length}`);

  if (uniqueUrls.length === 0) return;

  const limit = pLimit(CONCURRENCY);
  const startedAt = Date.now();
  let done = 0;

  const csvStream = fs.createWriteStream(OUTPUT_CSV, { flags: 'w' });
  const jsonlStream = fs.createWriteStream(OUTPUT_JSONL, { flags: 'w' });
  csvStream.write(CSV_COLUMNS.join(',') + '\n');

  const tasks = uniqueUrls.map(url =>
    limit(async () => {
      const result = await fetchPage(url);

      csvStream.write(
        CSV_COLUMNS.map(c => csvEscape(result[c])).join(',') + '\n'
      );
      jsonlStream.write(JSON.stringify(result) + '\n');

      done++;
      if (done % 50 === 0 || done === uniqueUrls.length) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = (done / (elapsed || 1)).toFixed(1);
        process.stdout.write(
          `\rПроверено ${done}/${uniqueUrls.length} (${elapsed.toFixed(0)}s, ${rate} url/s)   `
        );
      }
      return result;
    })
  );

  const results = await Promise.all(tasks);
  await new Promise(r => csvStream.end(r));
  await new Promise(r => jsonlStream.end(r));

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  // ---------- Сводка ----------
  const stats = {
    total: results.length,
    ok: 0,
    redirects: 0,
    client_errors: 0,
    server_errors: 0,
    network_errors: 0,
    noindex: 0,
    nofollow: 0,
    no_title: 0,
    no_description: 0,
    no_canonical: 0,
    title_too_long: 0,   // > 60
    title_too_short: 0,  // < 30
    desc_too_long: 0,    // > 160
    desc_too_short: 0,   // < 70
    canonical_mismatch: 0,
  };

  for (const r of results) {
    if (r.error) stats.network_errors++;
    else if (r.status >= 200 && r.status < 300) stats.ok++;
    else if (r.status >= 300 && r.status < 400) stats.redirects++;
    else if (r.status >= 400 && r.status < 500) stats.client_errors++;
    else if (r.status >= 500) stats.server_errors++;

    if (r.noindex) stats.noindex++;
    if (r.nofollow) stats.nofollow++;
    if (!r.title) stats.no_title++;
    if (!r.description) stats.no_description++;
    if (!r.canonical) stats.no_canonical++;
    if (r.title_length > 60) stats.title_too_long++;
    if (r.title && r.title_length < 30) stats.title_too_short++;
    if (r.description_length > 160) stats.desc_too_long++;
    if (r.description && r.description_length < 70) stats.desc_too_short++;

    // canonical не совпадает с URL (без учёта слэша в конце)
    if (r.canonical && !r.error) {
      const norm = s => s.replace(/\/+$/, '').toLowerCase();
      try {
        const c = new URL(r.canonical, r.final_url || r.url);
        if (norm(c.toString()) !== norm(r.url)) stats.canonical_mismatch++;
      } catch {}
    }
  }

  console.log('\n\n===== ИТОГ =====');
  console.log(`Всего: ${stats.total}`);
  console.log(`Время: ${totalSec} сек`);
  console.log(`OK (2xx): ${stats.ok}`);
  console.log(`Редиректы (3xx): ${stats.redirects}`);
  console.log(`Клиентские ошибки (4xx): ${stats.client_errors}`);
  console.log(`Серверные ошибки (5xx): ${stats.server_errors}`);
  console.log(`Сетевые ошибки: ${stats.network_errors}`);
  console.log('---');
  console.log(`noindex: ${stats.noindex}`);
  console.log(`nofollow: ${stats.nofollow}`);
  console.log(`Без title: ${stats.no_title}`);
  console.log(`Без description: ${stats.no_description}`);
  console.log(`Без canonical: ${stats.no_canonical}`);
  console.log(`Title > 60: ${stats.title_too_long}`);
  console.log(`Title < 30: ${stats.title_too_short}`);
  console.log(`Description > 160: ${stats.desc_too_long}`);
  console.log(`Description < 70: ${stats.desc_too_short}`);
  console.log(`Canonical не совпадает с URL: ${stats.canonical_mismatch}`);
  console.log('---');
  console.log(`CSV: ${OUTPUT_CSV}`);
  console.log(`JSONL: ${OUTPUT_JSONL}`);
}

main().catch(err => {
  console.error('Фатальная ошибка:', err);
  process.exit(1);
});