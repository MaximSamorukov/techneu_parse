#!/usr/bin/env node

const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');
const pLimit = require('p-limit');
const fs = require('fs');
const path = require('path');

// ---------- Конфигурация ----------
const args = process.argv.slice(2);
const sitemapUrl = args[0];

if (!sitemapUrl) {
  console.error('Использование: node analyze-sitemap.js <url_sitemap.xml> [concurrency]');
  process.exit(1);
}

const CONCURRENCY = parseInt(args[1], 10) || 20;
const REQUEST_TIMEOUT = 20000;
const USER_AGENT = 'Mozilla/5.0 (compatible; SitemapLinkAnalyzer/1.0)';

// ---------- Утилиты ----------
function getBaseDomain(hostname) {
  // Убираем www. и оставляем корневой домен с поддоменами
  // Например: blog.example.com -> example.com
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  // для .co.uk и подобных — грубо, но для большинства случаев работает
  return parts.slice(-2).join('.');
}

function isInternalLink(linkUrl, baseDomain) {
  try {
    const u = new URL(linkUrl);
    const host = u.hostname;
    const linkDomain = getBaseDomain(host);
    return linkDomain === baseDomain;
  } catch {
    return false;
  }
}

// ---------- Парсинг sitemap ----------
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

async function fetchSitemap(url, visited = new Set()) {
  if (visited.has(url)) return [];
  visited.add(url);

  console.log(`[sitemap] Загружаем: ${url}`);
  const { data } = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: { 'User-Agent': USER_AGENT },
    responseType: 'text',
  });

  const parsed = parser.parse(data);
  const urls = [];

  // Sitemap index
  if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
    const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    for (const sm of sitemaps) {
      const loc = sm.loc;
      if (loc) {
        const nested = await fetchSitemap(loc, visited);
        urls.push(...nested);
      }
    }
  }

  // Обычный sitemap
  if (parsed.urlset && parsed.urlset.url) {
    const entries = Array.isArray(parsed.urlset.url)
      ? parsed.urlset.url
      : [parsed.urlset.url];

    for (const entry of entries) {
      if (entry.loc) urls.push(entry.loc);
    }
  }

  return urls;
}

// ---------- Анализ страницы ----------
async function analyzePage(pageUrl, baseDomain) {
  try {
    const response = await axios.get(pageUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': USER_AGENT },
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const html = response.data;
    const finalUrl = response.request?.res?.responseUrl || pageUrl;
    const $ = cheerio.load(html);

    let total = 0;
    let internal = 0;
    let external = 0;
    let invalid = 0;

    const externalHosts = new Set();
    const internalHosts = new Set();

    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const trimmed = href.trim();
      if (
        !trimmed ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('javascript:') ||
        trimmed.startsWith('mailto:') ||
        trimmed.startsWith('tel:')
      ) {
        return;
      }

      total++;

      let absolute;
      try {
        absolute = new URL(trimmed, finalUrl).href;
      } catch {
        invalid++;
        return;
      }

      if (isInternalLink(absolute, baseDomain)) {
        internal++;
        internalHosts.add(new URL(absolute).hostname);
      } else {
        external++;
        externalHosts.add(new URL(absolute).hostname);
      }
    });

    return {
      url: pageUrl,
      finalUrl,
      status: response.status,
      total,
      internal,
      external,
      invalid,
      externalHosts: [...externalHosts],
      internalHosts: [...internalHosts],
      error: null,
    };
  } catch (err) {
    return {
      url: pageUrl,
      total: 0,
      internal: 0,
      external: 0,
      invalid: 0,
      externalHosts: [],
      internalHosts: [],
      error: err.message,
    };
  }
}

