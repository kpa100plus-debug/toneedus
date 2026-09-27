import {fail,sha,hexKey,unb64,limitedText} from './secure-data.mjs';
import {assertSandbox,toss,verifyPayment,verifyPayout} from './toss-provider.mjs';
import {transitionTestOrder,testOrderSettlement} from './transactions.mjs';
function cancellationSummary(payment,order){
 if(!Array.isArray(payment.cancels||[]))fail('PROVIDER_REFUND_MISMATCH');
 const done=(payment.cancels||[]).filter(c=>c.cancelStatus==='DONE');
 if(done.some(c=>typeof c.transactionKey!=='string'||!c.transactionKey||c.transactionKey.length>200||!Number.isSafeInteger(c.cancelAmount)||c.cancelAmount<=0)||new Set(done.map(c=>c.transactionKey)).size!==done.length)fail('PROVIDER_REFUND_MISMATCH');
 const total=done.reduce((n,c)=>n+c.cancelAmount,0);
 if(!Number.isSafeInteger(payment.balanceAmount)||total>order.amount||payment.balanceAmount!==order.amount-total)fail('PROVIDER_REFUND_MISMATCH');
 return {done,total};
}
async function refundBaseline(env,order,operationId){
 return (await env.DB.prepare(`SELECT r.provider_reference,r.amount FROM transaction_refund_receipts r
  JOIN transaction_events e ON e.id=r.event_id WHERE r.order_id=? AND e.request_key<>?`).bind(order.id,'result_'+operationId).all()).results;
}
function matchesBaseline(done,baseline){return baseline.every(r=>done.some(c=>c.transactionKey===r.provider_reference&&c.cancelAmount===r.amount));}
// An operation is durably reserved BEFORE network IO. Unknown outcomes are only
// reconciled by provider lookup, never resubmitted under a new idempotency key.
export async function executeProviderOperation(env,{orderId,kind,actorId,requestKey,paymentKey,reason=''}){
 assertSandbox(env);
 if(!['PAYMENT','REFUND','PAYOUT'].includes(kind)||! /^[A-Za-z0-9_-]{16,100}$/.test(requestKey||''))fail('INVALID_OPERATION',400);
 const order=await env.DB.prepare("SELECT * FROM transaction_orders WHERE id=? AND mode='TEST'").bind(orderId).first();if(!order)fail('ORDER_NOT_FOUND',404);
 if(kind==='PAYOUT'?actorId!=='TEST_OPERATOR':actorId!==order.owner_id)fail('OPERATION_FORBIDDEN',403);
 const fingerprint=await sha(JSON.stringify([orderId,kind,kind==='PAYMENT'?paymentKey:null,reason]));
 const old=await env.DB.prepare('SELECT * FROM provider_operations WHERE request_key=?').bind(requestKey).first();
 if(old){
  if(old.order_id!==orderId||old.kind!==kind)fail('IDEMPOTENCY_CONFLICT');if(old.fingerprint!==fingerprint)fail('OPERATION_ALREADY_RESERVED');
  if(kind==='REFUND'&&['REFUND_PENDING','PARTIAL_REFUND_PENDING'].includes(order.state)){
   const savedIntent=await env.DB.prepare('SELECT request_event_id FROM provider_operation_intents WHERE operation_id=?').bind(old.id).first();
   const currentIntent=await env.DB.prepare('SELECT id FROM transaction_events WHERE order_id=? AND next_state=? ORDER BY rowid DESC LIMIT 1').bind(orderId,order.state).first();
   if(savedIntent&&savedIntent.request_event_id!==currentIntent?.id)fail('IDEMPOTENCY_CONFLICT');
  }
  return {status:old.status,id:old.id,reconciliationRequired:!['SUCCEEDED','FAILED'].includes(old.status)};
 }
 const active=await env.DB.prepare("SELECT id FROM provider_operations WHERE order_id=? AND kind=? AND status<>'FAILED' AND (kind<>'REFUND' OR status<>'SUCCEEDED') LIMIT 1").bind(orderId,kind).first();
 if(active)fail('OPERATION_ALREADY_RESERVED');
 const wanted={PAYMENT:['PAYMENT_PENDING'],REFUND:['REFUND_PENDING','PARTIAL_REFUND_PENDING'],PAYOUT:['PAYOUT_PENDING']};
 if(!wanted[kind].includes(order.state))fail('INVALID_TRANSITION');
 if(kind==='REFUND'&&(reason.trim().length<10||reason.length>200))fail('REFUND_REASON_REQUIRED',400);
 if(kind==='PAYMENT'&&(typeof paymentKey!=='string'||!paymentKey||paymentKey.length>200))fail('INVALID_PROVIDER_REFERENCE',400);
 const settlement=await testOrderSettlement(env,order);
 const requestEvent=await env.DB.prepare('SELECT id,action,fingerprint FROM transaction_events WHERE order_id=? AND next_state=? ORDER BY rowid DESC LIMIT 1').bind(orderId,order.state).first();
 if(!requestEvent)fail('TRANSACTION_INTENT_REQUIRED');
 const transportAmount=kind==='PAYMENT'?order.amount:kind==='PAYOUT'?settlement.settlementNet:order.state==='PARTIAL_REFUND_PENDING'?JSON.parse(requestEvent.fingerprint)[3]:settlement.remainingAmount;
 if(!Number.isSafeInteger(transportAmount)||transportAmount<=0||(kind==='REFUND'&&(transportAmount>settlement.remainingAmount||(order.state==='PARTIAL_REFUND_PENDING'&&transportAmount===settlement.remainingAmount))))fail('INVALID_REFUND_AMOUNT');
 let sellerId=null;
 if(kind==='PAYOUT'){
  const seller=await env.DB.prepare("SELECT * FROM payout_sellers WHERE user_id=? AND mode='TEST'").bind(order.solver_id).first();if(!seller)fail('SELLER_REQUIRED');
  const result=await toss.getSeller(env,seller.seller_id);
  if(result.id!==seller.seller_id||!['APPROVED','PARTIALLY_APPROVED'].includes(result.status))fail('SELLER_KYC_REQUIRED');sellerId=seller.seller_id;
 }
 const id='op_'+crypto.randomUUID(), ref=kind==='PAYMENT'?paymentKey:kind==='REFUND'?order.payment_reference:null;
 try{await env.DB.batch([
  env.DB.prepare("INSERT INTO provider_operations(id,order_id,kind,request_key,fingerprint,status,provider_reference) SELECT ?,id,?,?,?,'PENDING',? FROM transaction_orders WHERE id=? AND state=? AND revision=? AND (?<>'PAYOUT' OR ?+COALESCE((SELECT SUM(COALESCE(i.amount,t.net)) FROM provider_operations p JOIN transaction_orders t ON t.id=p.order_id LEFT JOIN provider_operation_intents i ON i.operation_id=p.id WHERE p.kind='PAYOUT' AND t.solver_id=transaction_orders.solver_id AND julianday(p.created_at)>julianday('now','-7 days')),0)<10000000)").bind(id,kind,requestKey,fingerprint,ref,orderId,order.state,order.revision,kind,transportAmount),
  env.DB.prepare('INSERT INTO provider_operation_intents(operation_id,request_event_id,amount,refunded_before,expected_state) SELECT id,?,?,?,? FROM provider_operations WHERE id=?').bind(requestEvent.id,transportAmount,settlement.refundedAmount,order.state,id)
 ])}catch{fail('OPERATION_ALREADY_RESERVED')}
 const saved=await env.DB.prepare('SELECT id FROM provider_operations WHERE id=?').bind(id).first();if(!saved)fail('STALE_REVISION');
 try{
  if(kind==='PAYMENT')verifyPayment(await toss.confirm(env,{paymentKey,orderId,amount:order.amount,key:requestKey}),order,paymentKey);
  if(kind==='REFUND'){
   const before=verifyPayment(await toss.getPayment(env,ref),order,ref),summary=cancellationSummary(before,order),baseline=await refundBaseline(env,order,id);
   if(summary.total!==settlement.refundedAmount||baseline.reduce((n,r)=>n+r.amount,0)!==settlement.refundedAmount||!matchesBaseline(summary.done,baseline)||!['DONE','PARTIAL_CANCELED'].includes(before.status))fail('PROVIDER_REFUND_BASELINE_MISMATCH');
   verifyPayment(await toss.refund(env,{paymentKey:ref,amount:transportAmount,reason,key:requestKey}),order,ref);
  }
  if(kind==='PAYOUT'){
   const p=verifyPayout(await toss.payout(env,{refPayoutId:id,sellerId,amount:transportAmount,key:requestKey}),{...order,net:transportAmount},id,sellerId);
   await env.DB.prepare('UPDATE provider_operations SET provider_reference=? WHERE id=?').bind(p.id,id).run();
  }
  return await reconcileProviderOperation(env,id);
 }catch(e){await env.DB.prepare("UPDATE provider_operations SET status='UNKNOWN',error_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'SUCCEEDED'").bind(e.code||'PROVIDER_OUTCOME_UNKNOWN',id).run();return {id,status:'UNKNOWN',reconciliationRequired:true};}
}
export async function reconcileProviderOperation(env,id,providerReferenceHint=null){
 assertSandbox(env);const op=await env.DB.prepare('SELECT * FROM provider_operations WHERE id=?').bind(id).first();if(!op)fail('OPERATION_NOT_FOUND',404);
 if(['SUCCEEDED','FAILED'].includes(op.status))return {id,status:op.status,idempotent:true};
 const order=await env.DB.prepare("SELECT * FROM transaction_orders WHERE id=? AND mode='TEST'").bind(op.order_id).first();if(!order)fail('ORDER_NOT_FOUND',404);
 const intent=await env.DB.prepare('SELECT * FROM provider_operation_intents WHERE operation_id=?').bind(id).first();
 const transportAmount=intent?.amount??(op.kind==='PAYOUT'?order.net:order.amount);
 const payoutOrder={...order,net:transportAmount};
 if(!op.provider_reference&&op.kind==='PAYOUT'&&providerReferenceHint){
  const seller=await env.DB.prepare("SELECT seller_id FROM payout_sellers WHERE user_id=? AND mode='TEST'").bind(order.solver_id).first();if(!seller)fail('SELLER_REQUIRED');
  const verified=verifyPayout(await toss.getPayout(env,providerReferenceHint),payoutOrder,id,seller.seller_id);if(verified.id!==providerReferenceHint)fail('PROVIDER_RESULT_MISMATCH');
  await env.DB.prepare('UPDATE provider_operations SET provider_reference=? WHERE id=? AND provider_reference IS NULL').bind(verified.id,id).run();op.provider_reference=verified.id;
 }
 if(!op.provider_reference)return {id,status:'UNKNOWN',reconciliationRequired:true};
 let action,providerReference=op.provider_reference,amount=order.amount;
 if(op.kind==='PAYOUT'){
  const seller=await env.DB.prepare("SELECT seller_id FROM payout_sellers WHERE user_id=? AND mode='TEST'").bind(order.solver_id).first();if(!seller)fail('SELLER_REQUIRED');
  const p=verifyPayout(await toss.getPayout(env,op.provider_reference),payoutOrder,id,seller.seller_id);
  if(p.status==='COMPLETED'){action='PAYOUT_SUCCEEDED';amount=transportAmount}
  else if(['FAILED','REJECTED','CANCELED'].includes(p.status))action='PAYOUT_FAILED';
 }else{
  const p=verifyPayment(await toss.getPayment(env,op.provider_reference),order,op.provider_reference);
  if(op.kind==='PAYMENT'){if(p.status==='DONE'&&p.balanceAmount===order.amount)action='PAYMENT_SUCCEEDED';else if(['ABORTED','EXPIRED'].includes(p.status))action='PAYMENT_FAILED';}
  else if(['PARTIAL_CANCELED','CANCELED'].includes(p.status)){
   const summary=cancellationSummary(p,order),baseline=await refundBaseline(env,order,id),before=intent?.refunded_before??0;
   if(baseline.reduce((n,r)=>n+r.amount,0)!==before||!matchesBaseline(summary.done,baseline))fail('PROVIDER_REFUND_BASELINE_MISMATCH');
   const added=summary.done.filter(c=>!baseline.some(r=>r.provider_reference===c.transactionKey));
   if(summary.total===before)return {id,status:'PENDING',reconciliationRequired:true};
   if(added.length!==1||added[0].cancelAmount!==transportAmount||summary.total!==before+transportAmount||p.status!==(p.balanceAmount===0?'CANCELED':'PARTIAL_CANCELED'))fail('PROVIDER_REFUND_MISMATCH');
   action=intent?.expected_state==='PARTIAL_REFUND_PENDING'?'PARTIAL_REFUND_SUCCEEDED':'REFUND_SUCCEEDED';
   providerReference=added[0].transactionKey;amount=transportAmount;
  }
 }
 if(!action)return {id,status:'PENDING',reconciliationRequired:true};
 await transitionTestOrder(env,{orderId:order.id,requestKey:'result_'+id,action,actorId:'TEST_PROVIDER',revision:order.revision,providerReference,amount});
 const status=action.endsWith('SUCCEEDED')?'SUCCEEDED':'FAILED';
 await env.DB.prepare('UPDATE provider_operations SET status=?,error_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status,id).run();return {id,status};
}
// Webhook content is a hint, NEVER payment evidence. Known references only,
// with authenticated provider GET and durable operation/event deduplication.
export async function reconcileWebhook(env,body){
 assertSandbox(env);const data=body?.eventType==='payout.changed'?body.entityBody:body?.data;const paymentKey=data?.paymentKey,payoutId=data?.id;
 if(!['PAYMENT_STATUS_CHANGED','payout.changed'].includes(body?.eventType)||typeof (paymentKey||payoutId)!=='string')fail('INVALID_WEBHOOK',400);
 if(body.eventType==='payout.changed'&&typeof data.refPayoutId==='string'){
  const known=await env.DB.prepare("SELECT id FROM provider_operations WHERE id=? AND kind='PAYOUT'").bind(data.refPayoutId).first();if(known)await reconcileProviderOperation(env,known.id,payoutId);
 }
 const ops=await env.DB.prepare('SELECT id FROM provider_operations WHERE provider_reference=? ORDER BY created_at DESC LIMIT 3').bind(paymentKey||payoutId).all();
 for(const op of ops.results)await reconcileProviderOperation(env,op.id);return {ok:true};
}

// Toss documents signed payout/seller hooks, while general payment hooks have
// no signature and must be reconciled with an authenticated Payment Query API.
// https://docs.tosspayments.com/reference/using-api/webhook-events
export async function readProviderWebhook(request,env){
 assertSandbox(env);
 const raw=await limitedText(request,64*1024);
 let body;try{body=JSON.parse(raw)}catch{fail('INVALID_WEBHOOK',400)}
 if(!body||typeof body!=='object'||Array.isArray(body)||!['PAYMENT_STATUS_CHANGED','payout.changed'].includes(body.eventType))fail('INVALID_WEBHOOK',400);
 if(body.eventType==='payout.changed'){
  if(!hexKey(env.TOSS_PAYOUT_SECURITY_KEY))fail('WEBHOOK_SECURITY_KEY_REQUIRED',503);
  const time=request.headers.get('tosspayments-webhook-transmission-time')||'';
  const sentAt=Date.parse(time);
  // Every retry has a new transmission time; stale signed payloads are not reused.
  if(!Number.isFinite(sentAt)||Math.abs(Date.now()-sentAt)>5*60*1000)fail('WEBHOOK_TIMESTAMP_INVALID',401);
  const header=request.headers.get('tosspayments-webhook-signature')||'';
  if(header.length>512)fail('WEBHOOK_SIGNATURE_INVALID',401);
  const signatures=[...header.matchAll(/(?:^|[,\s])v1:([A-Za-z0-9+/]+={0,2})(?=$|[,\s])/g)].map(m=>m[1]);
  if(!signatures.length||signatures.length>4)fail('WEBHOOK_SIGNATURE_INVALID',401);
  const key=await crypto.subtle.importKey('raw',Uint8Array.from(env.TOSS_PAYOUT_SECURITY_KEY.match(/../g),x=>parseInt(x,16)),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  let valid=false;
  for(const signature of signatures){try{valid=(await crypto.subtle.verify('HMAC',key,unb64(signature),new TextEncoder().encode(raw+':'+time)))||valid}catch{}}
  if(!valid)fail('WEBHOOK_SIGNATURE_INVALID',401);
 }
 return body;
}

export async function reconcilePendingOperations(env){
 if(env.APP_ENV!=='test'||env.PROVIDER_SANDBOX_ENABLED!=='true')return;
 const rows=await env.DB.prepare("SELECT id FROM provider_operations WHERE status IN ('PENDING','UNKNOWN') AND provider_reference IS NOT NULL ORDER BY updated_at LIMIT 10").all();
 for(const row of rows.results){try{await reconcileProviderOperation(env,row.id)}catch{await env.DB.prepare("UPDATE provider_operations SET error_code='RECONCILIATION_REQUIRED',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(row.id).run()}}
}
