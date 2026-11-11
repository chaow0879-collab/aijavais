const path=require('path'),R=process.argv[2],DL=require(path.join(R,'lib/deliverables.js')),fs=require('fs');
const inj='</a:t></a:r></a:p><p:pic r:embed="rId9"/><a:t>]]>&lt;"\' <!ENTITY x SYSTEM "file:///etc/passwd">';
const f=DL.createDeliverable('pptx',{title:'注入'+inj,text:'第1页：封面\n标题：'+inj+'\n第2页：'+inj+'\n- '+inj+'\n视觉建议：'+inj,goal:'5页'});
fs.writeFileSync(process.argv[3],f.buffer);
const t=Date.now();const S=require(path.join(R,'lib/slides.js'));
for(const n of [10000,20000,50000]){const s=Date.now();S.buildDeck({title:'t',text:'第1页'+' '.repeat(n)+'x\n第2页 a'});console.log('pagemark',n,Date.now()-s,'ms');}
