import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
const [root, extras, artifacts] = process.argv.slice(2).map(p => path.resolve(p));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const lock = JSON.parse(fs.readFileSync(path.join(extras,'lock.json')));
for (const [rel,sha] of Object.entries(lock.preimages)) {
  if (hash(path.join(root,rel)) !== sha) throw Error(`Unsupported source: ${rel}`);
}
const patch = path.join(extras,'patches/extras.patch');
if (hash(patch) !== lock.patchSha256) throw Error('Patch drift');
const targets = [...fs.readFileSync(patch,'utf8').matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(m=>m[1]).sort();
if (JSON.stringify(targets) !== JSON.stringify(lock.modified.slice().sort())) throw Error('Unapproved patch targets');
cp.execFileSync('git',['-C',root,'apply','--check',patch]);
cp.execFileSync('git',['-C',root,'apply',patch]);
for (const [rel,sha] of Object.entries(lock.postimages)) {
  if (hash(path.join(root,rel)) !== sha) throw Error(`Applied source mismatch: ${rel}`);
}
for (const name of ['assets.json','local-assets.json','voice-availability.json']) {
  const src=path.join(artifacts,name);
  if(hash(src)!==lock.artifacts[name]) throw Error(`Artifact drift: ${name}`);
  fs.copyFileSync(src,path.join(root,'data',name));
}
const voice=JSON.parse(fs.readFileSync(path.join(root,'data/voice-availability.json')));
if(voice.schemaVersion!==1 || voice.policy.cnFallback!==false || voice.policy.krFallback!=='ja' || voice.policy.jaFallback!==null) throw Error('Voice policy drift');
const fonts=path.join(artifacts,'fonts');
fs.mkdirSync(path.join(root,'public/fonts'),{recursive:true});
for(const file of fs.readdirSync(fonts)) fs.copyFileSync(path.join(fonts,file),path.join(root,'public/fonts',file));
console.log(JSON.stringify({upstream:lock.upstream,modified:targets,voiceCharacters:Object.keys(voice.characters).length}));
