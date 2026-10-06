import pathlib,subprocess,datetime,urllib.request
urllib.request.urlopen('http://127.0.0.1:3011/healthz',timeout=3).read()
p=pathlib.Path('/etc/nginx/sites-available/game');a=pathlib.Path('/etc/nginx/sites-available/game-stronghold-auth.inc');s=p.read_text();auth=a.read_text()
old='proxy_pass http://game_portal/internal/authorize/stronghold;';assert s.count(old)==1
s=s.replace(old,'proxy_pass http://127.0.0.1:3011/authorize;')
marker='    location @game_portal_login {';assert s.count(marker)==1
s=s.replace(marker,'''    location = /stronghold-entry {
        include /etc/nginx/sites-available/game-proxy.inc;
        proxy_pass http://127.0.0.1:3011;
        client_max_body_size 4k;
    }

    location @stronghold_entry_login {
        return 302 /stronghold-entry?next=$request_uri;
    }

'''+marker)
assert auth.count('@game_portal_login')==1
stamp=datetime.datetime.now().strftime('%Y%m%d%H%M%S');backup=pathlib.Path('/home/happytanuki/Docker/stronghold-entry')/('nginx-before-'+stamp);backup.mkdir(mode=0o700)
(backup/'game').write_text(p.read_text());(backup/'game-stronghold-auth.inc').write_text(auth)
p.write_text(s);a.write_text(auth.replace('@game_portal_login','@stronghold_entry_login'))
try:
 subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True)
except:
 p.write_text((backup/'game').read_text());a.write_text(auth);subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True);raise
assert '127.0.0.1:3011/authorize' in p.read_text();print('Applied Stronghold-only gate; rollback='+str(backup))
