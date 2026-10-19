#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// ---------- Конфигурация ----------
const args = process.argv.slice(2);
const inputFile = args[0];

if (!inputFile) {
  console.error('Использование: node json-to-csv.js <report.json> [outputDir]');
  process.exit(1);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Файл не найден: ${inputFile}`);
  process.exit(1);
}

const outputDir = args[1] || path.join(path.dirname(inputFile), 'csv');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// ---------- Утилиты ----------
function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Если есть запятая, кавычка, перевод строки — оборачиваем в кавычки
  if (/[",\n\r;]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCSV(rows, headers) {
  const lines = [];
  lines.push(headers.map(escapeCSV).join(','));
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCSV(row[h])).join(','));
  }
  // BOM для корректного отображения кириллицы в Excel
  return '\uFEFF' + lines.join('\n');
}

function writeCSV(filename, content) {
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, content, 'utf-8');
  console.log(`✓ ${filepath}`);
}

// ---------- Загрузка отчёта ----------
console.log(`Читаем отчёт: ${inputFile}\n`);
const report = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));

if (!report.pages || !Array.isArray(report.pages)) {
  console.error('В отчёте нет поля "pages" — проверьте формат файла.');
  process.exit(1);
}

// ---------- 1. pages.csv — по одной строке на страницу ----------
const pagesRows = report.pages.map((p) => ({
  url: p.url,
  final_url: p.finalUrl || '',
  status: p.status || '',
  total_links: p.total,
  internal_links: p.internal,
  external_links: p.external,
  invalid_links: p.invalid,
  internal_ratio:
    p.total > 0 ? ((p.internal / p.total) * 100).toFixed(2) + '%' : '',
  external_ratio:
    p.total > 0 ? ((p.external / p.total) * 100).toFixed(2) + '%' : '',
  external_hosts_count: (p.externalHosts || []).length,
  external_hosts: (p.externalHosts || []).join(' | '),
  error: p.error || '',
}));

writeCSV(
  'pages.csv',
  toCSV(pagesRows, [
    'url',
    'final_url',
    'status',
    'total_links',
    'internal_links',
    'external_links',
    'invalid_links',
    'internal_ratio',
    'external_ratio',
    'external_hosts_count',
    'external_hosts',
    'error',
  ])
);

// ---------- 2. summary.csv — общая статистика ----------
const s = report.summary || {};
const summaryRows = [
  { metric: 'sitemap_url', value: report.sitemapUrl || '' },
  { metric: 'base_domain', value: report.baseDomain || '' },
  { metric: 'generated_at', value: report.generatedAt || '' },
  { metric: 'duration_sec', value: report.durationSec || '' },
  { metric: 'total_pages', value: s.totalPages || 0 },
  { metric: 'errors', value: s.errors || 0 },
  { metric: 'total_links', value: s.totalLinks || 0 },
  { metric: 'total_internal', value: s.totalInternal || 0 },
  { metric: 'total_external', value: s.totalExternal || 0 },
  { metric: 'total_invalid', value: s.totalInvalid || 0 },
  {
    metric: 'internal_ratio',
    value:
      s.totalLinks > 0
        ? ((s.totalInternal / s.totalLinks) * 100).toFixed(2) + '%'
        : '',
  },
  {
    metric: 'external_ratio',
    value:
      s.totalLinks > 0
        ? ((s.totalExternal / s.totalLinks) * 100).toFixed(2) + '%'
        : '',
  },
];

writeCSV('summary.csv', toCSV(summaryRows, ['metric', 'value']));

// ---------- 3. external_hosts.csv ----------
const externalHosts = report.externalHosts || {};
const externalRows = Object.entries(externalHosts)
  .map(([host, count]) => ({ host, pages_count: count }))
  .sort((a, b) => b.pages_count - a.pages_count);

writeCSV(
  'external_hosts.csv',
  toCSV(externalRows, ['host', 'pages_count'])
);

// ---------- 4. internal_hosts.csv ----------
const internalHosts = report.internalHosts || {};
const internalRows = Object.entries(internalHosts)
  .map(([host, count]) => ({ host, pages_count: count }))
  .sort((a, b) => b.pages_count - a.pages_count);

writeCSV(
  'internal_hosts.csv',
  toCSV(internalRows, ['host', 'pages_count'])
);

// ---------- 5. errors.csv — только проблемные страницы ----------
const errorRows = report.pages
  .filter((p) => p.error || p.total === 0)
  .map((p) => ({
    url: p.url,
    type: p.error ? 'request_error' : 'no_links',
    status: p.status || '',
    message: p.error || 'No <a> tags found',
  }));

writeCSV('errors.csv', toCSV(errorRows, ['url', 'type', 'status', 'message']));

console.log(`\nГотово. Файлы сохранены в: ${outputDir}`);