import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [mode,input,baseline]=process.argv.slice(2);
const data=JSON.parse(await readFile(input,'utf8'));
if(!Array.isArray(data)||data.length!==3||data.some(x=>x.success===false||!Array.isArray(x.results))) throw Error('Invalid D1 inventory');
const tables=['users','challenges','admin_roles'];
const inventory=Object.fromEntries(tables.map((table,i)=>[table,{count:data[i].results.length,sha256:createHash('sha256').update(JSON.stringify(data[i].results)).digest('hex')} ]));
if(mode==='before') {
 if(inventory.users.count<21||inventory.challenges.count<61) throw Error('Production counts below observed baseline. Stop and investigate.');
 await writeFile(baseline,JSON.stringify(inventory,null,2));
} else if(mode==='after') {
 const previous=JSON.parse(await readFile(baseline,'utf8'));
 if(JSON.stringify(previous)!==JSON.stringify(inventory)) throw Error('Membership, mission ownership or admin role inventory changed. Manual investigation required; no auto restore.');
} else throw Error('Expected before or after');
console.log(JSON.stringify({preservation:mode,tables:inventory}));
