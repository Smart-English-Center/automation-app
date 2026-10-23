// Must run on an independent, autocommit connection before the HTTP download.
// Never put this insert inside the outer storage transaction: its rollback
// must not erase the reserved ID when Apps Script may already have saved audio.
export async function reserveAudioDriveId(client,{namespace,sourceHash,generateId}) {
 if(!['JEA','SELC'].includes(namespace)||!/^[0-9a-f]{64}$/.test(sourceHash))throw Error('Invalid audio reservation identity');
 const args=[namespace,sourceHash];
 const existing=await client.query('select drive_file_id from public.audio_drive_reservations where app_namespace=$1 and source_hash=$2',args);
 if(existing.rows[0])return existing.rows[0].drive_file_id;
 const id=await generateId();if(typeof id!=='string'||!id.trim())throw Error('No Drive file ID generated');
 // DO NOTHING + a subsequent SELECT also handles simultaneous first requests
 // without granting UPDATE permission or replacing the first reservation.
 await client.query('insert into public.audio_drive_reservations(app_namespace,source_hash,drive_file_id) values($1,$2,$3) on conflict(app_namespace,source_hash) do nothing',[...args,id]);
 const result=await client.query('select drive_file_id from public.audio_drive_reservations where app_namespace=$1 and source_hash=$2',args);
 if(!result.rows[0])throw Error('Audio reservation not persisted');
 return result.rows[0].drive_file_id;
}
