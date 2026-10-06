import {test} from 'node:test';import assert from 'node:assert/strict';import {createGate} from './server.mjs';
test('allowlisted ID only; signed Stronghold cookie; CSRF and tampering denied',async()=>{
 const server=createGate({users:['existing-user'],key:Buffer.alloc(32,7),origin:'https://game.happytanuki.kr'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
 assert.equal((await fetch(base+'/authorize')).status,401);
 let r=await fetch(base+'/stronghold-entry');assert.equal(r.headers.get('referrer-policy'),'same-origin');const html=await r.text();const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];const cookie=r.headers.getSetCookie()[0].split(';')[0];
 const submit=(username,origin='https://game.happytanuki.kr')=>fetch(base+'/stronghold-entry',{method:'POST',redirect:'manual',headers:{Origin:origin,Cookie:cookie},body:new URLSearchParams({username,csrf,next:'https://evil.invalid/'})});
 assert.equal((await submit('unknown')).status,403);assert.equal((await submit('existing-user','https://evil.invalid')).status,403);
 r=await submit('existing-user');assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/stronghold_protocol/');const session=r.headers.getSetCookie()[0].split(';')[0];
 assert.equal((await fetch(base+'/authorize',{headers:{Cookie:session}})).status,204);
 assert.equal((await fetch(base+'/authorize',{headers:{Cookie:session+'x'}})).status,401);
 assert.equal((await fetch(base+'/admin',{headers:{Cookie:session}})).status,404);
 }finally{await new Promise(r=>server.close(r))}
});
