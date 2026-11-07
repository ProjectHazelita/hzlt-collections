import Fastify from 'fastify';
import { sql, type Config, type createDatabase, type createQueue } from '@hcl/server';
export async function buildApp({db,boss,storage,config,serveWeb=false}:{db:ReturnType<typeof createDatabase>['db'];boss:Awaited<ReturnType<typeof createQueue>>;storage:{root:string};config:Config;serveWeb?:boolean}){
 const app=Fastify({logger:{redact:['req.headers.cookie','req.headers.x-csrf-token','req.body.password']},trustProxy:config.trustProxy,bodyLimit:65536,ajv:{customOptions:{removeAdditional:false}}});
 app.get('/api/v1/health',async(_request,reply)=>{await db.execute(sql`select 1`);if(!await boss.getQueue('asset-process'))return reply.code(503).send({status:'unavailable'});return {status:'ok'};});
 return app;
}
