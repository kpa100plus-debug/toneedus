// Durable transaction core. Provider transport is deliberately unreleased.
// TEST orders never update legacy missions/settlements or make network calls.
const uid=()=>crypto.randomUUID();
const error=(code)=>{const e=new Error(code);e.code=code;throw e;};
const keyOK=k=>typeof k==='string' && /^[a-zA-Z0-9_-]{16,100}$/.test(k);
export async function createTestOrder(env,{challengeId,ownerId,solverId,amount,requestKey}) {
  if (env.APP_ENV!=='test') error('LIVE_PROVIDER_NOT_RELEASED');
  if (!keyOK(requestKey)) error('IDEMPOTENCY_KEY_REQUIRED');
  if (ownerId===solverId) error('SELF_TRANSACTION_DENIED');
  if (!Number.isSafeInteger(amount)||amount<10000||amount>100000000) error('INVALID_AMOUNT');
  const old=await env.DB.prepare('SELECT * FROM transaction_orders WHERE owner_id=? AND request_key=?').bind(ownerId,requestKey).first();
  if(old) {
    if(old.challenge_id!==challengeId||old.solver_id!==solverId||old.amount!==amount) error('IDEMPOTENCY_CONFLICT');
    return old;
  }
  const mission=await env.DB.prepare('SELECT owner_id,selected_solver_id FROM challenges WHERE id=?').bind(challengeId).first();
  if(!mission||mission.owner_id!==ownerId||mission.selected_solver_id!==solverId) error('PARTIES_MISMATCH');
  const fee=Math.round(amount/10),id=uid();
  await env.DB.prepare(`INSERT INTO transaction_orders(id,challenge_id,owner_id,solver_id,mode,amount,fee,net,request_key)
    VALUES(?,?,?,?,'TEST',?,?,?,?) ON CONFLICT(owner_id,request_key) DO NOTHING`).bind(id,challengeId,ownerId,solverId,amount,fee,amount-fee,requestKey).run();
  const saved=await env.DB.prepare('SELECT * FROM transaction_orders WHERE owner_id=? AND request_key=?').bind(ownerId,requestKey).first();
  if(saved.challenge_id!==challengeId||saved.solver_id!==solverId||saved.amount!==amount) error('IDEMPOTENCY_CONFLICT');
  return saved;
}

