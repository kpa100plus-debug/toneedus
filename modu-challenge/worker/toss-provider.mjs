// Transport is restricted to an isolated test deployment and test credentials.
// No production switch enables this adapter in this release.
import {fail,aesKey,b64url,unurl} from './secure-data.mjs';
const enc=new TextEncoder(),dec=new TextDecoder(),root='https://api.tosspayments.com';
export function assertSandbox(env){if(env.APP_ENV!=='test'||env.PROVIDER_SANDBOX_ENABLED!=='true'||!/^test_sk_/.test(env.TOSS_SECRET_KEY||''))fail('PROVIDER_SANDBOX_NOT_CONFIGURED',503);}
export async function encryptJwe(body,hex){const header=b64url(enc.encode(JSON.stringify({alg:'dir',enc:'A256GCM',iat:new Date().toISOString(),nonce:crypto.randomUUID()})));const iv=crypto.getRandomValues(new Uint8Array(12));const raw=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(header),tagLength:128},await aesKey(hex),enc.encode(JSON.stringify(body))));return [header,'',b64url(iv),b64url(raw.slice(0,-16)),b64url(raw.slice(-16))].join('.');}
export async function decryptJwe(compact,hex){const p=compact.split('.');if(p.length!==5||p[1]!=='')fail('INVALID_PROVIDER_JWE');const header=JSON.parse(dec.decode(unurl(p[0])));if(header.alg!=='dir'||header.enc!=='A256GCM'||unurl(p[2]).length!==12||unurl(p[4]).length!==16)fail('INVALID_PROVIDER_JWE');const cipher=unurl(p[3]),tag=unurl(p[4]),joined=new Uint8Array(cipher.length+tag.length);joined.set(cipher);joined.set(tag,cipher.length);return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unurl(p[2]),additionalData:enc.encode(p[0]),tagLength:128},await aesKey(hex),joined)));}
async function call(env,path,{method='GET',body,key,encrypted=false}={}){
 assertSandbox(env);if(!/^\/(v1\/payments|v2\/(payouts|sellers|balances))(\/|$)/.test(path))fail('INVALID_PROVIDER_PATH');
 const headers={Authorization:'Basic '+btoa(env.TOSS_SECRET_KEY+':')};if(key){if(!/^[A-Za-z0-9_-]{16,100}$/.test(key))fail('IDEMPOTENCY_KEY_REQUIRED');headers['Idempotency-Key']=key}
 if(body!==undefined)headers['Content-Type']='application/json';
 if(encrypted)headers['TossPayments-api-security-mode']='ENCRYPTION';
 let r,data;try{r=await fetch(root+path,{method,headers,body:body===undefined?undefined:encrypted?await encryptJwe(body,env.TOSS_PAYOUT_SECURITY_KEY):JSON.stringify(body),signal:AbortSignal.timeout(10000)});const text=await r.text();data=encrypted?await decryptJwe(text,env.TOSS_PAYOUT_SECURITY_KEY):JSON.parse(text)}catch{fail('PROVIDER_OUTCOME_UNKNOWN',503)}
 if(!r.ok)throw Object.assign(new Error('PROVIDER_REJECTED'),{code:'PROVIDER_REJECTED',status:503,providerCode:/^[A-Z0-9_]{1,100}$/.test(data?.code||'')?data.code:'UNCLASSIFIED',uncertain:r.status>=500||r.status===429});return data;
}
const reference=s=>{if(typeof s!=='string'||!s||s.length>200)fail('INVALID_PROVIDER_REFERENCE',400);return encodeURIComponent(s)};
export const toss={
 getPayment:(env,paymentKey)=>call(env,'/v1/payments/'+reference(paymentKey)),
 confirm:(env,{paymentKey,orderId,amount,key})=>call(env,'/v1/payments/confirm',{method:'POST',body:{paymentKey,orderId,amount},key}),
 refund:(env,{paymentKey,amount,reason,key})=>call(env,'/v1/payments/'+reference(paymentKey)+'/cancel',{method:'POST',body:{cancelReason:reason,cancelAmount:amount,currency:'KRW'},key}),
 getSeller:async(env,id)=>{const r=await call(env,'/v2/sellers/'+reference(id));return r.entityBody||r},
 getPayout:async(env,id)=>{const r=await call(env,'/v2/payouts/'+reference(id));return r.entityBody||r},
 createSeller:(env,body,key)=>call(env,'/v2/sellers',{method:'POST',body,key,encrypted:true}),
 payout:async(env,{refPayoutId,sellerId,amount,key})=>{const r=await call(env,'/v2/payouts',{method:'POST',key,encrypted:true,body:[{refPayoutId,destination:sellerId,scheduleType:'EXPRESS',amount:{currency:'KRW',value:amount},transactionDescription:'모두클리어'}]});return r.entityBody?.items?.[0]},
};
export function verifyPayment(data,order,paymentKey){if(!data||data.paymentKey!==paymentKey||data.orderId!==order.id||data.totalAmount!==order.amount||data.currency!=='KRW')fail('PROVIDER_RESULT_MISMATCH');return data;}
export function verifyPayout(data,order,refPayoutId,sellerId){if(!data?.id||data.refPayoutId!==refPayoutId||data.destination!==sellerId||data.amount?.currency!=='KRW'||data.amount?.value!==order.net)fail('PROVIDER_RESULT_MISMATCH');return data;}
