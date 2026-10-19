const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const filePath = path.join(__dirname, 'price.html');
const html = fs.readFileSync(filePath, 'utf-8');

const $ = cheerio.load(html, { decodeEntities: false });
const results = [];

$('details').each((_, detailsEl) => {
  const summaryText = $(detailsEl).find('summary').first().text().trim().replace(/\s+/g, ' ');
  const $table = $(detailsEl).find('table').first();
  
  if (!$table.length) {
    results.push({ summary: summaryText, column1: '', column2: '' });
    return;
  }
  
  $table.find('tr').each((_, tr) => {
    const $cells = $(tr).find('td');
    if ($cells.length >= 2) {
      results.push({
        summary: summaryText,
        column1: $cells.eq(0).text().trim().replace(/\s+/g, ' '),
        column2: $cells.eq(1).text().trim().replace(/\s+/g, ' ')
      });
    }
  });
});

// Вывод
results.forEach((row, i) => {
  console.log(`[${i + 1}] ${row.summary} | ${row.column1} | ${row.column2}`);
});

// CSV-вывод
const csv = [
  'Summary;Column1;Column2',
  ...results.map(r => `"${r.summary}";"${r.column1}";"${r.column2}"`)
].join('\n');
fs.writeFileSync(path.join(__dirname, 'parsed_data.csv'), '\uFEFF' + csv, 'utf-8');
console.log(`\nСохранено в CSV: parsed_data.csv, записей: ${results.length}`);