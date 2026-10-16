// extract-unique.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const INPUT_FILE = process.argv[2] || 'input.csv';
const OUTPUT_FILE = process.argv[3] || 'unique-source-pages.txt';
const COLUMN_NAME = 'source_page';

// Простой парсер CSV-строки (учитывает кавычки)
function parseCsvLine(line, delimiter = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

async function main() {
  const inputPath = path.resolve(INPUT_FILE);
  const outputPath = path.resolve(OUTPUT_FILE);

  if (!fs.existsSync(inputPath)) {
    console.error(`Файл не найден: ${inputPath}`);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const uniqueValues = new Set();
  let headerIndex = -1;
  let lineNumber = 0;
  let delimiter = ',';

  for await (const line of rl) {
    lineNumber++;

    // Пропускаем пустые строки
    if (!line.trim()) continue;

    // Определяем разделитель по заголовку (запятая или точка с запятой)
    if (lineNumber === 1) {
      if (line.includes(';') && !line.includes(',')) delimiter = ';';
      const headers = parseCsvLine(line, delimiter).map((h) =>
        h.trim().replace(/^"|"$/g, '')
      );
      headerIndex = headers.indexOf(COLUMN_NAME);

      if (headerIndex === -1) {
        console.error(
          `Колонка "${COLUMN_NAME}" не найдена. Доступные колонки: ${headers.join(', ')}`
        );
        process.exit(1);
      }
      continue;
    }

    const columns = parseCsvLine(line, delimiter);
    const value = columns[headerIndex];

    if (value === undefined) continue;

    const cleaned = value.trim().replace(/^"|"$/g, '');
    if (cleaned !== '') {
      uniqueValues.add(cleaned);
    }
  }

  const sorted = Array.from(uniqueValues).sort();
  fs.writeFileSync(outputPath, sorted.join('\n') + '\n', 'utf8');

  console.log(`✅ Обработано строк: ${lineNumber - 1}`);
  console.log(`✅ Уникальных значений: ${sorted.length}`);
  console.log(`✅ Результат записан в: ${outputPath}`);
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});