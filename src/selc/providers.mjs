import {need,content} from './core.mjs';
import {getGoogleDriveAccessToken} from '../google/driveClient.js';
import {storeSelcAudio} from './selcAudioDownloader.mjs';
export async function requestJson(url,options={},timeoutMs=120000){const response=await fetch(url,{...options,signal:AbortSignal.timeout(timeoutMs)});const text=await response.text();let result;try{result=JSON.parse(text);}catch{throw Error('PROVIDER_NON_JSON:'+response.status);}if(!response.ok)throw Error('PROVIDER_HTTP:'+response.status);return result;}
export function parseModelJson(value){if(value&&typeof value==='object')return value;const text=String(value||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');return JSON.parse(text);}
export const modelFor=task=>process.env[{writing:'DEEPSEEK_WRITING_MODEL',review:'DEEPSEEK_REVIEW_MODEL',topics:'DEEPSEEK_TOPICS_MODEL',digest:'DEEPSEEK_DIGEST_MODEL',audio:'OPENAI_SPEAKING_AUDIO_MODEL',transcription:'OPENAI_TRANSCRIPTION_MODEL'}[task]]?.trim()||(task==='audio'?'openai/gpt-audio-mini':task==='transcription'?'openai/gpt-4o-transcribe':process.env.DEEPSEEK_MODEL?.trim()||'deepseek/deepseek-v4-pro');
export async function chat({task,prompt,input,audio,fetchJson=requestJson}){
 const primary=modelFor(task),fallback=task==='audio'?process.env.OPENAI_SPEAKING_AUDIO_FALLBACK_MODEL?.trim():'';
 const models=[...new Set([primary,...(fallback?[fallback]:[])])];
 const url=(process.env.OPENROUTER_BASE_URL||'https://openrouter.ai/api/v1').replace(/\/+$/,'')+'/chat/completions';
 for(let i=0;i<models.length;i++){
  const model=models[i],text={type:'text',text:JSON.stringify(input)};
  const body={model,messages:[{role:'system',content:prompt},{role:'user',content:audio?[text,{type:'input_audio',input_audio:{data:audio.toString('base64'),format:'wav'}}]:JSON.stringify(input)}],provider:{allow_fallbacks:false}};
  if(model.startsWith('deepseek/'))body.reasoning=process.env.DEEPSEEK_THINKING_MODE==='disabled'?{enabled:false}:{effort:process.env.DEEPSEEK_REASONING_EFFORT||'high',exclude:true};
  const headers={Authorization:'Bearer '+need('OPENROUTER_API_KEY'),'Content-Type':'application/json','X-Title':process.env.OPENROUTER_APP_NAME||'Smart English Learning Center'};
  try{const data=await fetchJson(url,{method:'POST',headers,body:JSON.stringify(body)},180000);return {output:parseModelJson(data.choices?.[0]?.message?.content),model,provider:'openrouter'};}
  catch(error){if(i===models.length-1)throw error;}
 }
}
export async function transcribe(audio){
 const model=modelFor('transcription');
 const result=await requestJson((process.env.OPENROUTER_BASE_URL||'https://openrouter.ai/api/v1').replace(/\/+$/,'')+'/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+need('OPENROUTER_API_KEY'),'Content-Type':'application/json'},body:JSON.stringify({model,input_audio:{data:audio.toString('base64'),format:'wav'},language:'en'})});
 if(!result.text?.trim())throw Error('TRANSCRIPT_EMPTY');return {text:result.text,model};
}
export async function generateDriveId(){const token=await getGoogleDriveAccessToken();const result=await requestJson('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files',{headers:{Authorization:'Bearer '+token}});if(!result.ids?.[0])throw Error('DRIVE_ID_MISSING');return result.ids[0];}
export async function downloadAudio(pool,{asset,submission}){
 const result=await storeSelcAudio({withClient:async callback=>{const db=await pool.connect();try{return await callback(db);}finally{db.release();}},generateId:generateDriveId,sourceHash:(await import('./core.mjs')).hash(asset.canonical_source_url),sourceUrl:asset.canonical_source_url,filename:'SELC '+submission.student_name_snapshot+' '+submission.assignment_title,audioId:asset.id,submissionId:submission.id,url:need('APPS_SCRIPT_AUDIO_DOWNLOADER_URL'),secret:need('APPS_SCRIPT_AUDIO_DOWNLOADER_SECRET')});
 return result;
}
