#!/usr/bin/env node
/**
 * Проверка дублей в sitemap.xml
 *
 * Использование:
 *   node sitemap-dupes.js https://example.com
 *   node sitemap-dupes.js https://example.com --json
 *   node sitemap-dupes.js https://example.com --no-recursive
 *   node sitemap-dupes.js https://example.com --ignore-query
 *   node sitemap-dupes.js https://example.com --ignore-trailing-slash
 *   node sitemap-dupes.js https://example.com --ignore-www
 *   node sitemap-dupes.js https://example.com --ignore-case
 *   node sitemap-dupes.js https://example.com --ignore-protocol
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ---------- Аргументы ----------
function parseArgs(argv) {
  const args = {
    baseUrl: null,
    json: false,
    timeout: 20000,
    recursive: true,
    ignoreQuery: false,
    ignoreTrailingSlash: false,
    ignoreWww: false,
    ignoreCase: false,
    ignoreProtocol: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') args.json = true;
    else if (a === '--no-recursive') args.recursive = false;
    else if (a === '--ignore-query') args.ignoreQuery = true;
    else if (a === '--ignore-trailing-slash') args.ignoreTrailingSlash = true;
    else if (a === '--ignore-www') args.ignoreWww = true;
    else if (a === '--ignore-case') args.ignoreCase = true;
    else if (a === '--ignore-protocol') args.ignoreProtocol = true;
    else if (a === '--timeout') args.timeout = parseInt(rest[++i], 10);
    else if (!args.baseUrl) args.baseUrl = a;
  }
  return args;
}

// ---------- HTTP ----------
function fetchUrl(url, { timeout, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, redirectsLeft) => {
      let parsed;
      try { parsed = new URL(currentUrl); } catch (e) { return reject(e); }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(
        currentUrl,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SitemapDupesChecker/1.0)',
            'Accept': 'application/xml,text/xml,*/*',
          },
          timeout,
        },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
            const next = new URL(res.headers.location, currentUrl).toString();
            return doRequest(next, redirectsLeft - 1);
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }
      );
      req.on('timeout', () => req.destroy(new Error(`Таймаут: ${currentUrl}`)));
      req.on('error', reject);
    };
    doRequest(url, maxRedirects);
  });
}

// ---------- Парсинг XML ----------
function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(decodeXmlEntities(m[1].trim()));
  }
  return out;
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

// ---------- Сбор URL ----------
async function collectAll(url, opts, visited, allUrls, sourceMap) {
  if (visited.has(url)) return;
  visited.add(url);

  let xml;
  try {
    xml = await fetchUrl(url, { timeout: opts.timeout });
  } catch (e) {
    console.error(`⚠️  Не удалось загрузить ${url}: ${e.message}`);
    return;
  }

  const locs = extractLocs(xml);

  if (isSitemapIndex(xml) && opts.recursive) {
    for (const loc of locs) {
      let abs;
      try { abs = new URL(loc, url).toString(); } catch { continue; }
      await collectAll(abs, opts, visited, allUrls, sourceMap);
    }
  } else {
    for (const loc of locs) {
      let abs;
      try { abs = new URL(loc, url).toString(); } catch { continue; }
      allUrls.push(abs);
      if (!sourceMap.has(abs)) sourceMap.set(abs, []);
      sourceMap.get(abs).push(url);
    }
  }
}

// ---------- Нормализация ----------
function normalizeUrl(rawUrl, opts) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }

  let protocol = u.protocol;
  if (opts.ignoreProtocol) protocol = 'http:'; // приводим к одному

  let host = u.hostname;
  if (opts.ignoreWww) host = host.replace(/^www\./i, '');
  if (opts.ignoreCase) host = host.toLowerCase();

  let pathname = u.pathname;
  if (opts.ignoreTrailingSlash) {
    pathname = pathname.replace(/\/+$/, '') || '/';
  }
  if (opts.ignoreCase) pathname = pathname.toLowerCase();

  let search = u.search;
  if (opts.ignoreQuery) {
    search = '';
  } else if (search) {
    // сортируем query-параметры
    const params = new URLSearchParams(search);
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const sp = new URLSearchParams();
    for (const [k, v] of sorted) sp.append(k, v);
    const qs = sp.toString();
    search = qs ? '?' + qs : '';
  }

  const port = u.port ? ':' + u.port : '';
  return `${protocol}//${host}${port}${pathname}${search}`;
}

