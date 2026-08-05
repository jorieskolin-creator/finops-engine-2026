import { requireSession } from './auth.js';
import { claimApprovedPacket } from './governedPacketStore.js';
import { approvedPacketHash, authorizeDestination, GovernanceError, inspectOutput, POLICY_VERSION, APPROVED_STAGE_PACKET_VERSION } from './governance.js';
import { completeInternalModelResult, failInternalModelResult, registerInternalModelResult } from './internalModelResults.js';

const allowed=new Set(['packet_id','packet_hash','schema_version','policy_version','run_id','stage','internal_pipeline_call','internal_call_id']);
const required=['packet_id','packet_hash','schema_version','policy_version','run_id','stage','internal_call_id'];
const fail=(res,status,code)=>res.status(status).json({error:code});
const writeFrame=(res,frame)=>{ if(!res.writableEnded&&!res.destroyed) res.write(`${JSON.stringify(frame)}\n`); };
export function providerHandler(provider,{setIntervalFn=setInterval,clearIntervalFn=clearInterval,setTimeoutFn=setTimeout,clearTimeoutFn=clearTimeout}={}) { return async(req,res)=>{
  if(req.method!=='POST')return fail(res,405,'METHOD_NOT_ALLOWED');
  if(!requireSession(req))return fail(res,401,'AUTHENTICATION_REQUIRED');
  const body=req.body;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.has(k))||required.some(k=>typeof body[k]!=='string')||body.internal_pipeline_call!==true||!body.internal_call_id)return fail(res,400,'INVALID_DISPATCH_PACKET');
  if(body.schema_version!==APPROVED_STAGE_PACKET_VERSION||body.policy_version!==POLICY_VERSION)return fail(res,400,'UNSUPPORTED_PACKET_VERSION');
  const packet=claimApprovedPacket(body.packet_id); if(!packet)return fail(res,404,'PACKET_UNAVAILABLE');
  let metadata; let keepalive; let timeout; let reserved=false; const controller=new AbortController();
  const onAborted=()=>controller.abort(); req.once?.('aborted',onAborted);
  try {
    if(packet.packet_hash!==body.packet_hash||approvedPacketHash(packet)!==packet.packet_hash)throw new GovernanceError('PACKET_HASH_MISMATCH');
    if(packet.provider!==provider||packet.run_id!==body.run_id||packet.stage!==body.stage)throw new GovernanceError('PACKET_BINDING_MISMATCH',403);
    if(packet.schema_version!==APPROVED_STAGE_PACKET_VERSION||packet.policy_version!==POLICY_VERSION||packet.sanitization_status!=='passed'||packet.classification_method!=='deterministic_pattern_screen_v1'||packet.approval_basis!=='policy_approved_after_pattern_screening'||packet.residual_classification!=='PUBLIC_OR_APPROVED_FOR_EXTERNAL_PROCESSING'||packet.destination!==`${provider}:external_model`)throw new GovernanceError('PACKET_POLICY_INVALID',403);
    authorizeDestination(packet.stage,provider,packet.model,packet.settings);
    metadata={runId:packet.run_id,stage:packet.stage,provider,model:packet.model,packetId:packet.packet_id,packetHash:packet.packet_hash};
    try { registerInternalModelResult(body.internal_call_id,metadata); reserved=true; }
    catch (error) { if(error?.message==='INTERNAL_CALL_ID_COLLISION') throw new GovernanceError('INTERNAL_CALL_ID_COLLISION',409); throw error; }
    res.status(200); res.setHeader('Content-Type','application/x-ndjson; charset=utf-8'); res.setHeader('Cache-Control','no-cache, no-transform'); res.flushHeaders?.();
    keepalive=setIntervalFn(()=>writeFrame(res,{type:'keepalive'}),15000);
    timeout=setTimeoutFn(()=>controller.abort(),540000);
    let url,headers,upstreamBody;
    if(provider==='openai'){const key=process.env.GPT_API_KEY||process.env.OPENAI_API_KEY;if(!key)throw new GovernanceError('PROVIDER_NOT_CONFIGURED',500);url='https://api.openai.com/v1/responses';headers={'Content-Type':'application/json',Authorization:`Bearer ${key}`};upstreamBody={model:packet.model,input:[{role:'user',content:packet.parts.map(p=>({type:'input_text',text:p.text}))}],instructions:packet.system_instruction,max_output_tokens:packet.settings.max_tokens,...(packet.settings.reasoning_effort?{reasoning:{effort:packet.settings.reasoning_effort}}:{})};}
    else{const key=process.env.ANTHROPIC_API_KEY;if(!key)throw new GovernanceError('PROVIDER_NOT_CONFIGURED',500);url='https://api.anthropic.com/v1/messages';headers={'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'};upstreamBody={model:packet.model,max_tokens:packet.settings.max_tokens||4096,system:packet.system_instruction,messages:[{role:'user',content:packet.parts}],...(packet.settings.thinking_budget_tokens?{thinking:{type:'enabled',budget_tokens:packet.settings.thinking_budget_tokens}}:{})};}
    console.log(`[model_gateway] status=start provider=${provider} stage=${packet.stage} packet_id=${packet.packet_id} part_count=${packet.parts.length}`);
    const upstream=await fetch(url,{method:'POST',headers,body:JSON.stringify(upstreamBody),signal:controller.signal}); if(!upstream.ok)throw new GovernanceError('UPSTREAM_HTTP_ERROR',502);
    const payload=await upstream.json();
    if(provider==='openai'&&(payload.status==='incomplete'||payload.incomplete_details))throw new GovernanceError('INCOMPLETE_RESPONSE',502);
    if(provider==='anthropic'&&['max_tokens','model_context_window_exceeded'].includes(payload.stop_reason))throw new GovernanceError('INCOMPLETE_RESPONSE',502);
    const text=provider==='openai'?(payload.output_text||(payload.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||x.output_text||'').join('')):(payload.content||[]).map(x=>x.type==='text'?x.text:'').join('');
    const output=inspectOutput(text,packet); const usage=payload.usage||null;
    completeInternalModelResult(body.internal_call_id,output,usage,metadata);
    console.log(`[model_gateway] status=ok provider=${provider} stage=${packet.stage} packet_id=${packet.packet_id} output_id=${output.output_id} response_chars=${output.char_count}`);
    writeFrame(res,{type:'done',output,usage}); return res.end();
  }catch(e){const x=e instanceof GovernanceError?e:new GovernanceError(e?.name==='AbortError'?'UPSTREAM_TIMEOUT':'MODEL_REQUEST_FAILED',502);if(reserved)failInternalModelResult(body.internal_call_id,x.code,metadata);if(res.headersSent){writeFrame(res,{type:'error',message:x.code});return res.end();}return fail(res,x.status,x.code);}
  finally{if(keepalive)clearIntervalFn(keepalive);if(timeout)clearTimeoutFn(timeout);req.off?.('aborted',onAborted);}
};}
