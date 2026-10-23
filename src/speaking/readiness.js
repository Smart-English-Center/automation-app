export function assignedTeacherDocumentReadiness(data={}){
  const privateRows=Array.isArray(data.privateRows)?data.privateRows:[];
  const ieltsStudents=Array.isArray(data.ieltsStudents)?data.ieltsStudents:[];
  const pendingPrivate=privateRows.filter((row)=>row.status!=="READY");
  const ieltsRequired=ieltsStudents.length>0;
  const ieltsReady=!ieltsRequired||data.ielts?.status==="READY";
  return{
    ready:pendingPrivate.length===0&&ieltsReady,
    pending_private_target_ids:pendingPrivate.map((row)=>row.id),
    waiting_for_ielts:ieltsRequired&&!ieltsReady
  };
}
