import base64,json,sys,os
src=open('src/golf.html').read()
d=json.load(open('baked.json'))
def r(a): return [[round(v,4) for v in p] for p in a]
d['joints']={k:r(v) for k,v in d['joints'].items()}; d['club']=r(d['club'])
src=src.replace('__TRACK__',json.dumps(d,separators=(',',':')))
src=src.replace('__GLB__',base64.b64encode(open('pack/claude-golf-3d-pack/model.glb','rb').read()).decode())
src=src.replace('__PLATE__',base64.b64encode(open('plate.mp4','rb').read()).decode())
os.makedirs('out',exist_ok=True)
open('out/golf.html','w').write(src)
i=src.index('</style>')+len('</style>')
head,body=src[:i],src[i:]
open('out/index.html','w').write('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'+head+'\n</head>\n<body>\n'+body+'\n</body>\n</html>\n')
print(len(src)/1e6,'MB')
