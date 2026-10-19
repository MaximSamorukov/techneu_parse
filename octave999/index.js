const fs = require('fs');
const path = require('path');

/**
 * Фильтрует CSV файл:
 * - удаляет строки, где больше 5 слов
 * - удаляет строки, содержащие "1с" (регистронезависимо)
 *
 * @param {string} inputPath - путь к исходному CSV
 * @param {string} outputPath - путь к результату
 */
function filterCsv(inputPath, outputPath) {
  const content = fs.readFileSync(inputPath, 'utf8');
  const lines = content.split(/\r?\n/);

  const filtered = lines.filter((line) => {
    // Пропускаем пустые строки (можно оставить их или убрать — здесь убираем)
    if (line.trim() === '') return false;

    // Удаляем строки, где встречается "1с" (регистронезависимо)
    //if (/1с/i.test(line)) return false;
    //if (/1с/i.test(line)) return false;
    //if (/презентация/i.test(line)) return false;
    //if (/звука/i.test(line)) return false;
    //if (/excel/i.test(line)) return false;
    //if (/эксель/i.test(line)) return false;
    const blacklist = [/газпром/i, /это/i, /заказы/i];
    if (blacklist.some((re) => re.test(line))) return false;
    
    // Удаляем строки, где больше 5 слов
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (words.length > 5) return false;

    return true;
  });

  fs.writeFileSync(outputPath, filtered.join('\n'), 'utf8');
  console.log(`Готово. Строк было: ${lines.length}, осталось: ${filtered.length}`);
}

// === Запуск ===
const inputFile = process.argv[2] || path.join(__dirname, 'input.csv');
const outputFile = process.argv[3] || path.join(__dirname, 'output.csv');

filterCsv(inputFile, outputFile);