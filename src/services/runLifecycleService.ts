import type { AcquisitionQualityPersistence } from '../types';
export type RunState = 'active'|'completed'|'failed'|'deletion_requested'|'deleted'|'expired';
export interface AuthoritativeRun { run_id:string; state:RunState; cleanup_status:null|'pending'|'in_progress'|'verified'|'retryable_failure'; absolute_deadline_at?:string; effective_expires_at?:string }
const states=new Set<RunState>(['active','completed','failed','deletion_requested','deleted','expired']);
const cleanups=new Set([null,'pending','in_progress','verified','retryable_failure']);
const errorCodes=new Set(['INVALID_REQUEST','RUN_NOT_FOUND','RUN_INACTIVE','INVALID_RUN_TRANSITION','DEPENDENCY_UNAVAILABLE','VERCEL_GOVERNED_DISPATCH_UNSUPPORTED']);
const definitiveCompletionErrors=new Set(['INVALID_REQUEST','RUN_NOT_FOUND','RUN_INACTIVE','INVALID_RUN_TRANSITION']);
const valid=(v:any):AuthoritativeRun=>{if(!v||typeof v.run_id!=='string'||!states.has(v.state)||!cleanups.has(v.cleanup_status))throw new Error('RUN_RESPONSE_INVALID');return v;};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(init:RequestInit,url='/api/run'){const response=await fetch(url,init);let body:any;try{body=await response.json();}catch{throw new Error('RUN_DEPENDENCY_UNAVAILABLE');}if(!response.ok)throw new Error(errorCodes.has(body?.error)?body.error:'RUN_DEPENDENCY_UNAVAILABLE');return valid(body);}
export const createRun=()=>request({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create'})});
export const getRun=(id:string)=>request({method:'GET'},`/api/run?run_id=${encodeURIComponent(id)}`);
const command=(id:string,action:'complete'|'fail',quality?:AcquisitionQualityPersistence)=>request({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,run_id:id,...(action==='fail'?{failure_code:'PIPELINE_FAILED'}:{}),...(quality?{quality}:{})})});
export async function completeRun(id:string,quality:AcquisitionQualityPersistence){let first:unknown;const delays=[250,500,1000,2000];for(let attempt=0;attempt<=delays.length;attempt++){try{const completed=await command(id,'complete',quality);if(completed.state==='completed'&&completed.cleanup_status==='verified')return completed;}catch(error){if(error instanceof Error&&definitiveCompletionErrors.has(error.message))throw error;first??=error;}const status=await getRun(id).catch(()=>null);if(status?.state==='completed'&&status.cleanup_status==='verified')return status;if(status?.state!=='active'&&status?.state!=='completed')break;if(attempt<delays.length)await sleep(delays[attempt]);}throw first instanceof Error?first:new Error('RUN_DEPENDENCY_UNAVAILABLE');}
export const failRun=(id:string)=>command(id,'fail');
export const deleteRun=(id:string)=>request({method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({run_id:id})});
