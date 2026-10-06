import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
export function createGate({users,key,origin}) {
 const allowed=new Set(users);
 if(!allowed.size || key.length<32)throw new Error('Empty allowlist or weak signing key');
 const sign=s=>crypto.createHmac('sha256',key).update(s).digest('base64url');
 const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
 const token=(value,ttl)=>{const p=Buffer.from(JSON.stringify({value,exp:Date.now()+ttl})).toString('base64url');return p+'.'+sign(p)};
 const decode=t=>{try{const [p,s,...rest]=(t||'').split('.');if(rest.length||!equal(sign(p),s))return null;const v=JSON.parse(Buffer.from(p,'base64url'));return v.exp>Date.now()?v.value:null}catch{return null}};
 const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>{const i=s.indexOf('=');return i<0?['','']:[s.slice(0,i).trim(),s.slice(i+1)]}));
 const cookie=(name,value,age)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
 const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const next=s=>{try{const u=new URL(s,origin);return u.origin===origin && u.pathname.startsWith('/stronghold_protocol/')?u.pathname+u.search+u.hash:'/stronghold_protocol/'}catch{return '/stronghold_protocol/'}};
 const attempts=new Map();
 return http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  const url=new URL(req.url,'http://local');const c=cookies(req);
  if(req.method==='GET'&&url.pathname==='/healthz'){res.writeHead(200);return res.end('ok')}
  if(req.method==='GET'&&url.pathname==='/authorize'){res.writeHead(allowed.has(decode(c['__Host-stronghold-entry']))?204:401);return res.end()}
  if(req.method==='GET'&&url.pathname==='/stronghold-entry'){
   const nonce=token(crypto.randomBytes(24).toString('hex'),600000);
   res.setHeader('Set-Cookie',cookie('__Host-stronghold-form',nonce,600));res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");res.setHeader('Content-Type','text/html; charset=utf-8');
   return res.end(`<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stronghold 입장</title><style>body{font-family:sans-serif;background:#111916;color:#eef5ef;max-width:420px;margin:12vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:14px;margin:10px 0;font-size:18px}small{color:#bac7bf}</style><h1>Stronghold 입장</h1><p>기존에 등록된 아이디를 입력하세요.</p><form method="post" action="/stronghold-entry"><input name="username" aria-label="아이디" autocomplete="username" required maxlength="150"><input type="hidden" name="csrf" value="${nonce}"><input type="hidden" name="next" value="${escape(next(url.searchParams.get('next')))}"><button>입장</button></form><small>비밀번호 없이 아이디 목록만 확인합니다. 본인 인증이 아니며 다른 서비스 권한은 부여되지 않습니다.</small></html>`)
  }
  if(req.method==='POST'&&url.pathname==='/stronghold-entry'){
   if(req.headers.origin!==origin){res.writeHead(403);return res.end('Origin rejected')}
   const ip=req.headers['x-real-ip']||req.socket.remoteAddress;const now=Date.now();for(const [k,v]of attempts)if(v.until<now)attempts.delete(k);
   const a=attempts.get(ip)||{n:0,until:now+60000};if(++a.n>20||attempts.size>10000){res.writeHead(429);return res.end('잠시 후 다시 시도하세요')}attempts.set(ip,a);
   let body='';try{for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096){res.writeHead(413);res.end();return}}}catch{res.writeHead(400);return res.end()}
   const form=new URLSearchParams(body);
   if(!equal(form.get('csrf'),c['__Host-stronghold-form'])||!decode(form.get('csrf'))){res.writeHead(403);return res.end('입장 페이지를 새로 열어 주세요')}
   const username=form.get('username');if(!allowed.has(username)){res.writeHead(403);return res.end('등록된 아이디가 아닙니다.')}
   res.setHeader('Set-Cookie',[cookie('__Host-stronghold-entry',token(username,43200000),43200),cookie('__Host-stronghold-form','',0)]);res.writeHead(303,{Location:next(form.get('next'))});return res.end();
  }
  res.writeHead(404);res.end();
 });
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const users=JSON.parse(fs.readFileSync('/run/config/users.json','utf8'));const key=fs.readFileSync('/run/config/signing-key');
 createGate({users,key,origin:'https://game.happytanuki.kr'}).listen(3011,'0.0.0.0');
}
