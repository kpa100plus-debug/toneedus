import {fail,sha} from './secure-data.mjs';
import {assertSandbox,toss,verifyPayment,verifyPayout} from './toss-provider.mjs';
import {transitionTestOrder} from './transactions.mjs';
// An operation is durably reserved BEFORE network IO. Unknown outcomes are only
// reconciled by provider lookup, never resubmitted under a new idempotency key.
export async function executeProviderOperation(env,{orderId,kind,actorId,requestKey,paymentKey,reason=''}){
 assertSandbox(env);
 if(!['PAYMENT','REFUND','PAYOUT'].includes(kind)||! /^[A-Za-z0-9_-]{16,100}$/.test(requestKey||''))fail('INVALID_OPERATION',400);
 const order=await env.DB.prepare("SELECT * FROM transaction_orders WHERE id=? AND mode='TEST'").bind(orderId).first();if(!order)fail('ORDER_NOT_FOUND',404);
 if(kind==='PAYOUT'?actorId!=='TEST_OPERATOR':actorId!==order.owner_id)fail('OPERATION_FORBIDDEN',403);
 const fingerprint=await sha(JSON.stringify([orderId,kind,kind==='PAYMENT'?paymentKey:null,reason]));
 const old=await env.DB.prepare("SELECT * FROM provider_operations WHERE request_key=? OR (order_id=? AND kind=? AND status<>'FAILED') ORDER BY created_at DESC LIMIT 1").bind(requestKey,orderId,kind).first();
 if(old){if(old.order_id!==orderId||old.kind!==kind)fail('IDEMPOTENCY_CONFLICT');if(old.request_key!==requestKey||old.fingerprint!==fingerprint)fail('OPERATION_ALREADY_RESERVED');return {status:old.status,id:old.id,reconciliationRequired:old.status!=='SUCCEEDED'};}
 const wanted={PAYMENT:'PAYMENT_PENDING',REFUND:'REFUND_PENDING',PAYOUT:'PAYOUT_PENDING'};
 if(order.state!==wanted[kind])fail('INVALID_TRANSITION');
 if(kind==='REFUND'&&(reason.trim().length<10||reason.length>200))fail('REFUND_REASON_REQUIRED',400);
 if(kind==='PAYMENT'&&(typeof paymentKey!=='string'||!paymentKey||paymentKey.length>200))fail('INVALID_PROVIDER_REFERENCE',400);
 let sellerId=null;
 if(kind==='PAYOUT'){
  const seller=await env.DB.prepare("SELECT * FROM payout_sellers WHERE user_id=? AND mode='TEST'").bind(order.solver_id).first();if(!seller)fail('SELLER_REQUIRED');
  const result=await toss.getSeller(env,seller.seller_id);
  if(result.id!==seller.seller_id||!['APPROVED','PARTIALLY_APPROVED'].includes(result.status))fail('SELLER_KYC_REQUIRED');sellerId=seller.seller_id;
 }
 const id='op_'+crypto.randomUUID(), ref=kind==='PAYMENT'?paymentKey:kind==='REFUND'?order.payment_reference:null;
 try{await env.DB.prepare("INSERT INTO provider_operations(id,order_id,kind,request_key,fingerprint,status,provider_reference) SELECT ?,id,?,?,?,'PENDING',? FROM transaction_orders WHERE id=? AND state=? AND revision=? AND (?<>'PAYOUT' OR net+COALESCE((SELECT SUM(t.net) FROM provider_operations p JOIN transaction_orders t ON t.id=p.order_id WHERE p.kind='PAYOUT' AND t.solver_id=transaction_orders.solver_id AND julianday(p.created_at)>julianday('now','-7 days')),0)<10000000)").bind(id,kind,requestKey,fingerprint,ref,orderId,wanted[kind],order.revision,kind).run()}catch{fail('OPERATION_ALREADY_RESERVED')}
 const saved=await env.DB.prepare('SELECT id FROM provider_operations WHERE id=?').bind(id).first();if(!saved)fail('STALE_REVISION');
 try{
  if(kind==='PAYMENT')verifyPayment(await toss.confirm(env,{paymentKey,orderId,amount:order.amount,key:requestKey}),order,paymentKey);
  if(kind==='REFUND')verifyPayment(await toss.refund(env,{paymentKey:ref,amount:order.amount,reason,key:requestKey}),order,ref);
  if(kind==='PAYOUT'){
   const p=verifyPayout(await toss.payout(env,{refPayoutId:id,sellerId,amount:order.net,key:requestKey}),order,id,sellerId);
   await env.DB.prepare('UPDATE provider_operations SET provider_reference=? WHERE id=?').bind(p.id,id).run();
  }
  return await reconcileProviderOperation(env,id);
 }catch(e){await env.DB.prepare("UPDATE provider_operations SET status='UNKNOWN',error_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'SUCCEEDED'").bind(e.code||'PROVIDER_OUTCOME_UNKNOWN',id).run();return {id,status:'UNKNOWN',reconciliationRequired:true};}
}
export async function reconcileProviderOperation(env,id,providerReferenceHint=null){
 assertSandbox(env);const op=await env.DB.prepare('SELECT * FROM provider_operations WHERE id=?').bind(id).first();if(!op)fail('OPERATION_NOT_FOUND',404);
 if(['SUCCEEDED','FAILED'].includes(op.status))return {id,status:op.status,idempotent:true};
 const order=await env.DB.prepare("SELECT * FROM transaction_orders WHERE id=? AND mode='TEST'").bind(op.order_id).first();if(!order)fail('ORDER_NOT_FOUND',404);
 if(!op.provider_reference&&op.kind==='PAYOUT'&&providerReferenceHint){
  const seller=await env.DB.prepare("SELECT seller_id FROM payout_sellers WHERE user_id=? AND mode='TEST'").bind(order.solver_id).first();if(!seller)fail('SELLER_REQUIRED');
  const verified=verifyPayout(await toss.getPayout(env,providerReferenceHint),order,id,seller.seller_id);if(verified.id!==providerReferenceHint)fail('PROVIDER_RESULT_MISMATCH');
  await env.DB.prepare('UPDATE provider_operations SET provider_reference=? WHERE id=? AND provider_reference IS NULL').bind(verified.id,id).run();op.provider_reference=verified.id;
 }
 if(!op.provider_reference)return {id,status:'UNKNOWN',reconciliationRequired:true};
 let action,providerReference=op.provider_reference,amount=order.amount;
 if(op.kind==='PAYOUT'){
  const seller=await env.DB.prepare("SELECT seller_id FROM payout_sellers WHERE user_id=? AND mode='TEST'").bind(order.solver_id).first();if(!seller)fail('SELLER_REQUIRED');
  const p=verifyPayout(await toss.getPayout(env,op.provider_reference),order,id,seller.seller_id);
  if(p.status==='COMPLETED'){action='PAYOUT_SUCCEEDED';amount=order.net}
  else if(['FAILED','REJECTED','CANCELED'].includes(p.status))action='PAYOUT_FAILED';
 }else{
  const p=verifyPayment(await toss.getPayment(env,op.provider_reference),order,op.provider_reference);
  if(op.kind==='PAYMENT'){if(p.status==='DONE'&&p.balanceAmount===order.amount)action='PAYMENT_SUCCEEDED';else if(['ABORTED','EXPIRED'].includes(p.status))action='PAYMENT_FAILED';}
  else if(p.status==='CANCELED'&&p.balanceAmount===0&&p.cancels?.some(c=>c.cancelStatus==='DONE')&&p.cancels.filter(c=>c.cancelStatus==='DONE').reduce((n,c)=>n+c.cancelAmount,0)===order.amount){action='REFUND_SUCCEEDED';providerReference=p.cancels.find(c=>c.cancelStatus==='DONE').transactionKey;}
 }
 if(!action)return {id,status:'PENDING',reconciliationRequired:true};
 await transitionTestOrder(env,{orderId:order.id,requestKey:'result_'+id,action,actorId:'TEST_PROVIDER',revision:order.revision,providerReference,amount});
 const status=action.endsWith('SUCCEEDED')?'SUCCEEDED':'FAILED';
 await env.DB.prepare('UPDATE provider_operations SET status=?,error_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status,id).run();return {id,status};
}
// Webhook content is a hint, NEVER payment evidence. Known references only,
// with authenticated provider GET and durable operation/event deduplication.
export async function reconcileWebhook(env,body){
 assertSandbox(env);const data=body?.data;const paymentKey=data?.paymentKey,payoutId=data?.id;
 if(!['PAYMENT_STATUS_CHANGED','payout.changed'].includes(body?.eventType)||typeof (paymentKey||payoutId)!=='string')fail('INVALID_WEBHOOK',400);
 if(body.eventType==='payout.changed'&&typeof data.refPayoutId==='string'){
  const known=await env.DB.prepare("SELECT id FROM provider_operations WHERE id=? AND kind='PAYOUT'").bind(data.refPayoutId).first();if(known)await reconcileProviderOperation(env,known.id,payoutId);
 }
 const ops=await env.DB.prepare('SELECT id FROM provider_operations WHERE provider_reference=? ORDER BY created_at DESC LIMIT 3').bind(paymentKey||payoutId).all();
 for(const op of ops.results)await reconcileProviderOperation(env,op.id);return {ok:true};
}

export async function reconcilePendingOperations(env){
 if(env.APP_ENV!=='test'||env.PROVIDER_SANDBOX_ENABLED!=='true')return;
 const rows=await env.DB.prepare("SELECT id FROM provider_operations WHERE status IN ('PENDING','UNKNOWN') AND provider_reference IS NOT NULL ORDER BY updated_at LIMIT 10").all();
 for(const row of rows.results){try{await reconcileProviderOperation(env,row.id)}catch{await env.DB.prepare("UPDATE provider_operations SET error_code='RECONCILIATION_REQUIRED',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(row.id).run()}}
}
