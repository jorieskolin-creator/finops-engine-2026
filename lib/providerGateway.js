import { requireSession } from './auth.js';
import { getInfrastructure } from './infrastructure.js';
import { APPROVED_STAGE_PACKET_VERSION, approvedPacketHash, POLICY_VERSION, validateGovernedOutput } from './governance.js';
import { safeErrorCode,safeErrorStatus } from './safeErrors.js';

const allowed=new Set(['packet_id','packet_hash','schema_version','policy_version','run_id','stage','internal_pipeline_call','internal_call_id']);
const required=['packet_id','packet_hash','schema_version','policy_version','run_id','stage','internal_call_id'];
const write=(res,frame)=>{if(!res.writableEnded&&!res.destroyed)res.write(`${JSON.stringify(frame)}\n`);};
const publicStatus=s=>s==='succeeded'?'done':s==='queued'?'queued':['dispatch_intent','send_authorized'].includes(s)?'running':s;
export function providerHandler(provider,{repository,redis,setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}){return async(req,res)=>{
  if(req.method!=='POST')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  if(!requireSession(req))return res.status(401).json({error:'AUTHENTICATION_REQUIRED'});
  const b=req.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!allowed.has(k))||required.some(k=>typeof b[k]!=='string')||b.internal_pipeline_call!==true)return res.status(400).json({error:'INVALID_DISPATCH_PACKET'});
  if(b.schema_version!==APPROVED_STAGE_PACKET_VERSION||b.policy_version!==POLICY_VERSION)return res.status(400).json({error:'UNSUPPORTED_PACKET_VERSION'});
  try{if(!repository||!redis)({repository,redis}=getInfrastructure());const raw=await redis.getActivePacket(b.run_id,b.packet_id);if(!raw)return res.status(404).json({error:'PACKET_UNAVAILABLE'});let packet;try{packet=JSON.parse(raw);}catch{throw Object.assign(new Error(),{code:'DEPENDENCY_UNAVAILABLE'});}
    if(packet.packet_hash!==b.packet_hash||approvedPacketHash(packet)!==b.packet_hash)throw Object.assign(new Error(),{code:'PACKET_HASH_MISMATCH'});
    if(packet.run_id!==b.run_id||packet.stage!==b.stage||packet.provider!==provider)throw Object.assign(new Error(),{code:'PACKET_BINDING_MISMATCH'});
    const attempt=await repository.claimPacketAndReserve({packetId:b.packet_id,packetHash:b.packet_hash,runId:b.run_id,provider,model:packet.model,stage:b.stage,internalCallId:b.internal_call_id});if(!attempt)return res.status(404).json({error:'PACKET_UNAVAILABLE'});
    res.status(200);res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.flushHeaders?.();
    let timer,polling=false;const clear=()=>{if(timer){clearIntervalFn(timer);timer=undefined;}};const poll=async()=>{if(polling||res.writableEnded||res.destroyed)return;polling=true;try{const current=await repository.getAttemptByInternalCallId(b.internal_call_id);if(!current)return;const status=publicStatus(current.state);if(status==='done'){const value=await redis.getResult(current.run_id,current.attempt_id);if(value){const result=JSON.parse(value);validateGovernedOutput(result.output,{source_packet_id:current.packet_id,source_packet_hash:current.packet_hash,run_id:current.run_id,stage:current.stage,provider:current.provider,model:current.model});write(res,{type:'done',output:result.output,usage:result.usage});clear();return res.end();}}else if(!['queued','running'].includes(status)){write(res,{type:'error',message:String(status).toUpperCase()});clear();return res.end();}write(res,{type:'keepalive'});}finally{polling=false;}};
    res.once?.('close',clear);res.once?.('error',clear);await poll();if(!res.writableEnded&&!res.destroyed)timer=setIntervalFn(()=>poll().catch(()=>{clear();write(res,{type:'error',message:'DEPENDENCY_UNAVAILABLE'});res.end();}),2000);
  }catch(error){const code=safeErrorCode(error);if(res.headersSent){write(res,{type:'error',message:code});return res.end();}return res.status(safeErrorStatus(code)).json({error:code});}
};}
