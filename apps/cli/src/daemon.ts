import { runDaemon } from '../../daemon/src/main.ts';
runDaemon().catch(()=>{console.error('SupaSync daemon could not start; run supasync doctor');process.exitCode=1;});
