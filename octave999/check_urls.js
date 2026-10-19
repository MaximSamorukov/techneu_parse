#!/usr/bin/env node
/**
 * Проверка URL из sitemap.xml на соответствие правилам robots.txt
 *
 * Использование:
 *   node check-robots.js https://example.com
 *   node check-robots.js https://example.com --user-agent "Googlebot"
 *   node check-robots.js https://example.com --json
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ---------- Аргументы ----------
function parseArgs(argv) {
  const args = { baseUrl: null, userAgent: '*', json: false, timeout: 15000 };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--user-agent' || a === '-u') args.userAgent = rest[++i];
    else if (a === '--json') args.json = true;
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
            'User-Agent': 'Mozilla/5.0 (compatible; RobotsSitemapChecker/1.0)',
            'Accept': '*/*',
          },
          timeout,
        },
        (res) => {
          // Редиректы
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
            const next = new URL(res.headers.location, currentUrl).toString();
            return doRequest(next, redirectsLeft - 1);
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} для ${currentUrl}`));
          }

          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, body, url: currentUrl, headers: res.headers });
          });
        }
      );
      req.on('timeout', () => { req.destroy(new Error(`Таймаут для ${currentUrl}`)); });
      req.on('error', reject);
    };
    doRequest(url, maxRedirects);
  });
}

// ---------- Парсер robots.txt ----------
class RobotsTxt {
  constructor(content) {
    this.groups = [];        // [{ agents: [...], rules: [{type:'allow'|'disallow', path}], crawlDelay }]
    this.sitemaps = [];
    this.parse(content);
  }

  parse(content) {
    const lines = content.split(/\r?\n/);
    let current = null;
    let lastWasUserAgent = false;

    for (let raw of lines) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;

      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const field = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();

      if (field === 'user-agent') {
        if (!current || !lastWasUserAgent) {
          current = { agents: [], rules: [], crawlDelay: null };
          this.groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasUserAgent = true;
      } else if (field === 'sitemap') {
        this.sitemaps.push(value);
        lastWasUserAgent = false;
      } else if (field === 'allow' || field === 'disallow') {
        if (!current) {
          // Правила без группы User-Agent — игнорируем
          lastWasUserAgent = false;
          continue;
        }
        current.rules.push({ type: field, path: value });
        lastWasUserAgent = false;
      } else if (field === 'crawl-delay') {
        if (current) current.crawlDelay = parseFloat(value);
        lastWasUserAgent = false;
      } else {
        lastWasUserAgent = false;
      }
    }
  }

  /** Найти правила для конкретного User-Agent (по убыванию специфичности) */
  getRulesFor(userAgent) {
    const ua = (userAgent || '*').toLowerCase();
    // Собираем все совпадающие группы
    let best = null;
    let bestLen = -1;

    for (const g of this.groups) {
      for (const a of g.agents) {
        if (a === '*') {
          if (bestLen < 0) { best = best || { rules: [], crawlDelay: null }; }
          // запоминаем как fallback
          if (bestLen < 0) { best = best || { rules: [] }; }
          if (!best) best = { rules: [], crawlDelay: null };
          if (bestLen < 0) {
            best = { rules: [], crawlDelay: null };
            bestLen = -2; // маркер fallback
          }
        } else if (ua.includes(a) || a.includes(ua)) {
          // Чем длиннее совпадение — тем специфичнее
          if (a.length > bestLen || bestLen < 0) {
            best = { rules: g.rules, crawlDelay: g.crawlDelay };
            bestLen = a.length;
          }
        }
      }
    }
    // Если нашли только fallback '*' — соберём его правила
    if (bestLen < 0) {
      const rules = [];
      let cd = null;
      for (const g of this.groups) {
        if (g.agents.includes('*')) {
          rules.push(...g.rules);
          if (cd === null) cd = g.crawlDelay;
        }
      }
      return { rules, crawlDelay: cd };
    }
    return best;
  }

  /** Проверить путь. Возвращает {allowed, matchedRule} */
  isAllowed(path, userAgent) {
    const { rules } = this.getRulesFor(userAgent);
    if (!rules.length) return { allowed: true, matchedRule: null };

    let bestMatch = null;
    let bestLen = -1;

    for (const r of rules) {
      if (r.path === '') continue;
      const pattern = r.path;
      if (matchRobotsPattern(pattern, path)) {
        // Более длинное правило имеет приоритет; при равенстве — allow
        const len = pattern.length;
        if (
          len > bestLen ||
          (len === bestLen && r.type === 'allow' && bestMatch && bestMatch.type === 'disallow')
        ) {
          bestMatch = r;
          bestLen = len;
        }
      }
    }

    if (!bestMatch) return { allowed: true, matchedRule: null };
    return { allowed: bestMatch.type === 'allow', matchedRule: bestMatch };
  }
}

/** Сопоставление пути с шаблоном robots.txt (поддержка * и $) */
function matchRobotsPattern(pattern, path) {
  // Если нет спецсимволов — простое префиксное совпадение
  if (!pattern.includes('*') && !pattern.endsWith('$')) {
    return path.startsWith(pattern);
  }

  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') regex += '.*';
    else if (ch === '$' && i === pattern.length - 1) regex += '$';
    else regex += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(regex).test(path);
}

// ---------- Парсер sitemap.xml ----------
function parseSitemap(xml) {
  const urls = [];
  // <loc>...</loc> — работает и для sitemapindex
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    urls.push(decodeXmlEntities(m[1]));
  }
  return urls;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ---------- Получение sitemap'ов ----------
async function collectSitemapUrls(baseUrl, robots, opts) {
  const found = new Set();

  // 1. Из robots.txt
  for (const s of robots.sitemaps) {
    try {
      const u = new URL(s, baseUrl).toString();
      found.add(u);
    } catch { /* ignore */ }
  }

  // 2. Стандартный /sitemap.xml
  try {
    const std = new URL('/sitemap.xml', baseUrl).toString();
    found.add(std);
  } catch { /* ignore */ }

  // 3. Проверяем доступность — оставляем только рабочие
  const working = [];
  for (const url of found) {
    try {
      await fetchUrl(url, { timeout: opts.timeout });
      working.push(url);
    } catch { /* недоступен */ }
  }

  // 4. Рекурсивно разворачиваем sitemapindex
  const allUrls = new Set();
  const visited = new Set();

  async function processSitemap(url) {
    if (visited.has(url)) return;
    visited.add(url);
    let res;
    try {
      res = await fetchUrl(url, { timeout: opts.timeout });
    } catch (e) {
      console.error(`⚠️  Не удалось загрузить sitemap ${url}: ${e.message}`);
      return;
    }
    const locs = parseSitemap(res.body);
    const isIndex = /<sitemapindex[\s>]/i.test(res.body);

    if (isIndex) {
      for (const loc of locs) {
        const abs = new URL(loc, url).toString();
        await processSitemap(abs);
      }
    } else {
      for (const loc of locs) {
        try { allUrls.add(new URL(loc, url).toString()); } catch { /* ignore */ }
      }
    }
  }

  for (const w of working) await processSitemap(w);
  return [...allUrls];
}

// ---------- Утилиты ----------
function pathForCheck(absUrl) {
  const u = new URL(absUrl);
  return u.pathname + (u.search || '');
}

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
    console.error('Использование: node check-robots.js <url> [--user-agent UA] [--json] [--timeout ms]');
    process.exit(1);
  }

  // Нормализуем базовый URL
  let baseUrl = args.baseUrl;
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'https://' + baseUrl;
  const base = new URL(baseUrl);
  const origin = `${base.protocol}//${base.host}`;

  console.error(gray(`→ База: ${origin}`));
  console.error(gray(`→ User-Agent: ${args.userAgent}`));

  // 1. robots.txt
  let robotsContent = '';
  let robotsStatus = 'not found';
  try {
    const res = await fetchUrl(new URL('/robots.txt', origin).toString(), { timeout: args.timeout });
    robotsContent = res.body;
    robotsStatus = 'ok';
  } catch (e) {
    console.error(yellow(`⚠️  robots.txt: ${e.message}`));
  }

  const robots = new RobotsTxt(robotsContent);
  console.error(gray(`→ robots.txt: ${robotsStatus}, групп: ${robots.groups.length}, sitemap'ов: ${robots.sitemaps.length}`));

  // 2. Собираем URL из sitemap
  const urls = await collectSitemapUrls(origin, robots, args);
  console.error(gray(`→ Найдено URL в sitemap: ${urls.length}`));

  if (!urls.length) {
    console.error(yellow('⚠️  Не найдено ни одного URL для проверки.'));
    process.exit(0);
  }

  // 3. Проверяем каждый
  const results = [];
  let allowedCount = 0;
  let disallowedCount = 0;

  for (const url of urls) {
    const path = pathForCheck(url);
    const { allowed, matchedRule } = robots.isAllowed(path, args.userAgent);
    if (allowed) allowedCount++; else disallowedCount++;
    results.push({ url, path, allowed, matchedRule });
  }

  // 4. Вывод
  if (args.json) {
    console.log(JSON.stringify({
      base: origin,
      userAgent: args.userAgent,
      total: results.length,
      allowed: allowedCount,
      disallowed: disallowedCount,
      results,
    }, null, 2));
    return;
  }

  console.log('\n' + bold('Результаты проверки:'));
  console.log(bold('======================\n'));

  for (const r of results) {
    const mark = r.allowed ? green('✓ ALLOW ') : red('✗ DISALLOW');
    const rule = r.matchedRule
      ? gray(`  [${r.matchedRule.type}: ${r.matchedRule.path}]`)
      : gray('  [нет совпадений — разрешено по умолчанию]');
    console.log(`${mark}  ${r.path}${rule}`);
  }

  console.log('\n' + bold('Итого:'));
  console.log(`  Всего URL:   ${results.length}`);
  console.log(`  ${green('Разрешено:')}   ${allowedCount}`);
  console.log(`  ${red('Запрещено:')}   ${disallowedCount}`);

  process.exit(disallowedCount > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(red(`Ошибка: ${e.message}`));
  process.exit(1);
});