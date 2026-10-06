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
  for (const [key, value] of Object.entries(obj)) if (!key.startsWith('//') && typeof value === 'string') merged.set(key, value);
}
const hasCjk = value => /[\u3400-\u9fff]/u.test(value);
const decode = raw => raw.replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/gs, (whole, esc) => {
  if (esc.startsWith('u{')) return String.fromCodePoint(parseInt(esc.slice(2, -1), 16));
  if (esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16));
  if (esc.startsWith('x')) return String.fromCharCode(parseInt(esc.slice(1), 16));
  return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"', '`': '`' })[esc] ?? esc;
});
const lineAt = (source, pos) => 1 + (source.slice(0, pos).match(/\n/g) || []).length;
function skipString(source, at, quote) {
  let i = at + 1;
  while (i < source.length) { if (source[i] === '\\') { i += 2; continue; } if (source[i++] === quote) break; }
  return i;
}
function skipComment(source, at) {
  if (source[at + 1] === '/') { let i = at + 2; while (i < source.length && source[i] !== '\n') i++; return i; }
  let i = at + 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
  return Math.min(source.length, i + 2);
}
function expressionEnd(source, at) {
  let i = at, depth = 1;
  while (i < source.length && depth > 0) {
    const c = source[i], n = source[i + 1];
    if (c === '/' && (n === '/' || n === '*')) { i = skipComment(source, i); continue; }
    if (c === '"' || c === "'") { i = skipString(source, i, c); continue; }
    if (c === '`') { i = templateParts(source, i).end; continue; }
    if (c === '{') depth++; else if (c === '}') depth--;
    i++;
  }
  return i - 1;
}
function templateParts(source, at) {
  const quasis = [], expressions = [];
  let i = at + 1, start = i;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { quasis.push({ raw: source.slice(start, i), at: start }); return { end: i + 1, quasis, expressions }; }
    if (c === '$' && source[i + 1] === '{') {
      quasis.push({ raw: source.slice(start, i), at: start });
      const exprStart = i + 2, close = expressionEnd(source, exprStart);
      expressions.push({ raw: source.slice(exprStart, close), at: exprStart });
      i = close + 1; start = i; continue;
    }
    i++;
  }
  quasis.push({ raw: source.slice(start), at: start });
  return { end: i, quasis, expressions };
}
const rows = new Map();
function add(text, file, line, kind) {
  const clean = text.replace(/&nbsp;/g, ' ').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!hasCjk(clean)) return;
  if (!rows.has(clean)) rows.set(clean, { text: clean, occurrences: 0, locations: [] });
  const row = rows.get(clean); row.occurrences++;
  if (row.locations.length < 6) row.locations.push({ file: path.relative(upstream, file).replaceAll('\\', '/'), line, kind });
}
function addTemplateText(raw, file, source, at) {
  const text = decode(raw);
  for (const part of text.replace(/<[^>]*>/gs, '\n').split(/\n+/)) add(part, file, lineAt(source, at), 'template-text-node');
  for (const m of text.matchAll(/\b(?:title|placeholder|aria-label|alt)\s*=\s*["']([^"']*)["']/g)) {
    add(m[1], file, lineAt(source, at + m.index), 'template-attribute');
  }
}
function scanRange(source, start, end, file) {
  let i = start;
  while (i < end) {
    const c = source[i], n = source[i + 1];
    if (c === '/' && (n === '/' || n === '*')) { i = skipComment(source, i); continue; }
    if (c === '"' || c === "'") {
      const begin = i, stop = skipString(source, i, c);
      add(decode(source.slice(begin + 1, Math.max(begin + 1, stop - 1))), file, lineAt(source, begin), 'quoted-literal');
      i = stop; continue;
    }
    if (c === '`') {
      const parts = templateParts(source, i);
      addTemplateText(parts.quasis.map((q, k) => `${q.raw}${k < parts.expressions.length ? `{${k}}` : ''}`).join(''), file, source, i);
      for (const expr of parts.expressions) scanRange(source, expr.at, expr.at + expr.raw.length, file);
      i = parts.end; continue;
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
    else if (ent.isFile() && file.endsWith('.js')) { scannedFiles.push(file); const src = fs.readFileSync(file, 'utf8'); scanRange(src, 0, src.length, file); }
  }
}
for (const rel of scanRoots) walk(path.join(upstream, rel));
const extracted = [...rows.values()].sort((a, b) => a.text.localeCompare(b.text, 'zh-Hans'));
const exactCovered = extracted.filter(row => merged.has(row.text));
const uncovered = extracted.filter(row => !merged.has(row.text));
const report = {
  schema: 'stronghold-ko-coverage/v1', upstreamRevision: '763e224b8d72c2362e70a8f1283a74e644195712', scanRoots,
  extractor: 'JS quoted literals plus HTM template text nodes and static title/placeholder/aria-label/alt attributes; comments excluded; direct exact-key lookup only.',
  scannedFileCount: scannedFiles.length, dictionaryKeyCounts: dictionaries, mergedUniqueDictionaryKeys: merged.size,
  extractedUniqueCjkTexts: extracted.length, extractedOccurrences: extracted.reduce((n, row) => n + row.occurrences, 0),
  exactKeyCoveredUnique: exactCovered.length, exactKeyCoveredOccurrences: exactCovered.reduce((n, row) => n + row.occurrences, 0),
  exactKeyUncoveredUnique: uncovered.length, exactKeyUncoveredOccurrences: uncovered.reduce((n, row) => n + row.occurrences, 0),
  extracted, uncovered,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ reportPath, scanRoots, scannedFileCount: report.scannedFileCount, dictionaryKeyCounts: dictionaries,
  mergedUniqueDictionaryKeys: merged.size, extractedUniqueCjkTexts: report.extractedUniqueCjkTexts,
  extractedOccurrences: report.extractedOccurrences, exactKeyCoveredUnique: report.exactKeyCoveredUnique,
  exactKeyCoveredOccurrences: report.exactKeyCoveredOccurrences, exactKeyUncoveredUnique: report.exactKeyUncoveredUnique,
  exactKeyUncoveredOccurrences: report.exactKeyUncoveredOccurrences }, null, 2));
console.log('\n--- exact-key uncovered candidates (first 150) ---');
for (const row of uncovered.slice(0, 150)) console.log(`${row.occurrences}\t${row.text}\t${JSON.stringify(row.locations[0])}`);
