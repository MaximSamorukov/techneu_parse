#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');
const pLimit = require('p-limit');

// ---------- Аргументы ----------
const [, , sitemapUrl, urlsFilePath, outputPath = 'result.csv'] = process.argv;

if (!sitemapUrl || !urlsFilePath) {
  console.error('Использование: node find-links.js <sitemap.xml URL> <путь к файлу с URLs> [output.csv]');
  process.exit(1);
}

// ---------- Утилиты ----------
const CONCURRENCY = 10;       // одновременно открытых страниц
const TIMEOUT = 20000;       // таймаут запроса, мс
const USER_AGENT = 'Mozilla/5.0 (compatible; LinkChecker/1.0)';

const http = axios.create({
  timeout: TIMEOUT,
  headers: { 'User-Agent': USER_AGENT },
  // Не выбрасывать исключение для 4xx/5xx — обработаем сами
  validateStatus: () => true,
  maxRedirects: 5,
});

/**
 * Нормализует URL: убирает hash и trailing slash
 */
function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    u.hash = '';
    // Убираем trailing slash кроме корня
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Читает файл с URL (по одному в строке), убирает пустые строки и комментарии
 */
function readUrlsFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Рекурсивно собирает все <loc> из sitemap.xml (включая вложенные sitemap-индексы)
 */
async function collectSitemapUrls(sitemapUrl, visited = new Set()) {
  if (visited.has(sitemapUrl)) return [];
  visited.add(sitemapUrl);

  console.log(`[sitemap] Загружаю: ${sitemapUrl}`);
  const res = await http.get(sitemapUrl);
  if (res.status !== 200) {
    console.warn(`[sitemap] Не удалось загрузить ${sitemapUrl} (status ${res.status})`);
    return [];
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    isArray: (name) => name === 'url' || name === 'sitemap',
  });

  let parsed;
  try {
    parsed = parser.parse(res.data);
  } catch (e) {
    console.warn(`[sitemap] Ошибка парсинга ${sitemapUrl}: ${e.message}`);
    return [];
  }

  const result = [];

  // Обычный sitemap: urlset > url > loc
  const urlset = parsed.urlset?.url || [];
  for (const item of urlset) {
    if (item.loc) result.push(String(item.loc).trim());
  }

  // Sitemap index: sitemapindex > sitemap > loc
  const sitemapIndex = parsed.sitemapindex?.sitemap || [];
  for (const item of sitemapIndex) {
    if (item.loc) {
      const nested = await collectSitemapUrls(String(item.loc).trim(), visited);
      result.push(...nested);
    }
  }

  return result;
}

/**
 * Загружает страницу и возвращает Set нормализованных href'ов
 */
async function extractLinksFromPage(pageUrl) {
  try {
    const res = await http.get(pageUrl);
    if (res.status < 200 || res.status >= 400) {
      return { ok: false, status: res.status, links: new Set() };
    }

    const contentType = String(res.headers['content-type'] || '');
    if (!contentType.includes('text/html') && !contentType.includes('xml')) {
      return { ok: false, status: res.status, links: new Set() };
    }

    const $ = cheerio.load(res.data);
    const links = new Set();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const normalized = normalizeUrl(href, pageUrl);
      if (normalized) links.add(normalized);
    });

    return { ok: true, status: res.status, links };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, links: new Set() };
  }
}

/**
 * Экранирование для CSV
 */
function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ---------- Основной поток ----------
async function main() {
  console.log('Читаю список целевых URL...');
  const targetUrlsRaw = readUrlsFile(urlsFilePath);
  const targetUrls = new Set(
    targetUrlsRaw.map((u) => normalizeUrl(u)).filter(Boolean)
  );
  console.log(`Найдено ${targetUrls.size} целевых URL.`);

  console.log('Собираю URL из sitemap...');
  const sitemapUrls = await collectSitemapUrls(sitemapUrl);
  console.log(`Получено ${sitemapUrls.length} страниц из sitemap.`);

  const limit = pLimit(CONCURRENCY);
  const rows = [['source_page', 'status', 'target_url']];
  let processed = 0;
  let foundTotal = 0;

  const tasks = sitemapUrls.map((pageUrl) =>
    limit(async () => {
      const normalizedPage = normalizeUrl(pageUrl);
      const { ok, status, links, error } = await extractLinksFromPage(pageUrl);

      processed++;
      if (processed % 25 === 0 || processed === sitemapUrls.length) {
        console.log(`Обработано ${processed}/${sitemapUrls.length}`);
      }

      if (!ok) {
        // В отчёте фиксируем неуспешные страницы (можно убрать этот блок)
        rows.push([pageUrl, status || `ERR:${error || 'unknown'}`, '']);
        return;
      }

      // Ищем пересечения
      let matches = 0;
      for (const link of links) {
        if (targetUrls.has(link)) {
          rows.push([pageUrl, status, link]);
          matches++;
        }
      }
      foundTotal += matches;
    })
  );

  await Promise.all(tasks);

  // Запись CSV
  const out = path.resolve(outputPath);
  const csvContent = rows
    .map((row) => row.map(csvEscape).join(','))
    .join('\n');

  fs.writeFileSync(out, '\uFEFF' + csvContent, 'utf8'); // BOM для Excel

  console.log('---');
  console.log(`Готово. Всего строк в отчёте: ${rows.length - 1}`);
  console.log(`Найдено совпадений: ${foundTotal}`);
  console.log(`Результат сохранён: ${out}`);
}

main().catch((e) => {
  console.error('Фатальная ошибка:', e);
  process.exit(1);
});