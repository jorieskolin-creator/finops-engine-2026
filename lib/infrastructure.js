import pg from 'pg';
import { createClient } from 'redis';
import { ControlPlaneRepository } from './controlPlaneRepository.js';
import { RedisExecutionPlane } from './redisExecutionPlane.js';
let infrastructure;
export async function initializeInfrastructure(env=process.env,{pool,redisClient}={}) {
  if(infrastructure)return infrastructure;
  if(!pool&&!env.DATABASE_URL)throw new Error('DATABASE_URL_REQUIRED');
  if(!redisClient&&!env.REDIS_URL)throw new Error('REDIS_URL_REQUIRED');
  const db=pool||new pg.Pool({connectionString:env.DATABASE_URL,max:10,connectionTimeoutMillis:5000});
  const rc=redisClient||createClient({url:env.REDIS_URL,socket:{connectTimeout:5000,reconnectStrategy:retries=>Math.min(retries*100,3000)}});
  rc.on?.('error',()=>{}); if(!redisClient)await rc.connect();
  const repository=new ControlPlaneRepository(db); const redis=new RedisExecutionPlane(rc);
  try { await repository.ready(); if(!await redis.ready())throw new Error('REDIS_UNAVAILABLE'); }
  catch { await Promise.allSettled([repository.close(),redis.close()]); throw new Error('INFRASTRUCTURE_UNAVAILABLE'); }
  infrastructure={repository,redis,async ready(){await repository.ready();return redis.ready();},async close(){await Promise.allSettled([redis.close(),repository.close()]);infrastructure=undefined;}};
  return infrastructure;
}
export function getInfrastructure(){if(!infrastructure)throw new Error('INFRASTRUCTURE_NOT_INITIALIZED');return infrastructure;}
