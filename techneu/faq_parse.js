#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

function parseFaq(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }

  const html = fs.readFileSync(filePath, 'utf-8');
  const $ = cheerio.load(html);

  const result = [];

  // Ищем контейнер FAQ (если есть) либо работаем по всему документу
  const $root = $('.faq_inner').length ? $('.faq_inner') : $.root();

  $root.find('details').each((_, detailsEl) => {
    const $details = $(detailsEl);

    // Ищем summary с id="accordion__title"
    const $summary = $details.find('summary#accordion__title').first();
    if (!$summary.length) return; // пропускаем, если нет нужного summary

    const question = normalizeText($summary.text());

    // Берём первый div после summary — это контейнер ответа
    const $answerContainer = $details.children('div').first();
    if (!$answerContainer.length) return;

    // ---- Парсинг списков ----
    // Обрабатываем каждый <ul> отдельно: заменяем на текст "a, b, c"
    const lists = [];
    $answerContainer.find('ul').each((i, ul) => {
      const items = [];
      $(ul)
        .find('li')
        .each((__, li) => {
          const text = normalizeText($(li).text());
          if (text) items.push(text);
        });
      if (items.length) {
        lists.push(items.join(', '));
      }
    });

    // Убираем <ul> из клона, чтобы получить чистый текст абзацев
    const $clone = $answerContainer.clone();
    $clone.find('ul').remove();
    const plainText = normalizeText($clone.text());

    // Собираем итоговый ответ: текстовые абзацы + списки через запятую
    const answerParts = [];
    if (plainText) answerParts.push(plainText);
    answerParts.push(...lists);
    const answer = answerParts.filter(Boolean).join(' ').trim();

    result.push({ question, answer });
  });

  return result;
}

function normalizeText(str) {
  return (str || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

// ---------- CLI ----------
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Использование: node parse-faq.js <путь-к-файлу.html>');
    process.exit(1);
  }
  const outPath = process.argv[3] || path.join(path.dirname(filePath), 'faq_jsonld.json');
  const absPath = path.resolve(filePath);

  try {
    const faq = parseFaq(absPath);
    const json = JSON.stringify(faq, null, 2);
    console.log(JSON.stringify(faq, null, 2));
    fs.writeFileSync(outPath, json, 'utf-8');
    fs.writeFileSync(outPath.replace(/\.json$/, '.html'),
      `<script type="application/ld+json">\n${json}\n</script>\n`, 'utf-8');
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exit(1);
  }
}

module.exports = { parseFaq };