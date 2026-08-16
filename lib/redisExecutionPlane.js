const PREFIX='finops:v1';
const childScript=`
if redis.call('EXISTS',KEYS[1])==1 then return 0 end
if redis.call('EXISTS',KEYS[2])==1 then return 2 end
redis.call('SET',KEYS[2],ARGV[1],'PX',ARGV[2]); redis.call('SADD',KEYS[3],KEYS[2]); redis.call('PEXPIRE',KEYS[3],ARGV[3]); return 1`;
// PostgreSQL has already fenced this claim. A stale Redis lease may therefore
// be replaced, but a send marker makes the outcome ambiguous and must win.
const leaseScript=`
if redis.call('EXISTS',KEYS[1])==1 then return 0 end
if redis.call('EXISTS',KEYS[2])==1 then return 3 end
redis.call('SET',KEYS[3],ARGV[1],'PX',ARGV[2]); redis.call('SADD',KEYS[4],KEYS[3]); redis.call('PEXPIRE',KEYS[4],ARGV[3]); return 1`;
const tombstoneScript=`
redis.call('SET',KEYS[1],'1','PX',ARGV[1]); local children=redis.call('SMEMBERS',KEYS[2]); local n=0
for _,key in ipairs(children) do n=n+redis.call('DEL',key) end
redis.call('DEL',KEYS[2]); return n`;
const authorizeScript=`
if redis.call('EXISTS',KEYS[1])==1 then return 0 end
local lease=redis.call('GET',KEYS[2]); if lease~=ARGV[1] then return 0 end
local marker=redis.call('GET',KEYS[3]); if marker then return marker==ARGV[1] and 2 or 3 end
redis.call('SET',KEYS[3],ARGV[1],'PX',ARGV[2]); redis.call('SADD',KEYS[4],KEYS[3]); redis.call('PEXPIRE',KEYS[4],ARGV[3]); return 1`;
export class RedisExecutionPlane {
  constructor(client) { if(!client?.ping)throw new Error('REDIS_ADAPTER_REQUIRED'); this.client=client; }
  key(runId,type,id='') { return `${PREFIX}:run:${runId}:${type}${id?`:${id}`:''}`; }
  ttl(deadline,requested) { return Math.max(1,Math.min(requested,new Date(deadline).getTime()-Date.now())); }
  async ready(){ return (await this.client.ping())==='PONG'; }
  async getResult(runId,attemptId){ return this.client.get(this.key(runId,'result',attemptId)); }
  async createChild({runId,type,id,value,deadline,ttlMs}) { return this.client.eval(childScript,{keys:[this.key(runId,'tombstone'),this.key(runId,type,id),this.key(runId,'keys')],arguments:[value,String(this.ttl(deadline,ttlMs)),String(this.ttl(deadline,Number.MAX_SAFE_INTEGER))]}); }
  async setResult(args){ return this.createChild({...args,type:'result'}); }
  async setCheckpoint(args){return this.createChild({...args,type:'checkpoint'});}
  async getCheckpoint(runId,checkpointId){return this.client.get(this.key(runId,'checkpoint',checkpointId));}
  async removeCheckpoint(runId,checkpointId){const key=this.key(runId,'checkpoint',checkpointId);await this.client.sRem?.(this.key(runId,'keys'),key);return this.client.del(key);}
  async notifyAttempt(attemptId){ return this.client.xAdd(`${PREFIX}:attempts`,'*',{attempt_id:attemptId}); }
  async readAttempts(lastId='$',blockMs=1000){return this.client.xRead([{key:`${PREFIX}:attempts`,id:lastId}],{BLOCK:blockMs,COUNT:20});}
  async trimAttempts(beforeMs){return this.client.sendCommand(['XTRIM',`${PREFIX}:attempts`,'MINID','~',`${beforeMs}-0`]);}
  async setLease(runId,attemptId,token,deadline,ttlMs){return this.client.eval(leaseScript,{keys:[this.key(runId,'tombstone'),this.key(runId,'send-authorized',attemptId),this.key(runId,'lease',attemptId),this.key(runId,'keys')],arguments:[String(token),String(this.ttl(deadline,ttlMs)),String(this.ttl(deadline,Number.MAX_SAFE_INTEGER))]});}
  async renewLease(runId,attemptId,token,ttlMs){const key=this.key(runId,'lease',attemptId);return Number(await this.client.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end`,{keys:[key],arguments:[String(token),String(ttlMs)]}))===1;}
  async getSendMarker(runId,attemptId){return this.client.get(this.key(runId,'send-authorized',attemptId));}
  async authorizeSend({runId,attemptId,token,deadline,ttlMs}){return this.client.eval(authorizeScript,{keys:[this.key(runId,'tombstone'),this.key(runId,'lease',attemptId),this.key(runId,'send-authorized',attemptId),this.key(runId,'keys')],arguments:[String(token),String(this.ttl(deadline,ttlMs)),String(this.ttl(deadline,Number.MAX_SAFE_INTEGER))]});}
  async tombstone(runId,_deadline){ const ttl=24*60*60_000; return Number(await this.client.eval(tombstoneScript,{keys:[this.key(runId,'tombstone'),this.key(runId,'keys')],arguments:[String(ttl)]})); }
  async close(){ await this.client.quit?.(); }
}
