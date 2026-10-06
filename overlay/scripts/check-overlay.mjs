import fs from 'node:fs';import cp from 'node:child_process';
const u=process.argv[2]||'/home/happytanuki/stronghold-upstream-clean';const p=process.argv[3]||'/home/happytanuki/stronghold-ko-overlay/patches/ko-ui.patch';
cp.execFileSync('git',['-C',u,'apply','--check',p]);console.log('patch applies cleanly');