export async function transitionTestOrder(env,{orderId,requestKey,action,actorId,revision,providerReference,amount,currency='KRW',reason=''}) {
  if(env.APP_ENV!=='test') error('LIVE_PROVIDER_NOT_RELEASED');
  if(!keyOK(requestKey)) error('IDEMPOTENCY_KEY_REQUIRED');
  const row=await env.DB.prepare('SELECT * FROM transaction_orders WHERE id=?').bind(orderId).first();
  if(!row||row.mode!=='TEST') error('ORDER_NOT_FOUND');
  const providerActions=['PAYMENT_SUCCEEDED','PAYMENT_FAILED','REFUND_SUCCEEDED','REFUND_FAILED','PAYOUT_SUCCEEDED','PAYOUT_FAILED'];
  const operatorActions=['QUEUE_PAYOUT','RESOLVE_REFUND','RESOLVE_PAYOUT'];
  if(providerActions.includes(action)) { if(actorId!=='TEST_PROVIDER') error('PROVIDER_ONLY'); }
  else if(operatorActions.includes(action)) { if(actorId!=='TEST_OPERATOR') error('OPERATOR_ONLY'); }
  else if(action==='SUBMIT_PROOF') { if(actorId!==row.solver_id) error('SOLVER_ONLY'); }
  else if(action==='OPEN_DISPUTE') { if(![row.owner_id,row.solver_id].includes(actorId)) error('PARTY_REQUIRED'); }
  else if(actorId!==row.owner_id) error('OWNER_ONLY');
  const fingerprint=JSON.stringify([action,actorId,providerReference||null,amount??null,currency,reason]);
  const prior=await env.DB.prepare('SELECT * FROM transaction_events WHERE order_id=? AND request_key=?').bind(orderId,requestKey).first();
  if(prior) { if(prior.fingerprint!==fingerprint) error('IDEMPOTENCY_CONFLICT'); return {...row,idempotent:true}; }
  if(revision!==row.revision) error('STALE_REVISION');
  const s=row.state;
  let next, paymentRef=row.payment_reference, payoutRef=row.payout_reference;
  let ledger=[];
  const state=(allowed,target)=>{if(!allowed.includes(s)) error('INVALID_TRANSITION');next=target;};
  const pair=(debit,credit,value)=>{ledger.push([debit,value,0],[credit,0,value]);};
  const providerCheck=expected=>{
    if(!providerReference||typeof providerReference!=='string'||providerReference.length>120||currency!=='KRW'||amount!==expected) error('PROVIDER_RESULT_MISMATCH');
  };
  switch(action) {
    case 'REQUEST_PAYMENT':state(['CREATED','PAYMENT_FAILED'],'PAYMENT_PENDING');break;
    case 'PAYMENT_SUCCEEDED':
      state(['PAYMENT_PENDING'],'FUNDED');providerCheck(row.amount);paymentRef=providerReference;
      pair('PROVIDER_HELD_FUNDS','CUSTOMER_LIABILITY',row.amount);break;
    case 'PAYMENT_FAILED':state(['PAYMENT_PENDING'],'PAYMENT_FAILED');break;
    case 'SUBMIT_PROOF':state(['FUNDED'],'PROOF_SUBMITTED');break;
    case 'REJECT_PROOF':state(['PROOF_SUBMITTED'],'FUNDED');break;
    case 'ACCEPT_PROOF':state(['PROOF_SUBMITTED'],'ACCEPTED');break;
    case 'CANCEL':state(['CREATED','PAYMENT_FAILED'],'CANCELLED');break;
    // A network timeout stays pending: never turn an unknown outcome into failure.
    case 'REQUEST_REFUND':state(['FUNDED'],'REFUND_PENDING');break;
    case 'REFUND_FAILED':state(['REFUND_PENDING'],'REFUND_FAILED');break;
    case 'REFUND_SUCCEEDED':
      state(['REFUND_PENDING'],'REFUNDED');providerCheck(row.amount);
      pair('CUSTOMER_LIABILITY','PROVIDER_HELD_FUNDS',row.amount);break;
    case 'OPEN_DISPUTE':
      if(reason.trim().length<10||reason.length>1000) error('DISPUTE_REASON_REQUIRED');
      state(['FUNDED','PROOF_SUBMITTED','ACCEPTED','PAYOUT_FAILED','REFUND_FAILED'],'DISPUTED');break;
    case 'RESOLVE_REFUND':
      if(reason.trim().length<10) error('RESOLUTION_REQUIRED');state(['DISPUTED'],'REFUND_PENDING');break;
    case 'RESOLVE_PAYOUT':
      if(reason.trim().length<10) error('RESOLUTION_REQUIRED');state(['DISPUTED'],'ACCEPTED');break;
    case 'QUEUE_PAYOUT':state(['ACCEPTED'],'PAYOUT_PENDING');break;
    case 'PAYOUT_FAILED':state(['PAYOUT_PENDING'],'PAYOUT_FAILED');break;
    // Retry only after provider reconciliation, via audited dispute resolution.
    case 'PAYOUT_SUCCEEDED':
      state(['PAYOUT_PENDING'],'PAID');providerCheck(row.net);payoutRef=providerReference;
      ledger=[['CUSTOMER_LIABILITY',row.amount,0],['PROVIDER_HELD_FUNDS',0,row.net],['PLATFORM_FEE',0,row.fee]];break;
    default:error('UNKNOWN_ACTION');
  }
  const eventId=uid();
  const statements=[
    env.DB.prepare(`INSERT INTO transaction_events(id,order_id,request_key,fingerprint,action,actor_id,previous_state,next_state)
      SELECT ?,id,?,?,?,?,state,? FROM transaction_orders WHERE id=? AND revision=? AND state=?`)
      .bind(eventId,requestKey,fingerprint,action,actorId,next,orderId,revision,s),
    env.DB.prepare(`UPDATE transaction_orders SET state=?,revision=revision+1,payment_reference=?,payout_reference=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM transaction_events WHERE id=?)`).bind(next,paymentRef,payoutRef,orderId,revision,eventId),
    ...ledger.map(([account,debit,credit])=>env.DB.prepare(`INSERT INTO transaction_ledger(id,order_id,event_id,account,debit,credit)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM transaction_events WHERE id=?)`).bind(uid(),orderId,eventId,account,debit,credit,eventId))
  ];
  let results;
  try { results=await env.DB.batch(statements); }
  catch(e){if(String(e).includes('UNIQUE')) error('DUPLICATE_PROVIDER_OR_REQUEST');throw e;}
  if(Number(results[0].meta?.changes)!==1) error('STALE_REVISION');
  return env.DB.prepare('SELECT * FROM transaction_orders WHERE id=?').bind(orderId).first();
}
