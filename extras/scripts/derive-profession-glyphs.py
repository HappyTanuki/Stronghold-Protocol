"""Derive language-neutral white profession glyphs from verified nameplate PNGs.
Input and output directories must differ; original assets are never overwritten.
"""
import argparse,hashlib,json
from pathlib import Path
from PIL import Image
PROFESSIONS=('caster','medic','pioneer','sniper','special','support','tank','warrior')
def derive(source):
    image=Image.open(source).convert('RGBA')
    assert 175<=image.width<=205 and 75<=image.height<=95, 'unexpected nameplate dimensions'
    alpha=Image.new('L',image.size)
    alpha.putdata([min(r,g,b)*a//255 if min(r,g,b)>32 else 0 for r,g,b,a in image.getdata()])
    strong=alpha.point(lambda v:255 if v>100 else 0).getbbox()
    assert strong and strong[0]>image.width//2, 'white glyph is not isolated on the right'
    # Discard low-level compression/shadow noise, retaining the original white glyph edges.
    box=(max(0,strong[0]-2),max(0,strong[1]-2),min(image.width,strong[2]+2),min(image.height,strong[3]+2))
    glyph=alpha.crop(box)
    assert max(glyph.size)<=60
    result=Image.new('RGBA',(64,64),(255,255,255,0))
    white=Image.new('RGBA',glyph.size,'white');white.putalpha(glyph)
    result.paste(white,((64-glyph.width)//2,(64-glyph.height)//2))
    assert result.getbbox() and result.getpixel((0,0))[3]==0
    return result,box
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    assert a.source.resolve()!=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
    records=[]
    for name in PROFESSIONS:
        source=a.source/f'icon_{name}.png';im,box=derive(source);target=a.output/f'{name}.png';im.save(target)
        records.append({'profession':name,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'crop':box,'outputSha256':hashlib.sha256(target.read_bytes()).hexdigest()})
    (a.output/'provenance.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'count':len(records),'size':[64,64]}))
