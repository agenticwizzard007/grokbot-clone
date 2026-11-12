import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseEvent } from '../messaging/inkbox/events.js';
const quote=(s:string)=>`"${s.replaceAll('"','""')}"`;
const OMIT=new Set(['server_settings','auth_sessions','login_attempts','google_oidc_attempts','apple_login_attempts','openrouter_login_attempts','native_login_attempts','composio_sessions','companion_tokens','cli_pairings','mcp_oauth_attempts','account_roles','tenant_identity','legacy_owner_fences','phone_logins','login_tokens','messaging_codes','messaging_claims','local_computer_access','vms','computers','screens','provision_jobs']);
// Search indexes contain cross-account derived text. Rebuild from the exported
// owned rows on first startup; never copy FTS shadow pages or its backfill marker.
const DERIVED=new Set(['knowledge_migrations','knowledge_messages_fts','knowledge_messages_fts_data','knowledge_messages_fts_idx','knowledge_messages_fts_content','knowledge_messages_fts_docsize','knowledge_messages_fts_config']);
interface Table {name:string;sql:string;columns:{name:string;pk:number}[];foreign:{table:string;from:string;to:string}[]}
/** Offline export from an operator-created snapshot. Unknown ownership is an error, never a copy-all default. */
export async function exportTenantDatabase(sourceFile:string,destination:string,tenant:string,volumeId:string) {
  if(fs.existsSync(destination))throw new Error('Export destination already exists.');
  const source=new Database(sourceFile,{readonly:true,fileMustExist:true});
  const temporary=`${destination}.partial`;
  let target:Database.Database|undefined;
  try{
    if(!source.prepare('SELECT 1 FROM users WHERE id=?').get(tenant))throw new Error('Tenant does not exist.');
    const tables=(source.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string;sql:string}[])
      .filter(t=>!DERIVED.has(t.name))
      .map(t=>({...t,columns:source.prepare(`PRAGMA table_info(${quote(t.name)})`).all() as Table['columns'],foreign:source.prepare(`PRAGMA foreign_key_list(${quote(t.name)})`).all() as Table['foreign']}));
    const selected=new Map<string,Record<string,any>[]>() ,pending=new Set(tables.filter(t=>!OMIT.has(t.name)).map(t=>t.name));
    let changed=true;
    while(changed&&pending.size){
      changed=false;
      for(const t of tables){
        if(!pending.has(t.name))continue;
        let rows:Record<string,any>[]|undefined;
        if(t.name==='users')rows=source.prepare('SELECT * FROM users WHERE id=?').all(tenant) as any[];
        else if(t.name==='messaging_inbox'&&selected.has('users')){
          const phone=selected.get('users')![0]?.phone;
          rows=[];
          for(const row of source.prepare('SELECT * FROM messaging_inbox').iterate() as Iterable<Record<string,any>>){
            if(row.source!=='inkbox')throw new Error('Unknown inbox ownership requires reconciliation.');
            const event=parseEvent(JSON.parse(row.payload));
            if(!event)throw new Error('Unmapped inbox event requires reconciliation.');
            if(event.phone===phone)rows.push(row);
          }
        }else if(t.name==='messaging_greeted'&&selected.has('users'))rows=source.prepare('SELECT * FROM messaging_greeted WHERE phone=?').all(selected.get('users')![0]?.phone??'') as any[];
        else if(t.columns.some(c=>c.name==='user_id'))rows=source.prepare(`SELECT * FROM ${quote(t.name)} WHERE user_id=?`).all(tenant) as any[];
        else if(t.columns.some(c=>c.name==='bot_id')&&selected.has('bots')){
          const ids=selected.get('bots')!.map(r=>r.id);rows=ids.length?source.prepare(`SELECT * FROM ${quote(t.name)} WHERE bot_id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as any[]:[];
        }else if(t.foreign.length&&t.foreign.every(f=>selected.has(f.table)||OMIT.has(f.table)||f.table===t.name)){
          const parents=t.foreign.filter(f=>selected.has(f.table));
          const all=source.prepare(`SELECT * FROM ${quote(t.name)}`).all() as any[];
          rows=all.filter(row=>parents.some(f=>row[f.from]!==null&&selected.get(f.table)!.some(parent=>parent[f.to||'id']===row[f.from])));
        }else if(!(source.prepare(`SELECT 1 FROM ${quote(t.name)} LIMIT 1`).get()))rows=[];
        if(rows){selected.set(t.name,rows);pending.delete(t.name);changed=true;}
      }
    }
    if(pending.size)throw new Error(`Ownership mapping required for: ${[...pending].join(', ')}`);
    // Older schemas encode important relationships in plain columns and room
    // JSON rather than foreign keys. Validate both outgoing and incoming edges;
    // omitting a foreign row that points into this account would conceal damage.
    const ownedBots=new Set((selected.get('bots')??[]).map(row=>row.id));
    const userRefs=['user_id','provisional_user_id','link_user_id','attach_user_id','created_by'];
    const botRefs=['bot_id','parent_bot_id','active_bot_id','from_bot_id','to_bot_id'];
    const phone=selected.get('users')?.[0]?.phone;
    if(phone&&Number((source.prepare('SELECT count(*) n FROM users WHERE phone=?').get(phone) as {n:number}).n)!==1)throw new Error('Ambiguous legacy phone ownership.');
    for(const t of tables){
      if(OMIT.has(t.name))continue;
      const included=new Set((selected.get(t.name)??[]).map(row=>JSON.stringify(row)));
      const users=userRefs.filter(name=>t.columns.some(c=>c.name===name)),bots=botRefs.filter(name=>t.columns.some(c=>c.name===name));
      const rooms=t.name==='bots'&&t.columns.some(c=>c.name==='members');
      if(!users.length&&!bots.length&&!rooms)continue;
      for(const row of source.prepare(`SELECT * FROM ${quote(t.name)}`).iterate() as Iterable<Record<string,any>>){
        const selectedRow=included.has(JSON.stringify(row));
        const userValues=users.map(name=>row[name]).filter(value=>value!==null&&value!==undefined&&value!=='');
        const botValues=bots.map(name=>row[name]).filter(value=>value!==null&&value!==undefined&&value!=='');
        if(rooms&&row.members!==null&&row.members!==undefined){
          let members:unknown;try{members=JSON.parse(row.members);}catch{throw new Error('Invalid legacy room membership.');}
          if(!Array.isArray(members)||members.some(id=>typeof id!=='string'||!id)||new Set(members).size!==members.length)throw new Error('Invalid legacy room membership.');
          botValues.push(...members);
        }
        if(selectedRow&&(userValues.some(value=>value!==tenant)||botValues.some(value=>!ownedBots.has(value))))throw new Error(`Foreign or unproven implicit relationship in ${t.name}`);
        if(!selectedRow&&(userValues.includes(tenant)||botValues.some(value=>ownedBots.has(value))))throw new Error(`Foreign or ambiguous implicit relationship in ${t.name}`);
      }
    }
    // A join row can refer to an owned room and a foreign bot. Selecting only by
    // bot_id would silently drop it and conceal an invalid ownership relationship.
    for (const t of tables) {
      if (OMIT.has(t.name)) continue;
      const parents=t.foreign.filter(f=>selected.has(f.table)).map(f=>({field:f.from,values:new Set(selected.get(f.table)!.map(r=>r[f.to||'id']))}));
      if (!parents.length) continue;
      const included=new Set((selected.get(t.name)??[]).map(r=>JSON.stringify(r)));
      for (const row of source.prepare(`SELECT * FROM ${quote(t.name)}`).iterate() as Iterable<Record<string,unknown>>) {
        if(parents.some(p=>row[p.field]!=null&&p.values.has(row[p.field]))&&!included.has(JSON.stringify(row)))throw new Error(`Foreign or ambiguous ownership relationship in ${t.name}`);
      }
    }
    // Relationships in selected records must never point at another tenant's omitted data.
    for(const t of tables)for(const row of selected.get(t.name)??[])for(const f of t.foreign){
      if(row[f.from]===null||row[f.from]===undefined)continue;
      if(!selected.get(f.table)?.some(parent=>parent[f.to||'id']===row[f.from]))throw new Error(`Foreign or unproven ownership in ${t.name}.${f.from}`);
    }
    fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
    target=new Database(temporary);target.pragma('foreign_keys=OFF');
    target.transaction(()=>{
      for(const t of tables){if(/CREATE VIRTUAL TABLE/i.test(t.sql))throw new Error('Virtual tables require an explicit migration.');target!.exec(t.sql);}
      for(const t of tables){
        const rows=selected.get(t.name)??[];if(!rows.length)continue;
        const columns=t.columns.map(c=>c.name),insert=target!.prepare(`INSERT INTO ${quote(t.name)}(${columns.map(quote)}) VALUES(${columns.map(()=>'?').join(',')})`);
        for(const row of rows)insert.run(...columns.map(c=>row[c]));
      }
      for(const entry of source.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as {tbl_name:string;sql:string}[])if(!DERIVED.has(entry.tbl_name))target!.exec(entry.sql);
      target!.exec('CREATE TABLE IF NOT EXISTS tenant_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),tenant_id TEXT NOT NULL)');
      target!.prepare('INSERT INTO tenant_identity VALUES(1,?)').run(tenant);
    })();
    if((target.pragma('foreign_key_check') as unknown[]).length)throw new Error('Export contains broken relationships.');
    if((target.pragma('integrity_check') as any[])[0]?.integrity_check!=='ok')throw new Error('Export integrity check failed.');
    const counts=Object.fromEntries([...selected].map(([name,rows])=>[name,rows.length]));
    target.close();target=undefined;fs.chmodSync(temporary,0o600);fs.renameSync(temporary,destination);
    const manifest={version:1,tenantId:tenant,volumeId,counts,omitted:[...OMIT].filter(name=>tables.some(t=>t.name===name)),sha256:createHash('sha256').update(fs.readFileSync(destination)).digest('hex'),requiresCredentialRewrap:true,requiresFileInventory:true};
    fs.writeFileSync(`${destination}.manifest.json`,JSON.stringify(manifest,null,2),{mode:0o600});
    return manifest;
  }catch(e){target?.close();fs.rmSync(temporary,{force:true});throw e;}finally{source.close();}
}
