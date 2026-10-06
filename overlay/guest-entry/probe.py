import http.client,json,pathlib,re,urllib.parse,time
root=pathlib.Path('/home/happytanuki/Docker/stronghold-entry');user=json.loads((root/'config/users.json').read_text())[0]
def req(path,method='GET',body=None,headers=None,public=False):
 c=(http.client.HTTPSConnection('game.happytanuki.kr',timeout=15) if public else http.client.HTTPConnection('127.0.0.1',3011,timeout=15));c.request(method,path,body,headers or {});r=c.getresponse();data=r.read();h=r.getheaders();c.close();return r.status,h,data
s,h,b=req('/healthz');assert s==200
s,h,b=req('/stronghold-entry');assert s==200;csrf=re.search(rb'name="csrf" value="([^"]+)"',b).group(1).decode();cookie=next(v for k,v in h if k.lower()=='set-cookie').split(';')[0]
headers={'Origin':'https://game.happytanuki.kr','Cookie':cookie,'Content-Type':'application/x-www-form-urlencoded'}
s,_,_=req('/stronghold-entry','POST',urllib.parse.urlencode({'username':'__unregistered__','csrf':csrf}),headers);assert s==403
s,h,_=req('/stronghold-entry','POST',urllib.parse.urlencode({'username':user,'csrf':csrf}),headers);assert s==303
session=next(v for k,v in h if k.lower()=='set-cookie' and v.startswith('__Host-stronghold-entry=')).split(';')[0]
assert req('/authorize',headers={'Cookie':session})[0]==204
assert req('/authorize')[0]==401
(root/'probe-session').write_text(session);(root/'probe-session').chmod(0o600)
print(json.dumps({'ready':True,'unknownIdDenied':True,'existingIdAdmitted':True,'anonymousDenied':True,'cookiesPrinted':False}))