// ---------- Основная логика ----------
async function main() {
  console.log(`Анализ sitemap: ${sitemapUrl}`);
  console.log(`Конкурентность: ${CONCURRENCY}\n`);

  const startTime = Date.now();

  // 1. Получаем все URL из sitemap
  const sitemapUrls = await fetchSitemap(sitemapUrl);
  const uniqueUrls = [...new Set(sitemapUrls)];

  console.log(`\nНайдено URL в sitemap: ${uniqueUrls.length}\n`);

  if (uniqueUrls.length === 0) {
    console.error('Не удалось получить URLs из sitemap');
    process.exit(1);
  }

  const baseDomain = getBaseDomain(new URL(uniqueUrls[0]).hostname);
  console.log(`Базовый домен: ${baseDomain}\n`);

  // 2. Обходим все страницы с ограничением конкурентности
  const limit = pLimit(CONCURRENCY);
  let processed = 0;

  const tasks = uniqueUrls.map((url) =>
    limit(async () => {
      const result = await analyzePage(url, baseDomain);
      processed++;
      if (processed % 100 === 0) {
        console.log(`Обработано: ${processed}/${uniqueUrls.length}`);
      }
      return result;
    })
  );

  const results = await Promise.all(tasks);

  // 3. Агрегация
  let totalLinks = 0;
  let totalInternal = 0;
  let totalExternal = 0;
  let totalInvalid = 0;
  let errorsCount = 0;

  const globalExternalHosts = new Map();
  const globalInternalHosts = new Map();
  const problemPages = [];

  for (const r of results) {
    if (r.error) {
      errorsCount++;
      problemPages.push(r);
      continue;
    }
    totalLinks += r.total;
    totalInternal += r.internal;
    totalExternal += r.external;
    totalInvalid += r.invalid;

    for (const h of r.externalHosts) {
      globalExternalHosts.set(h, (globalExternalHosts.get(h) || 0) + 1);
    }
    for (const h of r.internalHosts) {
      globalInternalHosts.set(h, (globalInternalHosts.get(h) || 0) + 1);
    }

    if (r.total === 0) problemPages.push(r);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // 4. Вывод
  console.log('\n========================================');
  console.log('           ОБЩАЯ СТАТИСТИКА');
  console.log('========================================');
  console.log(`Всего страниц:            ${results.length}`);
  console.log(`Успешно обработано:       ${results.length - errorsCount}`);
  console.log(`Ошибок при загрузке:      ${errorsCount}`);
  console.log(`Время выполнения:         ${duration} сек`);
  console.log('');
  console.log(`Всего тегов <a>:          ${totalLinks}`);
  console.log(`  Внутренних:             ${totalInternal} (${((totalInternal / totalLinks) * 100 || 0).toFixed(1)}%)`);
  console.log(`  Внешних:                ${totalExternal} (${((totalExternal / totalLinks) * 100 || 0).toFixed(1)}%)`);
  console.log(`  Некорректных URL:       ${totalInvalid}`);
  console.log('');

  console.log('Внутренние хосты (топ-20):');
  [...globalInternalHosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([host, count]) => {
      console.log(`  ${host.padEnd(50)} ${count} страниц`);
    });

  console.log('\nВнешние хосты (топ-20):');
  [...globalExternalHosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([host, count]) => {
      console.log(`  ${host.padEnd(50)} ${count} страниц`);
    });

  if (problemPages.length) {
    console.log(`\nПроблемные страницы (${problemPages.length}):`);
    problemPages.slice(0, 30).forEach((p) => {
      if (p.error) {
        console.log(`  [ERROR] ${p.url} — ${p.error}`);
      } else {
        console.log(`  [NO LINKS] ${p.url}`);
      }
    });
  }

  // 5. Сохранение отчёта
  const reportPath = path.join(
    process.cwd(),
    `sitemap-report-${Date.now()}.json`
  );

  const report = {
    sitemapUrl,
    baseDomain,
    generatedAt: new Date().toISOString(),
    durationSec: parseFloat(duration),
    summary: {
      totalPages: results.length,
      errors: errorsCount,
      totalLinks,
      totalInternal,
      totalExternal,
      totalInvalid,
    },
    internalHosts: Object.fromEntries(globalInternalHosts),
    externalHosts: Object.fromEntries(globalExternalHosts),
    pages: results,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nПодробный отчёт сохранён: ${reportPath}`);
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});