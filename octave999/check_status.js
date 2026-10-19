const axios = require('axios');
const xml2js = require('xml2js');
const pLimit = require('p-limit');
const fs = require('fs');

// ====== НАСТРОЙКИ ======
const SITEMAP_URL = process.argv[2] || 'https://example.com/sitemap.xml';
const OUTPUT_FILE = 'sitemap-check-results.csv';
const CONCURRENCY = 20;        // одновременных запросов
const TIMEOUT = 10000;         // таймаут запроса, мс
const RETRIES = 1;             // количество повторных попыток при ошибке
const USER_AGENT = 'Mozilla/5.0 (compatible; SitemapChecker/1.0)';
// ========================

const client = axios.create({
  timeout: TIMEOUT,
  maxRedirects: 5,
  validateStatus: () => true,  // не кидать ошибку на 4xx/5xx
  headers: { 'User-Agent': USER_AGENT },
});

// Проверяем один URL
async function checkUrl(url) {
  const started = Date.now();
  let attempt = 0;
  let lastErr = null;

  while (attempt <= RETRIES) {
    try {
      const res = await client.get(url);
      return {
        url,
        status: res.status,
        time_ms: Date.now() - started,
        error: '',
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
    error: (lastErr && lastErr.code) || (lastErr && lastErr.message) || 'unknown',
  };
}

// Экранирование для CSV
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Загрузка и парсинг sitemap (поддерживает sitemap index)
async function loadSitemap(url, visited = new Set()) {
  if (visited.has(url)) return [];
  visited.add(url);

  const { data } = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': USER_AGENT },
    responseType: 'text',
  });

  const parsed = await xml2js.parseStringPromise(data);
  const urls = [];

  // Обычный sitemap
  if (parsed.urlset && parsed.urlset.url) {
    for (const entry of parsed.urlset.url) {
      if (entry.loc && entry.loc[0]) urls.push(entry.loc[0].trim());
    }
  }

  // Sitemap index (вложенные sitemap)
  if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
    for (const entry of parsed.sitemapindex.sitemap) {
      if (entry.loc && entry.loc[0]) {
        const childUrls = await loadSitemap(entry.loc[0].trim(), visited);
        urls.push(...childUrls);
      }
    }
  }

  return urls;
}

async function main() {
  console.log(`Загружаю sitemap: ${SITEMAP_URL}`);
  const allUrls = await loadSitemap(SITEMAP_URL);
  console.log(`Найдено URL: ${allUrls.length}`);

  if (allUrls.length === 0) {
    console.log('Пусто — проверять нечего.');
    return;
  }

  const limit = pLimit(CONCURRENCY);
  const startedAt = Date.now();
  let done = 0;

  // Открываем поток для записи результатов
  const stream = fs.createWriteStream(OUTPUT_FILE, { flags: 'w' });
  stream.write('url,status,time_ms,error\n');

  const tasks = allUrls.map(url =>
    limit(async () => {
      const result = await checkUrl(url);
      stream.write(
        [result.url, result.status, result.time_ms, result.error]
          .map(csvEscape)
          .join(',') + '\n'
      );
      done++;
      if (done % 100 === 0 || done === allUrls.length) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const rate = (done / (elapsed || 1)).toFixed(1);
        process.stdout.write(
          `\rПроверено ${done}/${allUrls.length} (${elapsed}s, ${rate} url/s)`
        );
      }
      return result;
    })
  );

  const results = await Promise.all(tasks);
  await new Promise(res => stream.end(res));

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  // Статистика
  const byStatus = {};
  for (const r of results) {
    const key = r.error ? `ERR:${r.error}` : String(r.status);
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  console.log('\n\n===== ИТОГ =====');
  console.log(`Всего проверено: ${results.length}`);
  console.log(`Затрачено времени: ${totalSec} сек`);
  console.log('Распределение по статусам:');
  for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`Результаты записаны в: ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Фатальная ошибка:', err);
  process.exit(1);
});