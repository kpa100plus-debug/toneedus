import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createTestOrder,transitionTestOrder} from '../worker/transactions.mjs';
import {executeProviderOperation,reconcileProviderOperation,reconcileWebhook} from '../worker/provider-operations.mjs';
import {encryptJwe,decryptJwe} from '../worker/toss-provider.mjs';
const sql=new DatabaseSync(':memory:');
for(const f of readdirSync(new URL('../migrations/',import.meta.url)).sort())if(f.endsWith('.sql'))sql.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
const DB={prepare(q){return{args:[],bind(...args){this.args=args;return this},async first(){return sql.prepare(q).get(...this.args)||null},async all(){return{results:sql.prepare(q).all(...this.args)}},async run(){const s=sql.prepare(q);if(s.columns().length)return this.all();const r=s.run(...this.args);return{meta:{changes:Number(r.changes)}}}}},async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
const env={DB,APP_ENV:'test',PROVIDER_SANDBOX_ENABLED:'true',TOSS_SECRET_KEY:'test_sk_fixture',TOSS_PAYOUT_SECURITY_KEY:'bc'.repeat(32)};
const ownerId='transport_owner',solverId='transport_solver';
for(const id of [ownerId,solverId])sql.prepare('INSERT INTO users(id,email,password_hash,password_salt,display_name) VALUES(?,?,?,?,?)').run(id,id+'@test.invalid','fixture','fixture',id);
sql.prepare("INSERT INTO payout_sellers(user_id,mode,seller_id,status,checked_at) VALUES(?,'TEST','seller_transport','APPROVED',CURRENT_TIMESTAMP)").run(solverId);
let serial=0,groups=0;const key=()=>`provider_partial_${++serial}`,pass=s=>{groups++;console.log('PASS provider-partial: '+s)};
const payments=new Map(),payouts=new Map(),refundAmounts=[],payoutAmounts=[];
let refundPosts=0,payoutPosts=0,timeout=false,ambiguous=false,reusedReference=null,wrongPayoutAmount=false;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname;
 if(path.startsWith('/v2/sellers/'))return Response.json({entityBody:{id:'seller_transport',status:'APPROVED'}});
 if(path==='/v2/payouts'&&options.method==='POST'){
  const [body]=await decryptJwe(options.body,env.TOSS_PAYOUT_SECURITY_KEY);payoutPosts++;payoutAmounts.push(body.amount.value);
  assert.match(options.headers['Idempotency-Key'],/^provider_partial_/);
  const row={...body,id:key(),status:'COMPLETED'};payouts.set(row.id,row);
  return new Response(await encryptJwe({entityBody:{items:[wrongPayoutAmount?{...row,amount:{currency:'KRW',value:90000}}:row]}},env.TOSS_PAYOUT_SECURITY_KEY));
 }
 if(path.startsWith('/v2/payouts/'))return Response.json({entityBody:payouts.get(decodeURIComponent(path.split('/').at(-1)))});
 const paymentKey=decodeURIComponent(path.split('/')[3]),payment=payments.get(paymentKey);assert.ok(payment,'unexpected provider URL '+url);
 if(options.method==='POST'){
  assert.ok(path.endsWith('/cancel'));const body=JSON.parse(options.body);assert.equal(body.currency,'KRW');assert.match(options.headers['Idempotency-Key'],/^provider_partial_/);
  refundPosts++;refundAmounts.push(body.cancelAmount);
  const values=ambiguous?[Math.floor(body.cancelAmount/2),body.cancelAmount-Math.floor(body.cancelAmount/2)]:[body.cancelAmount];
  for(const cancelAmount of values)payment.cancels.push({cancelStatus:'DONE',cancelAmount,transactionKey:reusedReference||key()});
  payment.balanceAmount-=body.cancelAmount;payment.status=payment.balanceAmount?'PARTIAL_CANCELED':'CANCELED';
  if(timeout)throw new Error('timeout after provider committed refund');
 }
 return Response.json(payment);
};
async function funded(){
 const challengeId=key();sql.prepare(`INSERT INTO challenges(id,owner_id,title,summary,description,category,reward_amount,success_criteria,payment_trigger,evidence_requirements,deadline,selected_solver_id)
 VALUES(?,?,'가상검사','가상검사','가상검사','IDEA',100000,'파일','확인','원본','2099-01-01',?)`).run(challengeId,ownerId,solverId);
 let row=await createTestOrder(env,{challengeId,ownerId,solverId,amount:100000,requestKey:key()});
 row=await move(row,'REQUEST_PAYMENT');const paymentKey=key();row=await move(row,'PAYMENT_SUCCEEDED',{actorId:'TEST_PROVIDER',providerReference:paymentKey,amount:100000});
 payments.set(paymentKey,{paymentKey,orderId:row.id,totalAmount:100000,balanceAmount:100000,currency:'KRW',status:'DONE',cancels:[]});return row;
}
const move=(row,action,extra={})=>transitionTestOrder(env,{orderId:row.id,requestKey:key(),revision:row.revision,actorId:ownerId,action,...extra});
const refresh=row=>sql.prepare('SELECT * FROM transaction_orders WHERE id=?').get(row.id);
const reason='합의한 작업범위 변경에 따라 환불을 요청합니다.';
const refundInput=row=>({orderId:row.id,kind:'REFUND',actorId:ownerId,requestKey:key(),reason});
try{
 let row=await funded();row=await move(row,'REQUEST_PARTIAL_REFUND',{amount:20000,reason});
 const first=refundInput(row),one=await executeProviderOperation(env,first);assert.equal(one.status,'SUCCEEDED');assert.equal(refundAmounts.at(-1),20000);
 const count=refundPosts;assert.equal((await executeProviderOperation(env,first)).status,'SUCCEEDED');assert.equal(refundPosts,count);
 row=refresh(row);assert.equal(row.state,'PARTIALLY_REFUNDED');row=await move(row,'REQUEST_PARTIAL_REFUND',{amount:30000,reason});
 await assert.rejects(executeProviderOperation(env,first),/IDEMPOTENCY_CONFLICT/);
 timeout=true;const second=refundInput(row),two=await executeProviderOperation(env,second);assert.equal(two.status,'UNKNOWN');const sent=refundPosts;
 assert.equal((await executeProviderOperation(env,second)).status,'UNKNOWN');assert.equal(refundPosts,sent);
 await assert.rejects(executeProviderOperation(env,{...second,requestKey:key()}),/OPERATION_ALREADY_RESERVED/);assert.equal(refundPosts,sent);
 timeout=false;assert.equal((await reconcileProviderOperation(env,two.id)).status,'SUCCEEDED');assert.equal(refundAmounts.at(-1),30000);
 row=refresh(row);row=await move(row,'REQUEST_REFUND');const three=await executeProviderOperation(env,refundInput(row));assert.equal(three.status,'SUCCEEDED');assert.equal(refundAmounts.at(-1),50000);
 assert.equal(refresh(row).state,'REFUNDED');assert.equal(sql.prepare('SELECT SUM(amount) n FROM transaction_refund_receipts WHERE order_id=?').get(row.id).n,100000);
 assert.equal(sql.prepare('SELECT SUM(debit)-SUM(credit) n FROM transaction_ledger WHERE order_id=?').get(row.id).n,0);
 pass('sequential partial refunds and remaining full refund send server amounts; timeout never resends; old key cannot become a new refund');

 row=await funded();row=await move(row,'REQUEST_PARTIAL_REFUND',{amount:25000,reason});await executeProviderOperation(env,refundInput(row));row=refresh(row);
 row=await move(row,'SUBMIT_PROOF',{actorId:solverId});row=await move(row,'ACCEPT_PROOF');row=await move(row,'QUEUE_PAYOUT',{actorId:'TEST_OPERATOR'});
 wrongPayoutAmount=true;const payoutInput={orderId:row.id,kind:'PAYOUT',actorId:'TEST_OPERATOR',requestKey:key()},payout=await executeProviderOperation(env,payoutInput);
 assert.equal(payout.status,'UNKNOWN');assert.equal(payoutAmounts.at(-1),67500);assert.equal(refresh(row).state,'PAYOUT_PENDING');
 wrongPayoutAmount=false;const payoutId=[...payouts.keys()].at(-1);assert.equal((await reconcileProviderOperation(env,payout.id,payoutId)).status,'SUCCEEDED');
 const payoutCount=payoutPosts;await executeProviderOperation(env,payoutInput);assert.equal(payoutPosts,payoutCount);
 assert.equal(refresh(row).state,'PAID');assert.equal(refresh(row).net,90000);
 assert.equal(sql.prepare("SELECT SUM(credit) n FROM transaction_ledger WHERE order_id=? AND account='PLATFORM_FEE'").get(row.id).n,7500);
 assert.equal(sql.prepare("SELECT SUM(credit)-SUM(debit) n FROM transaction_ledger WHERE order_id=? AND account='CUSTOMER_LIABILITY'").get(row.id).n,0);
 pass('encrypted payout sends remaining 90%; wrong provider amount is held; authenticated retry credits once and preserves original snapshot');

 row=await funded();row=await move(row,'REQUEST_PARTIAL_REFUND',{amount:10000,reason});const before=refundPosts;
 const concurrent=await Promise.allSettled([executeProviderOperation(env,refundInput(row)),executeProviderOperation(env,refundInput(row))]);
 assert.equal(concurrent.filter(x=>x.status==='fulfilled'&&x.value.status==='SUCCEEDED').length,1);assert.equal(concurrent.filter(x=>x.status==='rejected').length,1);assert.equal(refundPosts,before+1);
 assert.equal(sql.prepare('SELECT count(*) n FROM transaction_refund_receipts WHERE order_id=?').get(row.id).n,1);
 const op=sql.prepare("SELECT id FROM provider_operations WHERE order_id=? AND kind='REFUND'").get(row.id);
 sql.prepare("UPDATE provider_operations SET status='UNKNOWN' WHERE id=?").run(op.id);
 await reconcileProviderOperation(env,op.id);assert.equal(sql.prepare('SELECT count(*) n FROM transaction_refund_receipts WHERE order_id=?').get(row.id).n,1);
 pass('different concurrent keys reserve one refund; crash between ledger and operation completion reconciles idempotently');

 row=await funded();row=await move(row,'REQUEST_PARTIAL_REFUND',{amount:20000,reason});ambiguous=true;
 const ambiguousOp=await executeProviderOperation(env,refundInput(row));ambiguous=false;assert.equal(ambiguousOp.status,'UNKNOWN');assert.equal(refresh(row).state,'PARTIAL_REFUND_PENDING');
 assert.equal(sql.prepare('SELECT count(*) n FROM transaction_refund_receipts WHERE order_id=?').get(row.id).n,0);
 await assert.rejects(reconcileProviderOperation(env,ambiguousOp.id),/PROVIDER_REFUND_MISMATCH/);
 pass('multiple new cancellations are never guessed or allocated to the wrong refund intent');

 row=await funded();row=await move(row,'REQUEST_PARTIAL_REFUND',{amount:20000,reason});
 reusedReference=sql.prepare('SELECT provider_reference FROM transaction_refund_receipts LIMIT 1').get().provider_reference;
 const reuse=await executeProviderOperation(env,refundInput(row));reusedReference=null;assert.equal(reuse.status,'UNKNOWN');assert.equal(refresh(row).state,'PARTIAL_REFUND_PENDING');
 assert.equal(sql.prepare('SELECT count(*) n FROM transaction_refund_receipts WHERE order_id=?').get(row.id).n,0);
 pass('same cancellation reference cannot post a second order refund');

 row=await funded();row=await move(row,'REQUEST_PARTIAL_REFUND',{amount:20000,reason});const changed=payments.get(row.payment_reference);
 changed.cancels.push({transactionKey:key(),cancelStatus:'DONE',cancelAmount:1000});changed.balanceAmount-=1000;changed.status='PARTIAL_CANCELED';
 const baselinePosts=refundPosts,hold=await executeProviderOperation(env,refundInput(row));assert.equal(hold.status,'UNKNOWN');assert.equal(refundPosts,baselinePosts);
 await assert.rejects(executeProviderOperation({...env,APP_ENV:'production',PUBLIC_MONEY_ENABLED:'true'},refundInput(row)),/PROVIDER_SANDBOX_NOT_CONFIGURED/);assert.equal(refundPosts,baselinePosts);
 pass('external balance drift is detected before sending; production flags never enable provider calls');

 const tables=['transaction_orders','provider_operations','transaction_events','transaction_ledger','transaction_refund_receipts','provider_operation_intents'];
 const snapshot=()=>JSON.stringify(tables.map(t=>sql.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()));const beforeMigration=snapshot();
 const migration=readFileSync(new URL('../migrations/0026_provider_partial_refunds.sql',import.meta.url),'utf8');sql.exec(migration);sql.exec(migration);assert.equal(snapshot(),beforeMigration);
 assert.throws(()=>sql.exec('UPDATE provider_operation_intents SET amount=1'),/IMMUTABLE_PROVIDER_INTENT/);
 assert.equal(sql.prepare("SELECT count(*) n FROM transaction_orders WHERE mode='LIVE'").get().n,0);
 pass('migration reruns preserve every existing finance row and immutable amounts; no live transactions');
}finally{globalThis.fetch=originalFetch;sql.close()}
console.log(`Passed ${groups} provider partial refund regression groups`);