// ---------- Утилиты вывода ----------
function color(text, code) {
  if (!process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = (s) => color(s, 32);
const red = (s) => color(s, 31);
const yellow = (s) => color(s, 33);
const gray = (s) => color(s, 90);
const bold = (s) => color(s, 1);

// ---------- Main ----------
async function main() {
  const args = parseArgs(process.argv);
  if (!args.baseUrl) {
    console.error('Использование: node sitemap-dupes.js <url> [опции]');
    console.error('Опции:');
    console.error('  --json                     вывод в JSON');
    console.error('  --no-recursive             не раскрывать sitemapindex');
    console.error('  --ignore-query             игнорировать query-параметры');
    console.error('  --ignore-trailing-slash    игнорировать / в конце');
    console.error('  --ignore-www               игнорировать www.');
    console.error('  --ignore-case              игнорировать регистр');
    console.error('  --ignore-protocol          игнорировать http/https');
    console.error('  --timeout <ms>             таймаут запроса');
    process.exit(1);
  }

  let baseUrl = args.baseUrl;
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'https://' + baseUrl;
  const base = new URL(baseUrl);
  const origin = `${base.protocol}//${base.host}`;

  console.error(gray(`→ База: ${origin}`));

  // 1. Определяем входные sitemap-и
  const entryPoints = [];
  const sitemapFromRobots = await tryRobotsSitemaps(origin, args);
  for (const s of sitemapFromRobots) entryPoints.push(s);
  // стандартный
  entryPoints.push(new URL('/sitemap.xml', origin).toString());
  // если baseUrl — это уже sitemap
  if (/\.xml(\.gz)?$/i.test(base.pathname)) entryPoints.unshift(base.toString());

  // 2. Собираем все URL
  const visited = new Set();
  const allUrls = [];
  const sourceMap = new Map(); // url -> [sitemap-источники]
  for (const ep of [...new Set(entryPoints)]) {
    await collectAll(ep, args, visited, allUrls, sourceMap);
  }

  console.error(gray(`→ Загружено sitemap-ов: ${visited.size}`));
  console.error(gray(`→ Всего <loc>: ${allUrls.length}`));

  if (!allUrls.length) {
    console.error(yellow('⚠️  Не найдено ни одного URL.'));
    process.exit(0);
  }

  // 3. Точные дубли (побайтовое совпадение)
  const exactMap = new Map();
  for (const u of allUrls) {
    if (!exactMap.has(u)) exactMap.set(u, 0);
    exactMap.set(u, exactMap.get(u) + 1);
  }
  const exactDupes = [...exactMap.entries()].filter(([, c]) => c > 1);

  // 4. Нормализованные дубли
  const normMap = new Map(); // normUrl -> Map(originalUrl -> count)
  for (const u of allUrls) {
    const n = normalizeUrl(u, args);
    if (!normMap.has(n)) normMap.set(n, new Map());
    const inner = normMap.get(n);
    inner.set(u, (inner.get(u) || 0) + 1);
  }
  const normDupes = [...normMap.entries()].filter(([, m]) => m.size > 1);

  // 5. Вывод
  if (args.json) {
    const report = {
      base: origin,
      options: {
        ignoreQuery: args.ignoreQuery,
        ignoreTrailingSlash: args.ignoreTrailingSlash,
        ignoreWww: args.ignoreWww,
        ignoreCase: args.ignoreCase,
        ignoreProtocol: args.ignoreProtocol,
      },
      totalUrls: allUrls.length,
      uniqueExact: exactMap.size,
      exactDuplicates: exactDupes.map(([url, count]) => ({
        url,
        count,
        sources: sourceMap.get(url) || [],
      })),
      normalizedDuplicateGroups: normDupes.map(([norm, m]) => ({
        normalized: norm,
        variants: [...m.entries()].map(([url, count]) => ({
          url,
          count,
          sources: sourceMap.get(url) || [],
        })),
      })),
      stats: {
        exactDuplicatesCount: exactDupes.reduce((s, [, c]) => s + (c - 1), 0),
        normalizedDuplicateGroups: normDupes.length,
        normalizedExtraUrls: normDupes.reduce(
          (s, [, m]) => s + [...m.values()].reduce((a, b) => a + b, 0) - 1,
          0
        ),
      },
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(exactDupes.length || normDupes.length ? 2 : 0);
  }

  console.log('\n' + bold('=== Отчёт о дублях в sitemap.xml ===\n'));

  // Точные дубли
  console.log(bold(`1. Точные дубли (побайтовое совпадение): ${exactDupes.length ? red(exactDupes.length) : green('0')}`));
  if (exactDupes.length) {
    for (const [url, count] of exactDupes) {
      console.log(`  ${red('×' + count)}  ${url}`);
      const srcs = sourceMap.get(url) || [];
      if (srcs.length) {
        for (const s of [...new Set(srcs)]) console.log(gray(`        ← ${s}`));
      }
    }
  } else {
    console.log(gray('  Дублей не найдено.'));
  }
  console.log();

  // Нормализованные дубли
  console.log(bold(`2. Группы нормализованных дублей: ${normDupes.length ? red(normDupes.length) : green('0')}`));
  console.log(gray(`   (нормализация: ${describeNormalization(args)})`));
  if (normDupes.length) {
    let i = 0;
    for (const [norm, m] of normDupes) {
      i++;
      console.log(`\n  ${bold('#' + i)} ${yellow(norm)}`);
      for (const [url, count] of m) {
        const marker = count > 1 ? red(` ×${count}`) : '';
        console.log(`      ${url}${marker}`);
        const srcs = sourceMap.get(url) || [];
        for (const s of [...new Set(srcs)]) console.log(gray(`          ← ${s}`));
      }
    }
  } else {
    console.log(gray('  Дублей не найдено.'));
  }

  // Итоги
  console.log('\n' + bold('=== Итого ==='));
  console.log(`  Всего <loc>:                  ${allUrls.length}`);
  console.log(`  Уникальных (точно):           ${exactMap.size}`);
  console.log(`  Лишних из-за точных дублей:   ${exactDupes.reduce((s, [, c]) => s + (c - 1), 0)}`);
  console.log(`  Уникальных (нормализованных): ${normMap.size}`);
  console.log(
    `  Лишних из-за нормализации:    ${normDupes.reduce(
      (s, [, m]) => s + [...m.values()].reduce((a, b) => a + b, 0) - 1,
      0
    )}`
  );

  const hasIssues = exactDupes.length > 0 || normDupes.length > 0;
  process.exit(hasIssues ? 2 : 0);
}

function describeNormalization(args) {
  const parts = [];
  if (args.ignoreProtocol) parts.push('protocol');
  if (args.ignoreWww) parts.push('www');
  if (args.ignoreCase) parts.push('case');
  if (args.ignoreTrailingSlash) parts.push('trailing-slash');
  if (args.ignoreQuery) parts.push('query');
  return parts.length ? parts.join(', ') : 'нет (только точные)';
}

async function tryRobotsSitemaps(origin, opts) {
  try {
    const txt = await fetchUrl(new URL('/robots.txt', origin).toString(), { timeout: opts.timeout });
    const out = [];
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (m) {
        try { out.push(new URL(m[1], origin).toString()); } catch { /* ignore */ }
      }
    }
    return out;
  } catch {
    return [];
  }
}

main().catch((e) => {
  console.error(red(`Ошибка: ${e.message}`));
  process.exit(1);
});