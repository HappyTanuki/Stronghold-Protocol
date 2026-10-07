import json,subprocess,urllib.request
from pathlib import Path
RELEASE=Path('/home/happytanuki/Docker/stronghold/releases/c2a2ef7-native-kr-extras')
def health(port):return json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz',timeout=5))
old=health(3006);new=health(3007)
assert old['matches']==0 and old['humans']==0 and old['sockets']==0,'Active clients: cutover deferred'
assert new['ok'] and new['app']=='0.2.1' and new['matches']==0 and new['humans']==0
config=Path('/etc/nginx/sites-available/game');before=config.read_text()
assert before.count('server 127.0.0.1:3006;')==1
assert 'location ^~ /packs/' not in before
pack='''    location ^~ /packs/ {
        include /etc/nginx/sites-available/game-stronghold-auth.inc;
        include /etc/nginx/sites-available/game-proxy.inc;
        proxy_pass http://game_stronghold_active;
    }
'''
assert before.count('    location ^~ /i18n/ {')==1
updated=before.replace('server 127.0.0.1:3006;','server 127.0.0.1:3007;').replace('    location ^~ /i18n/ {',pack+'    location ^~ /i18n/ {')
backup=RELEASE/'evidence/nginx-before-native.conf';assert not backup.exists();backup.write_text(before);backup.chmod(0o600)
try:
    config.write_text(updated)
    subprocess.run(['nginx','-t'],check=True)
    subprocess.run(['systemctl','reload','nginx'],check=True)
    assert config.read_text()==updated
    assert health(3007)['ok'] and health(3006)['ok']
except Exception:
    config.write_text(before);subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True);raise
subprocess.run(['docker','update','--restart','unless-stopped','stronghold-native-c2a2ef7'],check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'activated':True,'port':3007,'app':new['app'],'oldRetained':True,'nativePackRouteAdded':True}))
