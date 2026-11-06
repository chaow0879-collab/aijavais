'use strict';
const {execFileSync}=require('node:child_process');
const REPO='chaow0879-collab/aijavais';
// Fixed repository, GET only, no shell, no credential logging. CLI uses existing
// GitHub auth or optional GH_TOKEN supplied by the operator with read scopes.
function githubGet(route) {
  if(!new RegExp('^repos/'+REPO+'/[A-Za-z0-9_./?=&%-]+$').test(route)||route.includes('..'))throw Error('READ_ROUTE_REJECTED');
  try {
    const raw=execFileSync('gh',['api','--method','GET','--include',route],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
    const split=raw.search(/\r?\n\r?\n/);if(split<0)throw Error();
    const headers=raw.slice(0,split),status=Number(headers.match(/HTTP\/\S+\s+(\d+)/)?.[1]);
    if(status!==200)throw Error();
    return {data:JSON.parse(raw.slice(split).trim()),next:/rel="next"/.test(headers)};
  }catch{throw Error('GITHUB_UNKNOWN_403_429_TIMEOUT_OR_INVALID_RESPONSE');}
}
async function collect(get=githubGet,now=Date.now()) {
  let requests=0;const request=async route=>{if(++requests>200)throw Error('READ_BUDGET_EXHAUSTED');return get(route);};
  const snapshot={checked_at:now,complete:false,issues:{},refs:{},runs:[],pulls:[]};
  async function pages(route,key) {
    const items=[];
    for(let page=1;page<=20;page++){
      const r=await request(`repos/${REPO}/${route}${route.includes('?')?'&':'?'}per_page=100&page=${page}`);
      const data=key?r.data?.[key]:r.data;if(!Array.isArray(data))throw Error('PAGINATION_FIELDS_MISSING');items.push(...data);
      if(!r.next){if(key&&Number.isInteger(r.data.total_count)&&items.length<r.data.total_count)throw Error('PAGINATION_INCOMPLETE');return items;}
    }throw Error('PAGINATION_LIMIT');
  }
  try {
    for(const id of [10,17,15,4,2,16,12,18]){
      const r=await request(`repos/${REPO}/issues/${id}`);if(r.data?.number!==id||typeof r.data.body!=='string')throw Error('ISSUE_FIELDS_MISSING');
      const comments=await pages(`issues/${id}/comments`);
      if(comments.some(c=>!c.user?.login||typeof c.body!=='string'||!c.html_url||!c.created_at))throw Error('COMMENT_FIELDS_MISSING');
      snapshot.issues[id]={comments:comments.sort((a,b)=>a.created_at.localeCompare(b.created_at))};
    }
    for(const ref of await pages('git/matching-refs/heads/')){if(!ref.ref?.startsWith('refs/heads/')||!/^[a-f0-9]{40}$/.test(ref.object?.sha||''))throw Error('REF_FIELDS_MISSING');snapshot.refs[ref.ref.slice(11)]=ref.object.sha;}
    snapshot.pulls=await pages('pulls?state=all');
    for(const run of await pages('actions/runs','workflow_runs')){
      if(!Number.isSafeInteger(run.id)||!run.head_sha||!run.status)throw Error('RUN_FIELDS_MISSING');
      const jobs=await pages(`actions/runs/${run.id}/jobs`,'jobs');snapshot.runs.push({...run,jobs});
    }
    snapshot.complete=true;
  }catch{snapshot.error='UNKNOWN_SOURCE_OR_INCOMPLETE_PAGINATION';}
  return snapshot;
}
module.exports={collect,githubGet};
