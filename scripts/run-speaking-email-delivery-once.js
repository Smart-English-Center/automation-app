import { runStudentEmailDeliveryOnce } from "../src/studentEmailDeliveryWorker.js";
import { closeSupabasePool } from "../src/supabase/client.js";

try {
  const result=await runStudentEmailDeliveryOnce({
    sourceTypes:["SPEAKING_GROUP_TOPICS","SPEAKING_PROFILE_REMINDER","SPEAKING_TEACHER_MATERIALS"],
    queueBeforeSend:false,
    limit:Number(process.env.SPEAKING_EMAIL_DELIVERY_LIMIT||25)
  });
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.ok===false?1:0;
} catch(error) {
  console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)},null,2));
  process.exitCode=1;
} finally { await closeSupabasePool(); }
