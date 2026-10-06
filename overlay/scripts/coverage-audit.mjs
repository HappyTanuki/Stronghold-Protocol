import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const overlay = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.resolve(process.argv[2] || path.join(overlay, '..', '..', 'upstream'));
const reportPath = path.resolve(process.argv[3] || path.join(overlay, '..', 'coverage-763e224.json'));
const dictFiles = ['official', 'data', 'manual', 'ui', 'patterns'];
const dictionaries = {};
const merged = new Map();
for (const name of dictFiles) {
  const file = path.join(overlay, 'files/public/i18n/ko', `${name}.json`);
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  dictionaries[name] = Object.keys(obj).filter(key => !key.startsWith('//')).length;
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith('//') && typeof value === 'string') merged.set(key, value);
  }
}

const hasCjk = value => /[\u3400-\u9fff]/u.test(value);
const decode = raw => raw.replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/gs, (whole, esc) => {
  if (esc.startsWith('u{')) return String.fromCodePoint(parseInt(esc.slice(2, -1), 16));
  if (esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16));
  if (esc.startsWith('x')) return String.fromCharCode(parseInt(esc.slice(1), 16));
  return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\n': '', '\r': '', '\\': '\\', "'": "'", '"': '"', '`': '`' })[esc] ?? esc;
});
function skipQuoted(source, at, quote) {
  let i = at + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i++] === quote) break;
  }
  return i;
}
function templateQuasis(source, at) {
  const out = [];
  let i = at + 1, start = i, depth = 0, exprQuote = '';
  while (i < source.length) {
    const c = source[i];
    if (depth === 0) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { out.push(source.slice(start, i)); return [i + 1, out]; }
      if (c === '$' && source[i + 1] === '{') { out.push(source.slice(start, i)); i += 2; start = i; depth = 1; continue; }
      i++; continue;
    }
    if (exprQuote) {
      if (c === '\\') { i += 2; continue; }
      if (c === exprQuote) exprQuote = '';
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { exprQuote = c; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) start = i + 1; }
    i++;
  }
  return [i, out];
}
const rows = new Map();
function add(text, file, line, kind) {
  let clean = text.replace(/<[^>]*>/g, ' ').replace(/\$\{[^{}]*\}/g, ' {0} ').replace(/&nbsp;/g, ' ')
    .replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!hasCjk(clean)) return;
  if (!rows.has(clean)) rows.set(clean, { text: clean, occurrences: 0, locations: [] });
  const row = rows.get(clean); row.occurrences++;
  if (row.locations.length < 6) row.locations.push({ file: path.relative(upstream, file).replaceAll('\\', '/'), line, kind });
}
function scan(file) {
  const source = fs.readFileSync(file, 'utf8');
  let i = 0, line = 1;
  while (i < source.length) {
    const c = source[i], n = source[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && n === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'") {
      const start = i, rowLine = line; i = skipQuoted(source, i, c);
      const raw = source.slice(start + 1, Math.max(start + 1, i - 1));
      const text = decode(raw);
      if (hasCjk(text)) add(text, file, rowLine, 'quoted-literal');
      line += (source.slice(start, i).match(/\n/g) || []).length;
      continue;
    }
    if (c === '`') {
      const start = i, rowLine = line; const [end, quasis] = templateQuasis(source, i); i = end;
      const combined = quasis.map((q, k) => `${decode(q)}${k < quasis.length - 1 ? ' {0} ' : ''}`).join('');
      if (hasCjk(combined)) add(combined, file, rowLine, 'template-text');
      line += (source.slice(start, i).match(/\n/g) || []).length;
      continue;
    }
    i++;
  }
}
const scanRoots = ['public/js/screens', 'public/js/ui'];
const scannedFiles = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(file);
    else if (ent.isFile() && file.endsWith('.js')) { scannedFiles.push(file); scan(file); }
  }
}
for (const rel of scanRoots) walk(path.join(upstream, rel));

const extracted = [...rows.values()].sort((a, b) => a.text.localeCompare(b.text, 'zh-Hans'));
const exactCovered = extracted.filter(row => merged.has(row.text));
const uncovered = extracted.filter(row => !merged.has(row.text));
const report = {
  schema: 'stronghold-ko-coverage/v1',
  upstreamRevision: '763e224b8d72c2362e70a8f1283a74e644195712',
  scanRoots,
  scannedFileCount: scannedFiles.length,
  dictionaryKeyCounts: dictionaries,
  mergedUniqueDictionaryKeys: merged.size,
  extractedUniqueCjkTexts: extracted.length,
  extractedOccurrences: extracted.reduce((n, row) => n + row.occurrences, 0),
  exactKeyCoveredUnique: exactCovered.length,
  exactKeyCoveredOccurrences: exactCovered.reduce((n, row) => n + row.occurrences, 0),
  exactKeyUncoveredUnique: uncovered.length,
  exactKeyUncoveredOccurrences: uncovered.reduce((n, row) => n + row.occurrences, 0),
  extracted,
  uncovered,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ reportPath, scanRoots, scannedFileCount: report.scannedFileCount,
  dictionaryKeyCounts: dictionaries, mergedUniqueDictionaryKeys: merged.size,
  extractedUniqueCjkTexts: report.extractedUniqueCjkTexts, extractedOccurrences: report.extractedOccurrences,
  exactKeyCoveredUnique: report.exactKeyCoveredUnique, exactKeyCoveredOccurrences: report.exactKeyCoveredOccurrences,
  exactKeyUncoveredUnique: report.exactKeyUncoveredUnique, exactKeyUncoveredOccurrences: report.exactKeyUncoveredOccurrences }, null, 2));
console.log('\n--- first 100 exact-key uncovered candidates ---');
for (const row of uncovered.slice(0, 100)) console.log(`${row.occurrences}\t${row.text}\t${JSON.stringify(row.locations[0])}`);
