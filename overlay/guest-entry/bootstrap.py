import subprocess,json,pathlib,secrets
root=pathlib.Path('/home/happytanuki/Docker/stronghold-entry');root.mkdir(mode=0o700,exist_ok=True);config=root/'config';config.mkdir(mode=0o700,exist_ok=True)
code="from authentik.core.models import User; from guardian.shortcuts import get_anonymous_user; import json; print('ALLOWLIST_JSON='+json.dumps(list(User.objects.filter(is_active=True,type__in=['internal','external']).exclude(pk=get_anonymous_user().pk).values_list('username',flat=True))))"
r=subprocess.run(['docker','exec','authentik-server','ak','shell','-c',code],capture_output=True,text=True,check=True)
lines=[s for s in r.stdout.splitlines() if s.startswith('ALLOWLIST_JSON=')];assert len(lines)==1
users=json.loads(lines[0].split('=',1)[1]);assert users and len(set(users))==len(users)
p=config/'users.json';assert not p.exists(),'refuse replacing existing allowlist';p.write_text(json.dumps(users,ensure_ascii=False));p.chmod(0o600)
p=config/'signing-key';assert not p.exists();p.write_bytes(secrets.token_bytes(48));p.chmod(0o600)
print(json.dumps({'exportedActiveHumanAccounts':len(users),'passwordsCopied':False}))
