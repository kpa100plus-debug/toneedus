// Isolated QA server: real Worker routes and schema, disposable in-memory data.
// Never binds externally and never sends email, OAuth, payment or push requests.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import worker from '../worker/index.mjs';
const sql = new DatabaseSync(':memory:');
for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if(f.endsWith('.sql')) sql.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
const DB={prepare(query){return {args:[],bind(...args){this.args=args;return this},async first(){return sql.prepare(query).get(...this.args)||null},async all(){return {results:sql.prepare(query).all(...this.args)}},execute(){const q=sql.prepare(query);if(/\bRETURNING\b/i.test(query)){const results=q.all(...this.args);return {results,meta:{changes:Number(sql.prepare('SELECT changes() n').get().n)}}}if(/^\s*(SELECT|WITH)/i.test(query))return {results:q.all(...this.args)};return {meta:{changes:Number(q.run(...this.args).changes)}}},async run(){return this.execute()}}},async batch(stmts){sql.exec('BEGIN');try{const r=stmts.map(s=>s.execute());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
const roles=['owner','solver','unverified','primary','deputy','stranger'];
for (const role of roles) {
 sql.prepare('INSERT INTO users(id,email,password_hash,password_salt,display_name,email_verified,trust_score,bounty_limit,is_admin,terms_version,privacy_version) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('qa_'+role,role+'@qa.invalid','fixture','fixture','검수 '+role,role==='unverified'?0:1,70,100000000,['primary','deputy'].includes(role)?1:0,'qa','qa');
 sql.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').run('session_'+role,'qa_'+role,createHash('sha256').update('qa-session-'+role).digest('hex'),'2099-01-01T00:00:00Z');
 if(['primary','deputy'].includes(role))sql.prepare('INSERT INTO admin_roles(user_id,role,appointed_by) VALUES(?,?,?)').run('qa_'+role,role,'qa_primary');
}
for(let i=0;i<12;i++){
 sql.prepare(`INSERT INTO challenges(id,owner_id,title,summary,description,category,reward_amount,success_criteria,payment_trigger,evidence_requirements,deadline,status,funding_status,visibility) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('qa_mission_'+i,'qa_owner',`검수 ${i+1} 지역 환경을 개선할 전문가를 찾아주세요`,'검사용 지역의 현장을 조사하고 개선 제안서를 제출해주세요.',`검수 지역 ${i+1}번 공원의 안전한 보행 경로를 조사하고 안내판 원본을 제출해주세요.`,['IDEA','FIND','CONNECT','BUSINESS','ACTION','LOCAL','SOCIAL','PUBLIC'][i%8],i===1?4999999:100000+i*10000,`검수 ${i+1}번 공원 사진 세 장과 원본 제안서 제출`,'후보 선정 후 조건 확인','현장 사진과 원본 자료','2099-01-01',i===2?'SHORTLISTED':'OPEN','POSTED','public');
}
sql.prepare("INSERT INTO teasers(id,challenge_id,solver_id,headline,capability,approach,expected_days,status) VALUES('qa_teaser','qa_mission_2','qa_solver','공원 조사와 원본 제작을 제안합니다','검수용 현장 조사와 디자인 경험이 있습니다','지역을 조사하고 개선안을 제출하겠습니다',3,'SHORTLISTED')").run();
sql.prepare("UPDATE challenges SET shortlisted_count=1,teaser_count=1,participant_count=1 WHERE id='qa_mission_2'").run();
const env={DB,APP_ENV:'production',APP_VERSION:'qa-local',PWA_VERSION:'v92',VERIFICATION_ENFORCEMENT:'required',PUBLIC_MONEY_ENABLED:'false',PRIMARY_ADMIN_EMAIL:'primary@qa.invalid',PLATFORM_FEE_RATE:'0.1'};
const publicRoot=resolve(new URL('../public/',import.meta.url).pathname);
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
function asset(path){let f=resolve(publicRoot,'.'+path);if(!f.startsWith(publicRoot+'/')||!existsSync(f)||path==='/')f=resolve(publicRoot,'index.html');return new Response(readFileSync(f),{headers:{'content-type':mime[extname(f)]||'application/octet-stream'}})}
env.ASSETS={fetch:async request=>asset(new URL(request.url).pathname)};
globalThis.fetch=async()=>{throw new Error('QA fixture forbids external transport')};
createServer(async (req,res)=>{try{const origin='http://127.0.0.1:8789';const path=new URL(req.url,origin).pathname;if(path==='/__qa/font'){res.setHeader('content-type','font/ttf');res.end(readFileSync(process.env.MODU_QA_FONT));return;}const chunks=[];for await(const c of req)chunks.push(c);const response=path.startsWith('/api/')?await worker.fetch(new Request(origin+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)}),env,{waitUntil(p){p.catch(()=>{})}}):asset(path);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()))}catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));console.error(e.message)}}).listen(8789,'127.0.0.1',()=>console.log('QA fixture listening 127.0.0.1:8789; in-memory schema; external transports disabled'));
