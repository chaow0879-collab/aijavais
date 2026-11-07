'use strict';
// Independent inputs/assertions for the real R43 project/run/delivery HTTP APIs.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const H=require('./harness.cjs');
const software={sections:[{heading:'QA43_SENTINEL',text:'合成时长转换模块，非真实AI专业交付'}],files:[
 {path:'README.md',content:'# 合成时长转换\n入口src/clock.js；测试node test/clock.test.js。无需依赖。'},
 {path:'package.json',content:'{"name":"qa43-clock","private":true,"main":"src/clock.js"}'},
 {path:'src/clock.js',content:"module.exports=h=>h*60; if(require.main===module)console.log(module.exports(24));"},
 {path:'test/clock.test.js',content:"const assert=require('node:assert/strict');assert.equal(require('../src/clock')(24),1440);console.log('QA43_CLOCK_OK');"}],
 software:{entry:'src/clock.js',test:'test/clock.test.js',run:'node src/clock.js',testCommand:'node test/clock.test.js',install:'无需第三方依赖',expectOutput:'QA43_CLOCK_OK'}};
const org={sections:[{heading:'QA43_SENTINEL',text:'合成图，仅做结构验收'}],orgChart:{title:'QA43合成组织图',nodes:[
 {id:'root',name:'负责人',duties:['最终裁决'],boundary:'不替用户验收'},
 {id:'a',parentId:'root',name:'生产组',duties:['生产'],boundary:'无质量放行权'},
 {id:'b',parentId:'root',name:'<img src=x onerror="window.__qa43=1">质量组',duties:['质量放行'],boundary:'独立质量审核'}]},rows:[['岗位','职责'],['质量组','质量放行']],slides:[{title:'QA43组织说明',bullets:['质量放行独立']} ]};
const research={sections:[{heading:'QA43_SENTINEL',text:'合成社区数字服务研究'}],claims:[
 {id:'q1',text:'合成样本为12人',evidenceIds:['e1']},{id:'q2',text:'模型声称某法规已核实',evidenceIds:['e2']},{id:'q3',text:'无来源的效果主张',evidenceIds:[]}],
 evidence:[{id:'e1',kind:'synthetic',citation:'QA43合成样本，非调查'},{id:'e2',kind:'source',citation:'模型提出，未核验',url:'https://example.invalid/qa43',verification:'verified'}]};
const cyclic=JSON.parse(JSON.stringify(org));cyclic.orgChart.nodes[0].parentId='a';
const fixtures={software,placeholder:{files:[{path:'README.md',content:'MOCK PLACEHOLDER'},{path:'main.js',content:'// MOCK PLACEHOLDER'}],software:{entry:'main.js',test:'main.js',run:'node main.js'}},org,research,cyclic,unsafe:{...software,files:[...software.files,{path:'../../QA43_ESCAPE.js',content:'throw Error("must not execute")'}]}};
(async()=>{
 const provider={calls:[],probes:0,peak:0};let browser,svgServer;
 provider.server=http.createServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const payload=JSON.parse(raw),prompt=payload.messages.map(m=>m.content).join('\n'),key=/\[\[QA43:(\w+)\]\]/.exec(prompt)?.[1];
  if(key)provider.calls.push({key,at:Date.now(),promptSha256:H.hash(prompt),handoffSeen:prompt.includes('QA43_SENTINEL')});else provider.probes++;
  res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:key?JSON.stringify(fixtures[key]):'QA43 probe'}}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:30,completion_tokens:40}})+'\n\ndata: [DONE]\n\n');});});
 await new Promise(r=>provider.server.listen(0,'127.0.0.1',r));provider.port=provider.server.address().port;
 // R47 differential delivery does not enable code execution.
