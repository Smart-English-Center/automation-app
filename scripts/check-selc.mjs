import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const root=process.cwd();let count=0;
for(const name of fs.readdirSync(path.join(root,'src/selc'))){if(!name.endsWith('.mjs'))continue;const file=path.join(root,'src/selc',name),result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status){process.stderr.write(result.stderr);process.exit(1);}count++;}
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.name==='node_modules'||e.name==='.git'?[]:e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const scripts=walk(root).filter(f=>f.endsWith('.gs')||path.basename(f)==='appsscript.json');if(scripts.length)throw Error('Apps Script source must be excluded from backend');
console.log(JSON.stringify({ok:true,selcModulesChecked:count,appsScriptFilesInBackend:0}));
