import {reserveAudioDriveId} from './audioDriveReservation.mjs';
// Adapter for the SELC worker. Call only AFTER the normal source ownership check.
// withClient must use an independent, autocommit connection for the reservation.
export async function storeSelcAudio({withClient,generateId,sourceHash,sourceUrl,filename,audioId,submissionId,url,secret,fetchImpl=fetch}) {
 if(!url||!secret)throw Error('Apps Script downloader configuration missing');
 const id=await withClient(client=>reserveAudioDriveId(client,{namespace:'SELC',sourceHash,generateId}));
 const response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,source_url:sourceUrl,filename,audio_id:audioId,submission_id:submissionId,drive_file_id:id,download_key:sourceHash})});
 const result=await response.json();
 if(!response.ok||!result.ok)throw Error(result.error||'Apps Script audio download failed');
 if(result.drive_file_id!==id)throw Error('Apps Script returned a different audio identity');
 return result;
}
