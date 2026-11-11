import assert from 'node:assert/strict';
import type {Directory} from '../../server/src/platform/directory.js';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Real PostgreSQL row contention, correlated to this blocker's backend PID.
 * The lease row is unchanged while its wall-clock deadline passes. */
export async function expireLeaseDuringLock(directory:Directory,table:'environment_operations'|'lifecycle_jobs',tenant:string){
  assert.ok(['environment_operations','lifecycle_jobs'].includes(table));
  await directory.pool.query(`UPDATE ${table} SET lease_until=clock_timestamp()+interval '2 seconds' WHERE tenant_id=$1`,[tenant]);
  const blocker=await directory.pool.connect();await blocker.query('BEGIN');
  const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query(`SELECT id FROM ${table} WHERE tenant_id=$1 FOR UPDATE`,[tenant]);
  const released=(async()=>{
    let sawWait=false,expired=false;
    try{
      for(let n=0;n<200;n++){
        const row=await directory.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2 LIMIT 1",[pid,`SELECT%FROM ${table} %JOIN tenants%`]);
        if(row.rowCount){sawWait=true;break;}await sleep(10);
      }
      assert.equal(sawWait,true,'the real worker guard must wait on this exact blocker');
      await blocker.query(`SELECT pg_sleep(greatest(0,extract(epoch FROM lease_until-clock_timestamp()))::double precision+0.03) FROM ${table} WHERE tenant_id=$1`,[tenant]);
      expired=(await blocker.query(`SELECT lease_until<clock_timestamp() AS expired FROM ${table} WHERE tenant_id=$1`,[tenant])).rows[0].expired;
      assert.equal(expired,true,'release only after PostgreSQL confirms expiry');return {sawWait,expired};
    }finally{await blocker.query('COMMIT');blocker.release();}
  })();
  void released.catch(()=>{});return {released};
}
