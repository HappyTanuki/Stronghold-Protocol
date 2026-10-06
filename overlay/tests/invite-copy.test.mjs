import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import cp from 'node:child_process';
import os from 'node:os';
const overlay=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=process.env.INVITE_TEST_APP;
if(!app)throw new Error('Set INVITE_TEST_APP to the clean-applied application');
const source=fs.readFileSync(path.join(app,'public/js/screens/room.js'),'utf8');
const body=source.match(/const copy = async \(what\) => \{([\s\S]*?)\n  \};/)[1];
async function copy(lang,what){let value;const fn=new Function('lang','tr','copyText','inviteLink','code','name','difficulty','DIFFICULTY_NAMES','toast',`return async what=>{${body}}`)(lang,s=>s==='终极模拟'?'초월 시뮬레이션':s,async s=>{value=s;return true},c=>`https://example.invalid/?invite=${c}`,'TESTCODE','인간99','test',{test:'终极模拟'},()=>{});await fn(what);return value;}
test('Korean clipboard preserves link and name with requested phrasing',async()=>assert.equal(await copy('ko','link'),'https://example.invalid/?invite=TESTCODE 인간99 박사님의 위수 협의: 맹약 초대 [초월 시뮬레이션]'));
test('Chinese preference preserves original invitation',async()=>assert.equal(await copy('zh','link'),'https://example.invalid/?invite=TESTCODE 인간99邀请你加入卫戍协议：盟约【终极模拟】'));
test('code-only clipboard remains unchanged',async()=>assert.equal(await copy('ko','code'),'TESTCODE'));
