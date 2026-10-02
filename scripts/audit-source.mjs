import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).trim().split('\n').filter(Boolean))];
const allowed=new Set(['.ts','.js','.mjs','.json','.html','.css','.md','.yml','.yaml','.txt']);
function check(data,label){
 if(data.includes(0)) throw new Error(`Binary content: ${label}`);
 const text=data.toString('utf8');
 if(/data:(?:image|audio|video|application\/octet-stream)[^,]*;base64,/i.test(text)) throw new Error(`Embedded media: ${label}`);
 if(/[A-Za-z0-9+/]{2048,}={0,2}/.test(text)) throw new Error(`Packed payload: ${label}`);
}
for(const file of files){
 if(!allowed.has(extname(file))&&!['LICENSE','NOTICE','.gitignore','.gitattributes'].includes(file)) throw new Error(`Unexpected file type: ${file}`);
 check(readFileSync(file),file);
}
// Audit reachable history, not just the current working tree.
const objects=execFileSync('git',['rev-list','--objects','--all'],{encoding:'utf8'}).trim().split('\n');
for(const entry of objects){
 const [id,...path]=entry.split(' ');
 if(execFileSync('git',['cat-file','-t',id],{encoding:'utf8'}).trim()==='blob') check(execFileSync('git',['cat-file','blob',id]),path.join(' '));
}
console.log(`PASS: ${files.length} text files; reachable Git history has no binary files or packed media payloads.`);
