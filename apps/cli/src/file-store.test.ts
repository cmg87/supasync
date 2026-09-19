import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.ts';
it('serializes concurrent snapshot/cache writes and preserves all values after reopening',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'supasync-store-'));const file=join(dir,'state.json');
 try{const store=new FileStore(file);await Promise.all(Array.from({length:30},(_,i)=>store.putCache(`item-${i}`,i)));const reopened=new FileStore(file);for(let i=0;i<30;i++)expect(await reopened.getCache(`item-${i}`)).toBe(i);}
 finally{await rm(dir,{recursive:true,force:true});}
});
it('fails on corrupted state rather than silently resetting identity or outbox',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'supasync-store-'));const file=join(dir,'state.json');
 try{await writeFile(file,'{broken');await expect(new FileStore(file).getMeta()).rejects.toThrow();}finally{await rm(dir,{recursive:true,force:true});}
});
