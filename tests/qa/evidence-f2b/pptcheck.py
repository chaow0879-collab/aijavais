import zipfile,re,sys,glob,os,json
for f in sorted(glob.glob(sys.argv[1]+'/p*.pptx')):
    z=zipfile.ZipFile(f); names=z.namelist()
    slides=sorted([n for n in names if re.match(r'ppt/slides/slide\d+\.xml$',n)],key=lambda n:int(re.findall(r'\d+',n)[0]))
    texts=[]; fonts=set(); eafonts=set()
    for n in slides:
        x=z.read(n).decode('utf8')
        texts.append(' | '.join(re.findall(r'<a:t>([^<]*)</a:t>',x)))
        fonts|=set(re.findall(r'<a:latin typeface="([^"]+)"',x)); eafonts|=set(re.findall(r'<a:ea typeface="([^"]+)"',x))
    allt=' '.join(texts)
    th=''.join(z.read(n).decode('utf8') for n in names if 'theme' in n and n.endswith('.xml'))
    bad=re.findall(r'(#{1,6}\s|\*\*|^\s*-\s|视觉建议|设计建议|配图|备注|讲稿|---)',allt)
    notes=[n for n in names if 'notesSlide' in n and n.endswith('.xml')]
    print(os.path.basename(f),'slides=',len(slides),'fonts=',sorted(fonts),'ea=',sorted(eafonts),'markdown/提示语命中=',sorted(set(bad)),'notes=',len(notes))
    for i,t in enumerate(texts): print('   ',i+1,t[:150])
