import { runSpeakingPipelineOnce } from "../src/speaking/pipeline.js";
import { closeSupabasePool } from "../src/supabase/client.js";

try {
  const result=await runSpeakingPipelineOnce();
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.ok===false?1:0;
} catch(error) {
  console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error),error_code:error.code||null,cycle_id:error.cycleId||null},null,2));
  process.exitCode=1;
} finally { await closeSupabasePool(); }
