#!/usr/bin/env node
/**
 * build-jsonld.js
 *
 * Читает CSV (Summary;Column1;Column2) и генерирует плоский JSON-LD
 * (Service + OfferCatalog + Offer[]) в файл.
 *
 * Использование:
 *   node build-jsonld.js path/to/Summary;Column1;Column2.txt [out.json]
 *
 * Зависимости: csv-parse  (npm i csv-parse)
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 1. ЗАХАРДКОЖЕННЫЕ ЗНАЧЕНИЯ — правьте здесь
// ─────────────────────────────────────────────────────────────────────────────

// Корневой Service
const ROOT_SERVICE_NAME = 'Услуги эвакуатора в Москве';
const ROOT_SERVICE_DESCRIPTION = 'Круглосуточная эвакуация автомобилей, мотоциклов, грузовиков и спецтехники в Москве и области.';

// Провайдер (LocalBusiness / Organization)
const PROVIDER = {
  '@type': 'LocalBusiness',
  name: 'Эвакуатор Шмель',
  url: 'https://techneu.ru',
  telephone: '+7-499-187-37-77',
  email: 'evakuator@techneu.ru',
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'проезд Серебрякова, д.14, стр.9',
    addressLocality: 'Москва',
    postalCode: '127254',
    addressCountry: 'RU',
  },
  openingHoursSpecification: {
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: [
      'Monday', 'Tuesday', 'Wednesday', 'Thursday',
      'Friday', 'Saturday', 'Sunday',
    ],
    opens: '00:00',
    closes: '23:59',
  },
};

// География
const AREA_SERVED = [
  { '@type': 'City', name: 'Москва' },
  { '@type': 'AdministrativeArea', name: 'Московская область' },
];

// Каталог
const CATALOG_NAME = 'Тарифы на эвакуацию';
const CATALOG_DESCRIPTION = 'Прайс-лист услуг эвакуатора: по городу, за МКАД, межгород, манипулятор, наценки за сложность погрузки, типы эвакуаторов.';

// Валюта
const PRICE_CURRENCY = 'RUB';

// Значение availability для всех Offer (см. https://schema.org/ItemAvailability)
const OFFER_AVAILABILITY = 'https://schema.org/InStock';

// ─────────────────────────────────────────────────────────────────────────────
// 2. Код (обычно менять не нужно)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

let parseCsv;
try {
  ({ parse: parseCsv } = require('csv-parse/sync'));
} catch (e) {
  console.error('Не найден модуль csv-parse. Установите: npm i csv-parse');
  process.exit(1);
}

// ── Парсер CSV ───────────────────────────────────────────────────────────────

function loadRows(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const records = parseCsv(raw, {
    columns: true,
    delimiter: ';',
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  return records
    .map(r => ({
      summary: (r.Summary || '').trim(),
      name: (r.Column1 || '').trim(),
      priceRaw: (r.Column2 || '').trim(),
    }))
    .filter(r => r.name && r.summary); // строки без названия/группы пропускаем
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

function parseNumber(str) {
  if (!str) return null;
  const cleaned = String(str)
    .replace(/\u00A0/g, ' ')   // NBSP
    .replace(/\s/g, '')
    .replace(',', '.');
  const m = cleaned.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// ── Классификатор цены ───────────────────────────────────────────────────────

function classify(priceRaw) {
  const s = String(priceRaw).toLowerCase().trim();

  if (!s) {
    return { kind: 'unknown', value: null, raw: priceRaw };
  }

  // 1. Бесплатно
  if (/бесплатн/.test(s)) {
    return { kind: 'free', value: 0 };
  }

  // 2. За километр: "от 53 руб за километр", "от 63 руб за км"
  const perKm = s.match(/(?:от\s+)?([\d\s\u00A0]+)\s*(?:руб|₽)?\s*за\s*(?:километр|км)/);
  if (perKm) {
    const v = parseNumber(perKm[1]);
    if (v !== null) return { kind: 'per_km', value: v };
  }

  // 3. Процент: "-5%", "+10%", "50% от заказа"
  const pct = s.match(/([+-]?\d+)\s*%/);
  if (pct) {
    const val = Number(pct[1]);
    return {
      kind: val < 0 ? 'percent_discount' : 'percent_surcharge',
      value: Math.abs(val),
    };
  }

  // 4. Фиксированная наценка: "+ 500", "+ 1500"
  const surcharge = s.match(/^\+\s*([\d\s\u00A0]+)/);
  if (surcharge) {
    const v = parseNumber(surcharge[1]);
    if (v !== null) return { kind: 'surcharge', value: v };
  }

  // 5. "от X" или "по X"
  const from = s.match(/(?:от|по)\s+([\d\s\u00A0]+)/);
  if (from) {
    const v = parseNumber(from[1]);
    if (v !== null) return { kind: 'from', value: v };
  }

  // 6. "по договоренности" / "индивидуально"
  if (/договор|индивидуальн/.test(s)) {
    return { kind: 'negotiable', value: null };
  }

  // 7. Просто число
  const num = parseNumber(s);
  if (num !== null) {
    return { kind: 'fixed', value: num };
  }

  return { kind: 'unknown', value: null, raw: priceRaw };
}

// ── PriceSpecification ───────────────────────────────────────────────────────

function buildPriceSpecification(cls) {
  switch (cls.kind) {
    case 'free':
      return {
        '@type': 'PriceSpecification',
        price: 0,
        priceCurrency: PRICE_CURRENCY,
      };
    case 'fixed':
      return {
        '@type': 'PriceSpecification',
        price: cls.value,
        priceCurrency: PRICE_CURRENCY,
      };
    case 'from':
      return {
        '@type': 'PriceSpecification',
        minPrice: cls.value,
        priceCurrency: PRICE_CURRENCY,
      };
    case 'per_km':
      return {
        '@type': 'UnitPriceSpecification',
        price: cls.value,
        priceCurrency: PRICE_CURRENCY,
        referenceQuantity: {
          '@type': 'QuantitativeValue',
          unitCode: 'KMT',
          value: 1,
        },
      };
    case 'surcharge':
      return {
        '@type': 'PriceSpecification',
        price: cls.value,
        priceCurrency: PRICE_CURRENCY,
        description: `Наценка +${cls.value} ₽`,
      };
    case 'percent_discount':
      return {
        '@type': 'PriceSpecification',
        description: `Скидка ${cls.value}% от стоимости`,
      };
    case 'percent_surcharge':
      return {
        '@type': 'PriceSpecification',
        description: `Наценка ${cls.value}%`,
      };
    case 'negotiable':
      return {
        '@type': 'PriceSpecification',
        description: 'По договорённости',
      };
    default:
      return {
        '@type': 'PriceSpecification',
        description: cls.raw || 'Цена не указана',
      };
  }
}

// ── Offer ────────────────────────────────────────────────────────────────────

function buildOffer(row) {
  const cls = classify(row.priceRaw);
  const offer = {
    '@type': 'Offer',
    category: row.summary,
    itemOffered: {
      '@type': 'Service',
      name: row.name,
    },
    priceSpecification: buildPriceSpecification(cls),
  };
  if (cls.kind !== 'unknown' && cls.kind !== 'negotiable') {
    offer.availability = OFFER_AVAILABILITY;
  }
  return offer;
}

// ── Сборка документа ─────────────────────────────────────────────────────────

function buildJsonLd(rows) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: ROOT_SERVICE_NAME,
    description: ROOT_SERVICE_DESCRIPTION,
    provider: PROVIDER,
    areaServed: AREA_SERVED,
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: CATALOG_NAME,
      description: CATALOG_DESCRIPTION,
      numberOfItems: rows.length,
      itemListElement: rows.map(buildOffer),
    },
  };
}

// ── Точка входа ──────────────────────────────────────────────────────────────

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Использование: node build-jsonld.js <path-to-csv> [out.json]');
    process.exit(1);
  }
  const outPath = process.argv[3] || path.join(path.dirname(csvPath), 'jsonld.json');

  const rows = loadRows(csvPath);
  if (!rows.length) {
    console.error('CSV пуст или не распознан. Проверьте колонки Summary;Column1;Column2 и разделитель ";"');
    process.exit(2);
  }

  const jsonLd = buildJsonLd(rows);
  const json = JSON.stringify(jsonLd, null, 2);

  fs.writeFileSync(outPath, json, 'utf-8');
  fs.writeFileSync(outPath.replace(/\.json$/, '.html'),
    `<script type="application/ld+json">\n${json}\n</script>\n`, 'utf-8');

  // Статистика по классам цен
  const stats = {};
  for (const r of rows) {
    const k = classify(r.priceRaw).kind;
    stats[k] = (stats[k] || 0) + 1;
  }

  console.log(`CSV:     ${csvPath}`);
  console.log(`JSON:    ${outPath}`);
  console.log(`HTML:    ${outPath.replace(/\.json$/, '.html')}`);
  console.log(`Offers:  ${rows.length}`);
  console.log('Классы цен:', stats);

  const unknown = rows.filter(r => classify(r.priceRaw).kind === 'unknown');
  if (unknown.length) {
    console.warn('\n⚠ Не распознаны цены (проверьте regex в classify):');
    unknown.forEach(r => console.warn(`   • "${r.priceRaw}"  —  ${r.name}`));
  }
}

if (require.main === module) main();

module.exports = { loadRows, classify, buildOffer, buildJsonLd };