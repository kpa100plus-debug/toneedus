const enc=new TextEncoder(),dec=new TextDecoder();
export function fail(code,status=409){throw Object.assign(new Error(code),{code,status});}
export const hexKey=key=>typeof key==='string'&&/^[a-fA-F0-9]{64}$/.test(key);
export const b64=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s)};
export const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export const b64url=bytes=>b64(bytes).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
export const unurl=s=>unb64(s.replace(/-/g,'+').replace(/_/g,'/'));
export async function aesKey(hex){if(!hexKey(hex))fail('ENCRYPTION_KEY_REQUIRED',503);return crypto.subtle.importKey('raw',Uint8Array.from(hex.match(/../g),x=>parseInt(x,16)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function seal(value,hex,aad){const iv=crypto.getRandomValues(new Uint8Array(12));const out=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(aad)},await aesKey(hex),enc.encode(JSON.stringify(value)));return b64url(iv)+'.'+b64url(new Uint8Array(out));}
export async function unseal(value,hex,aad){const [iv,data]=value.split('.');return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unurl(iv),additionalData:enc.encode(aad)},await aesKey(hex),unurl(data))));}
export async function sha(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function limitedJson(request,max=768*1024){
 if(!request.headers.get('content-type')?.includes('application/json'))fail('JSON_REQUIRED',415);
 if(Number(request.headers.get('content-length'))>max)fail('PAYLOAD_TOO_LARGE',413);
 const reader=request.body?.getReader();if(!reader)fail('INVALID_JSON',400);
 const chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();fail('PAYLOAD_TOO_LARGE',413)}chunks.push(value)}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
 try{const data=JSON.parse(dec.decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))fail('INVALID_JSON',400);return data}catch{fail('INVALID_JSON',400)}
}
