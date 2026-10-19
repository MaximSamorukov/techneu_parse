/**
 * Парсер страниц товаров.
 *
 * Функционал:
 *  1. Запускается из терминала: `node parse.js <путь_к_csv>`.
 *  2. Первый аргумент — путь к CSV-файлу, в котором есть колонка `final_url`
 *     со списком страниц для парсинга.
 *  3. Для каждой страницы:
 *       - Находит div.infoProduct
 *         - внутри него h1 — название товара (очищается от HTML-тегов,
 *           так как внутри может быть <span> и др.);
 *         - внутри него div.pricePageProduct -> внутренний <span> — цена.
 *  4. Результаты (final_url, name, price) сохраняет в файл
 *     `result.csv` в текущей директории.
 *
 * Ошибки по отдельным страницам не прерывают работу скрипта —
 * проблемные URL получают пустые значения полей и предупреждение в консоль.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// ---------- Утилиты ----------

/**
 * Убирает HTML-теги из строки и схлопывает лишние пробелы.
 */
function stripTags(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, '')       // удаляем теги
    .replace(/&nbsp;/gi, ' ')      // заменяем неразрывные пробелы
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')          // схлопываем пробелы
    .trim();
}

/**
 * Небольшая задержка между запросами (чтобы не долбить сайт).
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Скачивает страницу и возвращает HTML.
 */
async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    timeout: 30000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept-Language': 'ru,en;q=0.9',
    },
  });
  return data;
}

/**
 * Парсит одну страницу. Возвращает { name, price }.
 */
async function parsePage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const $info = $('div.infoProduct').first();
  if (!$info.length) {
    throw new Error('div.infoProduct не найден');
  }

  // Название: берём h1 внутри infoProduct и очищаем от тегов
  const nameHtml = $info.find('h1').first().html() || '';
  const name = stripTags(nameHtml);

  // Цена: div.pricePageProduct -> внутренний span
  const $priceWrap = $info.find('div.pricePageProduct').first();
  let price = '';
  if ($priceWrap.length) {
    const $span = $priceWrap.find('span').first();
    price = stripTags($span.length ? $span.html() : $priceWrap.html());
  }

  return { name, price };
}

// ---------- Основной поток ----------

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Использование: node parse.js <путь_к_csv>');
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Файл не найден: ${inputPath}`);
    process.exit(1);
  }

  // Читаем CSV
  const raw = fs.readFileSync(inputPath, 'utf8');
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  if (records.length === 0) {
    console.error('CSV пустой');
    process.exit(1);
  }

  if (!('final_url' in records[0])) {
    console.error('В CSV нет колонки final_url');
    process.exit(1);
  }

  const total = records.length;
  const results = [];
  const delayMs = 500;

  for (let i = 0; i < total; i++) {
    const row = records[i];
    const url = (row.final_url || '').trim();
    const idx = `[${i + 1}/${total}]`;

    if (!url) {
      console.warn(`${idx} пустой final_url — пропуск`);
      results.push({ final_url: url, name: '', price: '' });
      continue;
    }

    try {
      const { name, price } = await parsePage(url);
      console.log(`${idx} OK  ${url}\n        name: ${name}\n        price: ${price}`);
      results.push({ final_url: url, name, price });
    } catch (err) {
      console.warn(`${idx} ОШИБКА ${url}\n        ${err.message}`);
      results.push({ final_url: url, name: '', price: '' });
    }

    if (i < total - 1) await sleep(delayMs);
  }

  // Сохраняем результат
  const outPath = path.resolve('result.csv');
  const csvOut = stringify(results, {
    header: true,
    columns: ['final_url', 'name', 'price'],
  });
  fs.writeFileSync(outPath, '\uFEFF' + csvOut, 'utf8'); // BOM для Excel
  console.log(`\nГотово. Сохранено: ${outPath}`);
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});