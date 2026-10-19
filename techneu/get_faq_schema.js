#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

/**
 * Преобразует массив {question, answer} в Schema.org FAQPage JSON-LD.
 * @param {Array<{question: string, answer: string}>} faq
 * @param {Object} [options]
 * @param {string} [options.lang='ru']      - язык страницы (inLanguage)
 * @param {string} [options.url]            - URL страницы (опционально)
 * @param {string} [options.name]           - название страницы (опционально)
 * @param {string} [options.description]    - описание страницы (опционально)
 * @returns {Object} JSON-LD объект
 */
function buildFaqJsonLd(faq, options = {}) {
  const { lang = 'ru', url, name, description } = options;

  if (!Array.isArray(faq)) {
    throw new Error('Ожидается массив вопросов-ответов');
  }

  const mainEntity = faq
    .filter((item) => item && item.question && item.answer)
    .map((item) => ({
      '@type': 'Question',
      name: clean(item.question),
      acceptedAnswer: {
        '@type': 'Answer',
        text: clean(item.answer),
      },
    }));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: lang,
    mainEntity,
  };

  if (url) jsonLd.url = url;
  if (name) jsonLd.name = name;
  if (description) jsonLd.description = description;

  return jsonLd;
}

/** Убирает лишние пробелы/переносы, нормализует строку */
function clean(str) {
  return String(str).replace(/\s+/g, ' ').trim();
}

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  const inputPath = args[0];

  if (!inputPath) {
    console.error(
      'Использование: node faq-to-jsonld.js <входной.json> [выходной.json] [--url=...] [--lang=ru] [--name=...] [--description=...]'
    );
    process.exit(1);
  }

  // Разбор необязательных параметров
  const opts = { lang: 'ru' };
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--')) {
      const [k, ...v] = a.slice(2).split('=');
      if (v.length) opts[k] = v.join('=');
    } else {
      positional.push(a);
    }
  }

  const inputAbs = path.resolve(inputPath);

  try {
    const raw = fs.readFileSync(inputAbs, 'utf-8');
    const faq = JSON.parse(raw);

    const jsonLd = buildFaqJsonLd(faq, {
      lang: opts.lang,
      url: opts.url,
      name: opts.name,
      description: opts.description,
    });

    const output = JSON.stringify(jsonLd, null, 2);

    const outputPath = positional[1];
    if (outputPath) {
      fs.writeFileSync(path.resolve(outputPath), output, 'utf-8');
      console.error(`✔ JSON-LD сохранён: ${outputPath}`);
    } else {
      // В stdout — только валидный JSON, чтобы можно было пайпить
      process.stdout.write(output + '\n');
    }
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exit(1);
  }
}

module.exports = { buildFaqJsonLd };