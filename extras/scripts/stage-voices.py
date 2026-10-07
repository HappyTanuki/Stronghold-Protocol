"""Stage JA/KR audio from ArknightsAssets2; never change installed clients or live assets."""
import argparse,concurrent.futures,hashlib,json,urllib.request
from pathlib import Path
SOURCE='https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/'
def stage(app,assets):
    manifest=json.loads((app/'data/assets.json').read_text())
    jobs={};characters={}
    for char,slots in manifest['audio']['voice'].items():
        characters[char]={}
        for slot,value in slots.items():
            lines=value if isinstance(value,list) else [value]
            entries=[]
            for index,url in enumerate(lines):
                cue=url.rsplit('/',1)[-1]
                assert cue.endswith('.mp3') and '/' not in char and '..' not in char
                line={'index':index,'cue':cue}
                for language,folder in [('ja','jp'),('kr','kr')]:
                    rel=f'audio/voice/{folder}/{char}/{cue}'
                    line[language]={'available':False,'assetPath':rel,'url':'/assets/'+rel,'language':language}
                    source_folder='voice' if language=='ja' else 'voice_kr'
                    jobs[rel]=f'{SOURCE}{source_folder}/{char}/{cue}'
                entries.append(line)
            characters[char][slot]=entries
    def fetch(item):
        rel,url=item;target=assets/rel;existing=target.is_file() and target.stat().st_size>0
        if not existing:
            try:
                data=urllib.request.urlopen(url,timeout=40).read()
                assert len(data)>128 and not data.startswith((b'<!',b'<html'))
                target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
            except Exception as e:
                return rel,{'available':False,'source':url,'error':str(e)}
        data=target.read_bytes()
        return rel,{'available':True,'source':url,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'reused':existing}
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool: ledger=dict(pool.map(fetch,jobs.items()))
    for slots in characters.values():
        for lines in slots.values():
            for line in lines:
                for lang in ['ja','kr']:line[lang]['available']=ledger[line[lang]['assetPath']]['available']
    availability={'schemaVersion':1,'policy':{'selectedLanguages':['ja','kr'],'krFallback':'ja','jaFallback':None,'cnFallback':False},'provenance':{'audioSource':'ArknightsAssets2 external dump, not local extraction'},'characters':characters}
    (app/'data/voice-availability.json').write_text(json.dumps(availability,indent=2)+'\n')
    (app.parent/'evidence/voice-ledger.json').write_text(json.dumps(ledger,indent=2)+'\n')
    summary={'characters':len(characters),'payloads':len(ledger),'available':sum(x['available'] for x in ledger.values()),'missing':[k for k,v in ledger.items() if not v['available']]}
    print(json.dumps({**summary,'missing':len(summary['missing'])}));return summary
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--app',type=Path,required=True);p.add_argument('--assets',type=Path,required=True);a=p.parse_args();stage(a.app,a.assets)
