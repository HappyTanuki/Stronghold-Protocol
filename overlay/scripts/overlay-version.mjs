import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(process.argv[2] || '/app');
const overlay = path.resolve(process.argv[3] || '/overlay');
const artifacts = path.resolve(process.argv[4] || process.env.OVERLAY_ARTIFACTS || path.join(overlay, 'artifacts'));
const lock = JSON.parse(fs.readFileSync(path.join(overlay, 'overlay.lock.json'), 'utf8'));
const payloadFiles = [
  ...lock.added.filter(x => x.endsWith('.json')).map(x => path.join(overlay, 'files', x)),
  path.join(artifacts, 'local-assets.json'),
  path.join(artifacts, 'voice-availability.json'),
];
const hash = crypto.createHash('sha256');
hash.update(lock.version);
hash.update(lock.upstream);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const file of payloadFiles) { hash.update('\0'); hash.update(path.basename(file)); hash.update(':'); hash.update(sha(file)); }
const tag = hash.digest('hex').slice(0, 16);
const modulePath = path.join(root, 'public/js/i18n', `build-tag-${tag}.js`);
fs.writeFileSync(modulePath, `// Generated from overlay payload bytes.\nexport const OVERLAY_BUILD_TAG = '${tag}';\n`);
const entry = `${root}/public/js/i18n/i18n.js`;
let source = fs.readFileSync(entry, 'utf8');
source = source.replace(/^(const LANG_KEY\s*=)/m, `import { OVERLAY_BUILD_TAG } from './build-tag-${tag}.js';\n$1`);
source = source.replace("const base = '/i18n/ko/';", "const base = '/i18n/ko/';\n  const versioned = `?v=${OVERLAY_BUILD_TAG}`;");
source = source.replace("fetch(`${base}${f}.json`)", "fetch(`${base}${f}.json${versioned}`)");
fs.writeFileSync(entry, source);
console.log(JSON.stringify({ tag, module: modulePath }));
