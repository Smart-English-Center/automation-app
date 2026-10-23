import { runSpeakingPipelineOnce } from "../speaking/pipeline.js";
import { getSpeakingConfig } from "../speaking/config.js";

function clean(value){return String(value??"").trim();}
function authorised(req){const configured=clean(process.env.WORKER_ADMIN_SECRET||process.env.ADMIN_SECRET);const supplied=clean(req.get("x-worker-admin-secret")||req.query.secret||req.body?.secret);return Boolean(configured&&supplied===configured);}

export function registerSpeakingRoutes(app){
  app.get("/worker/speaking/config",(req,res)=>{
    if(!authorised(req))return res.status(401).json({ok:false,status:"UNAUTHORISED"});
    const config=getSpeakingConfig();return res.json({ok:true,config:{
      enabled:config.enabled,
      timezone:config.timezone,
      cycleCutoffTime:config.cycleCutoffTime,
      studentEmailTime:config.studentEmailTime,
      teacherDocumentTime:config.teacherDocumentTime,
      groupBatchSize:config.groupBatchSize,
      studentsPerPdfPart:config.studentsPerPdfPart,
      retryMinutes:config.retryMinutes,
      groupTeacherEmailsByLevel:Object.fromEntries(Object.entries(config.groupTeacherEmailsByLevel).map(([level,emails])=>[level,{configured:emails.length>0,recipient_count:emails.length}])),
      configuredGroupRecipientCount:config.groupTeacherEmails.length,
      usesLegacyGroupTeacherFallback:config.usesLegacyGroupTeacherFallback,
      profileFormConfigured:Boolean(config.profileFormUrl),
      pdfMonkeyTemplateConfigured:Boolean(config.pdfMonkeyTemplateId),
      driveFolderConfigured:Boolean(config.driveFolderId),
      model:config.model,
      thinkingMode:config.thinkingMode,
      reasoningEffort:config.reasoningEffort
    }});
  });
  app.post("/worker/speaking/run-once",async(req,res)=>{
    if(!authorised(req))return res.status(401).json({ok:false,status:"UNAUTHORISED"});
    if(clean(req.body?.confirm)!=="run-speaking-pipeline")return res.status(400).json({ok:false,status:"CONFIRMATION_REQUIRED",required:"run-speaking-pipeline"});
    try{return res.json(await runSpeakingPipelineOnce({force:Boolean(req.body?.force)}));}
    catch(error){return res.status(500).json({ok:false,error:clean(error.message||error),error_code:error.code||null,cycle_id:error.cycleId||null});}
  });
}
