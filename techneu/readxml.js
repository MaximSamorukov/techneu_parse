const fs = require('fs');

function sitemapToCsv(inputFile, outputFile = 'urls.csv') {
  // Читаем XML из файла
  const xmlString = fs.readFileSync(inputFile, 'utf8');
  
  // Извлекаем URL
  const locRegex = /<loc>(.*?)<\/loc>/g;
  const urls = [];
  let match;
  
  while ((match = locRegex.exec(xmlString)) !== null) {
    urls.push(match[1].trim());
  }
  
  // Записываем в CSV
  const csvContent = urls.join('\n');
  fs.writeFileSync(outputFile, csvContent, 'utf8');
  
  console.log(`Извлечено ${urls.length} URL -> ${outputFile}`);
  return urls;
}

// Использование:
sitemapToCsv('./sitemap.xml', './urls.csv');