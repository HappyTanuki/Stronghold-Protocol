import http.client,pathlib,json,time,re,urllib.parse
root=pathlib.Path('/home/happytanuki/Docker/stronghold-entry')
def req(path,method='GET',body=None,cookie=None):
 c=http.client.HTTPSConnection('game.happytanuki.kr',timeout=20);headers={'Origin':'https://game.happytanuki.kr'}
 if cookie:headers['Cookie']=cookie
 if body is not None:headers['Content-Type']='application/x-www-form-urlencoded'
 t=time.monotonic();c.request(method,path,body,headers);r=c.getresponse();b=r.read();h=dict(r.getheaders());cookies=[v for k,v in r.getheaders() if k.lower()=='set-cookie'];c.close();return r.status,h,b,cookies,round(time.monotonic()-t,3)
s,h,b,cs,t=req('/stronghold-entry');assert s==200
nonce=re.search(rb'name="csrf" value="([^"]+)"',b).group(1).decode();cookie=cs[0].split(';')[0]
assert req('/stronghold-entry','POST',urllib.parse.urlencode({'username':'__not_registered__','csrf':nonce}),cookie)[0]==403
user=json.loads((root/'config/users.json').read_text())[0]
s,h,b,cs,t=req('/stronghold-entry','POST',urllib.parse.urlencode({'username':user,'csrf':nonce}),cookie);assert s==303
session=next(x for x in cs if x.startswith('__Host-stronghold-entry=')).split(';')[0]
results=[]
for path in ['/stronghold_protocol/','/assets/local/map/autochess/TX_autochessi_D.png','/fonts/fonts.css','/data/voice-availability.json','/summergrowth/','/api/me']:
 s,h,b,_,t=req(path,cookie=session);results.append({'path':path,'status':s,'contentType':h.get('Content-Type'),'bytes':len(b),'seconds':t})
 if path in ['/stronghold_protocol/','/assets/local/map/autochess/TX_autochessi_D.png','/fonts/fonts.css','/data/voice-availability.json']:assert s==200,(path,s)
 if path=='/assets/local/map/autochess/TX_autochessi_D.png':assert b.startswith(b'\x89PNG\r\n\x1a\n')
 if path=='/summergrowth/':assert s in (302,401,403)
s,h,*_=req('/stronghold_protocol/');assert s==302 and urllib.parse.urlparse(h.get('Location','')).path=='/stronghold-entry'
print(json.dumps({'publicLoginVerified':True,'unknownIdDenied':True,'anonymousRedirectVerified':True,'results':results},ensure_ascii=False))
(root/'probe-session').unlink(missing_ok=True)