const app=new H.App(provider,'delivery');const outcomes=[];const manifests={};
 try{
  await app.start();const added=await app.call('POST','/api/models',{providerId:'ollama',modelId:'QA43-DELIVERY-LOCAL',displayName:'QA43独立合成模型',pricingMode:'local',baseUrl:'http://127.0.0.1:'+provider.port+'/v1',capabilities:['writing','reasoning']});
  app.mid=added.json.connection.connectionId;assert.equal((await app.call('POST','/api/models/'+app.mid+'/test',{})).json.ok,true);
  async function project(key){const create=await app.call('POST','/api/v2/projects',{name:'QA43-'+key,description:'独立合成输入，非专业成果',roles:[{roleId:'maker',name:'制作',connectionId:app.mid},{roleId:'review',name:'复核',connectionId:app.mid}],steps:[{stepId:'make',roleId:'maker',title:'初稿',prompt:'[[QA43:'+key+']] 输出合成JSON',handoff:'previous'},{stepId:'review',roleId:'review',title:'独立复核',prompt:'[[QA43:'+key+']] 核对前序结果后输出JSON',handoff:'all'}]});assert.equal(create.status,201,create.text);
   const start=await app.call('POST','/api/v2/projects/'+create.json.project.projectId+'/runs',{maxTokens:64000,maxOutputTokens:4000,maxCost:0});assert.equal(start.status,202,start.text);
   const rid=start.json.run.runId;await H.until(async()=>{const r=await app.call('GET','/api/v2/runs/'+rid);if(r.json.run.status==='review_required')return true;if(['failed','cancelled'].includes(r.json.run.status))throw Error(JSON.stringify(r.json.run.error));return false;},'review_required');
   assert.equal(provider.calls.filter(c=>c.key===key).length,2);assert.equal(provider.calls.filter(c=>c.key===key)[1].handoffSeen,key==='placeholder'?false:true);
   return rid;
  }
  async function bytes(rid,format){const r=await fetch(app.origin+'/api/v2/runs/'+rid+'/export',{method:'POST',headers:{cookie:app.cookie,origin:app.origin,'content-type':'application/json'},body:JSON.stringify({format})});const b=Buffer.from(await r.arrayBuffer());assert.equal(r.status,200,b.toString().slice(0,200));H.write('files/'+rid+'.'+format,b);return b;}
  for(const key of ['org']){
   try{
    const rid=await project(key),route='/api/v2/runs/'+rid+'/delivery-check';
    assert.equal((await app.call('POST',route,{},false)).status,401);
    const before=H.sqlSnapshot(app.dir),normal=await app.call('POST',route,{});assert.equal(normal.status,200,normal.text);const m=normal.json.manifest;manifests[key]={rid,normal:m};
    if(key==='software'){
     assert.equal(m.items[0].status.usable,'not_run');const smoke=await app.call('POST',route,{smokeTest:true});manifests[key].smoke=smoke.json.manifest;
     const item=smoke.json.manifest.items[0];assert.ok(['runnable_verified','not_run'].includes(item.status.usable));assert.equal(item.status.expertReview,'not_run');if(item.status.usable==='runnable_verified'){assert.equal(item.smoke.isolated,true);assert.match(item.smoke.stdout,/QA43_CLOCK_OK/);}
     outcomes.push({case:'software-controlled-smoke',status:item.status.usable==='runnable_verified'?'PASS':'BLOCKED',actual:item.status,reason:item.smoke});
     await bytes(rid,'zip');await bytes(rid,'docx');
    }else if(key==='placeholder'){assert.equal(m.items[0].status.usable,'mock_placeholder');const sm=await app.call('POST',route,{smokeTest:true});assert.equal(sm.json.manifest.items[0].smoke.ran,false);
    }else if(key==='org'){
     assert.equal(m.items[0].status.usable,'graph_validated');assert.equal(m.generatedArtifacts.length,1);const meta=m.generatedArtifacts[0],r=await fetch(app.origin+meta.downloadUrl,{headers:{cookie:app.cookie}}),b=Buffer.from(await r.arrayBuffer());assert.equal(H.hash(b),meta.sha256);assert.doesNotMatch(b.toString(),/<script|<img|onerror=/);H.write('files/chart.svg',b);
     const {chromium}=require('playwright');browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
     svgServer=http.createServer((q,s)=>{s.setHeader('content-type','image/svg+xml');s.end(b);});await new Promise(resolve=>svgServer.listen(0,'127.0.0.1',resolve));const page=await browser.newPage();await page.goto('http://127.0.0.1:'+svgServer.address().port);assert.equal(await page.evaluate(()=>window.__qa43),undefined);assert.equal(await page.locator('img,script').count(),0);assert.equal(await page.locator('svg g').count(),3);await page.screenshot({path:H.write('files/chart-browser.png',Buffer.alloc(0))});await browser.close();browser=null;await new Promise(resolve=>svgServer.close(resolve));svgServer=null;
     for(const f of ['docx','xlsx','pptx'])await bytes(rid,f);
    }else if(key==='research'){assert.equal(m.items[0].status.usable,'evidence_gaps');assert.equal(m.items[0].summary.verified,0);assert.deepEqual(m.items[0].claims.map(c=>c.state),['synthetic_only','unverified','unsupported']);for(const f of ['docx','xlsx'])await bytes(rid,f);
    }else if(key==='cyclic'){assert.equal(m.items[0].status.usable,'failed');assert.equal(m.generatedArtifacts.length,0);
    }else if(key==='unsafe'){assert.equal(m.items[0].status.structure,'invalid');assert.ok(m.items[0].rejected.length);}
    const after=H.sqlSnapshot(app.dir);assert.deepEqual(after.usage,before.usage,'delivery check must not charge a model');
    assert.equal((await app.call('GET','/api/v2/runs/'+rid)).json.run.status,'review_required','checker cannot approve on behalf of user');
    await app.call('POST','/api/v2/runs/'+rid+'/review',{decision:'approve',feedback:'仅批准合成流程检查，不代表专业质量'});
    outcomes.push({case:key,status:'PASS',runId:rid});
   }catch(e){outcomes.push({case:key,status:'FAIL',error:e.message});}
  }
  H.write('delivery-manifests.json',manifests);app.save({outcomes});
  const py=spawnSync('python3',['-c',`import sys,pathlib,json,zipfile,docx,openpyxl,pptx,xml.etree.ElementTree as ET
p=pathlib.Path(sys.argv[1]);r=[]
for f in p.iterdir():
 if f.suffix in ['.zip','.docx','.xlsx','.pptx']:
  with zipfile.ZipFile(f) as z: assert z.testzip() is None
 if f.suffix=='.zip':
  with zipfile.ZipFile(f) as z: assert 'src/clock.js' in z.namelist() and 'test/clock.test.js' in z.namelist()
 elif f.suffix=='.docx': assert 'QA43_SENTINEL' in ' '.join(p.text for p in docx.Document(f).paragraphs)
 elif f.suffix=='.xlsx': assert any('质量组' in str(v) for ws in openpyxl.load_workbook(f) for row in ws.values for v in row)
 elif f.suffix=='.pptx': assert any('QA43组织说明' in sh.text for slide in pptx.Presentation(f).slides for sh in slide.shapes if sh.has_text_frame)
 elif f.suffix=='.svg': assert ET.parse(f).getroot().tag.endswith('svg')
 else: continue
 r.append({'file':f.name,'parser':'PARSED'})
assert len(r)==4
print(json.dumps(r))`,path.join(H.OUT,'files')],{encoding:'utf8'});
  assert.equal(py.status,0,py.stderr);H.write('independent-parsers.json',JSON.parse(py.stdout));outcomes.push({case:'independent-file-parsing',status:'PASS',files:JSON.parse(py.stdout).length});
 }finally{if(browser)await browser.close();if(svgServer)await new Promise(r=>svgServer.close(r));await app.cleanup({outcomes,manifests});provider.server.closeAllConnections();await new Promise(r=>provider.server.close(r));H.write('delivery-results.json',{businessSha:H.BUSINESS_SHA,outcomes});H.manifest();}
 console.log(JSON.stringify(outcomes));if(outcomes.some(x=>x.status==='FAIL'))process.exitCode=1;
})().catch(e=>{console.error(e);H.manifest();process.exitCode=1});
