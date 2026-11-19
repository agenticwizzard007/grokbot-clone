import type Database from 'better-sqlite3';
import { legacyWritableRows } from '../platform/legacy-database-fence.js';

// Installed after the knowledge schema. Entries commit with their source write;
// no model, scheduler, or asynchronous consumer can lose an accepted change.
export function installEvolutionHistory(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_evolution (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, source_key TEXT NOT NULL,
    kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision TEXT,
    action TEXT NOT NULL, actor TEXT, reason TEXT, run_id TEXT,
    before_snapshot TEXT, after_snapshot TEXT, evidence TEXT NOT NULL DEFAULT '[]',
    occurred_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('recorded','historical','baseline')),
    PRIMARY KEY(bot_id,version), UNIQUE(bot_id,source_key));
    CREATE INDEX IF NOT EXISTS agent_evolution_owner ON agent_evolution(user_id,bot_id,version);
    CREATE TRIGGER IF NOT EXISTS agent_evolution_immutable BEFORE UPDATE ON agent_evolution
      BEGIN SELECT RAISE(ABORT,'Agent history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_evolution_no_replace BEFORE INSERT ON agent_evolution
      WHEN EXISTS(SELECT 1 FROM agent_evolution WHERE bot_id=NEW.bot_id AND (version=NEW.version OR source_key=NEW.source_key))
      BEGIN SELECT RAISE(ABORT,'Agent history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_evolution_no_delete BEFORE DELETE ON agent_evolution
      WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) AND EXISTS(SELECT 1 FROM bots WHERE id=OLD.bot_id)
      BEGIN SELECT RAISE(ABORT,'Agent history is immutable'); END;`);

  const clock = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
  const fields = ['bot', 'key', 'kind', 'id', 'revision', 'action', 'actor', 'reason', 'run', 'before', 'after', 'evidence', 'time'] as const;
  type Values = Record<typeof fields[number], string>;
  const values = (v: Partial<Values> & Pick<Values, 'bot'|'key'|'kind'|'id'|'action'|'after'>): Values => ({
    revision: 'NULL', actor: 'NULL', reason: 'NULL', run: 'NULL', before: 'NULL', evidence: "'[]'", time: clock, ...v,
  });
  const insert = (v: Values, origin: string, condition='1') => `INSERT INTO agent_evolution
    (user_id,bot_id,version,source_key,kind,source_id,source_revision,action,actor,reason,run_id,before_snapshot,after_snapshot,evidence,occurred_at,recorded_at,origin)
    SELECT b.user_id,b.id,COALESCE((SELECT MAX(version) FROM agent_evolution WHERE bot_id=b.id),0)+1,
      ${[v.key,v.kind,v.id,v.revision,v.action,v.actor,v.reason,v.run,v.before,v.after,v.evidence,v.time,clock,`'${origin}'`].join(',')}
    FROM bots b WHERE b.id=${v.bot} AND (${condition}) AND NOT EXISTS(SELECT 1 FROM agent_evolution WHERE bot_id=b.id AND source_key=${v.key});`;
  const historical: {table:string; v:Values; order:string}[] = [];
  const immutable = (table:string, v:Values, order='created_at') => {
    historical.push({table,v,order});
    db.exec(`CREATE TRIGGER IF NOT EXISTS evolution_${table}_insert AFTER INSERT ON ${table}
      BEGIN ${insert(v,'recorded')} END;`);
  };
  immutable('knowledge_skill_revisions',values({bot:'NEW.bot_id',key:"'skill:'||NEW.skill_id||':'||NEW.revision",kind:"'skill'",id:'NEW.skill_id',revision:'NEW.revision',action:'NEW.action',actor:'NEW.actor',run:'NEW.run_id',after:'NEW.snapshot',evidence:'NEW.evidence',time:'NEW.created_at',before:'(SELECT snapshot FROM knowledge_skill_revisions WHERE skill_id=NEW.skill_id AND revision<NEW.revision ORDER BY revision DESC LIMIT 1)'}),'created_at,skill_id,revision');
  immutable('knowledge_memory_events',values({bot:'NEW.bot_id',key:"'memory-event:'||NEW.id",kind:"'memory'",id:'NEW.memory_id',revision:"json_extract(NEW.snapshot,'$.revision')",action:'NEW.action',actor:'NEW.actor',run:"json_extract(NEW.snapshot,'$.runId')",after:'NEW.snapshot',evidence:"COALESCE(json_extract(NEW.snapshot,'$.evidence'),'[]')",time:'NEW.created_at',before:'(SELECT snapshot FROM knowledge_memory_events WHERE memory_id=NEW.memory_id AND id<NEW.id ORDER BY id DESC LIMIT 1)'}),'created_at,id');
  immutable('knowledge_promotion_policies',values({bot:'NEW.bot_id',key:"'policy:'||NEW.skill_id||':'||NEW.revision",kind:"'promotion-policy'",id:'NEW.skill_id',revision:'NEW.revision',action:"'policy-updated'",actor:'NEW.actor',after:'NEW.snapshot',time:'NEW.created_at',before:'(SELECT snapshot FROM knowledge_promotion_policies WHERE skill_id=NEW.skill_id AND revision<NEW.revision ORDER BY revision DESC LIMIT 1)'}),'created_at,skill_id,revision');
  immutable('knowledge_skill_evaluations',values({bot:'NEW.bot_id',key:"'evaluation:'||NEW.id",kind:"'evaluation'",id:'NEW.proposal_id',revision:'NEW.policy_revision',action:'NEW.status',actor:'NEW.evaluator',reason:'NEW.reason',after:"json_object('results',json(NEW.results),'candidateHash',NEW.candidate_hash,'baselineHash',NEW.base_hash,'evaluator',NEW.evaluator)",time:'NEW.created_at'}));
  immutable('knowledge_skill_regressions',values({bot:'NEW.bot_id',key:"'regression:'||NEW.id",kind:"'regression-check'",id:'NEW.skill_id',revision:'NEW.revision',action:'NEW.action',reason:'NEW.reason',after:"json_object('checks',json(NEW.checks),'rollbackRevision',NEW.rollback_revision,'policyRevision',NEW.policy_revision)",time:'NEW.created_at'}));
  const lifecycle=values({bot:'NEW.bot_id',key:"'lifecycle:'||NEW.id||':'||lower(hex(randomblob(16)))",kind:"'skill-lifecycle'",id:'NEW.id',revision:'NEW.revision',action:'NEW.lifecycle',before:"json_object('lifecycle',OLD.lifecycle)",after:"json_object('lifecycle',NEW.lifecycle)"});
  db.exec(`CREATE TRIGGER IF NOT EXISTS evolution_skill_lifecycle AFTER UPDATE OF lifecycle ON skills WHEN OLD.lifecycle IS NOT NEW.lifecycle BEGIN ${insert(lifecycle,'recorded')} END;`);
  const settings=values({bot:'b.id',key:"'settings:'||NEW.bot_id||':'||NEW.revision",kind:"'learning-settings'",id:"CASE WHEN NEW.bot_id='' THEN 'account-defaults' ELSE NEW.bot_id END",revision:'NEW.revision',action:"'settings-updated'",after:'NEW.settings',time:'NEW.updated_at'});
  const settingsOwner="b.user_id=NEW.user_id AND (NEW.bot_id='' OR b.id=NEW.bot_id)";
  db.exec(`CREATE TRIGGER IF NOT EXISTS evolution_learning_settings_insert AFTER INSERT ON knowledge_learning_settings BEGIN ${insert(settings,'recorded',settingsOwner)} END;
    CREATE TRIGGER IF NOT EXISTS evolution_learning_settings_update AFTER UPDATE OF revision ON knowledge_learning_settings WHEN OLD.revision!=NEW.revision BEGIN ${insert({...settings,before:'OLD.settings'},'recorded',settingsOwner)} END;`);

  for (const [table,kind,snapshot,actor,reason] of [
    ['knowledge_skill_proposals','skill-proposal','NEW.snapshot','NEW.actor','NEW.reason'],
    ['knowledge_memory_changes','memory-proposal',"json_object('text',NEW.text,'target',NEW.target,'action',NEW.action)",'NULL','NULL'],
  ]) {
    const v=values({bot:'NEW.bot_id',key:`'${kind}:'||NEW.id||':pending'`,kind:`'${kind}'`,id:'NEW.id',revision:'NEW.base_revision',action:"'pending'",actor,reason,run:'NEW.run_id',after:snapshot,evidence:'NEW.evidence',time:'NEW.created_at',before:kind==='skill-proposal'?'(SELECT snapshot FROM knowledge_skill_revisions WHERE skill_id=NEW.skill_id AND revision=NEW.base_revision)':'(SELECT snapshot FROM knowledge_memory_events WHERE memory_id=NEW.memory_id AND json_extract(snapshot,\'$.revision\')=NEW.base_revision ORDER BY id DESC LIMIT 1)'});
    immutable(table,v);
      const resolution={...v,key:`'${kind}:'||NEW.id||':'||NEW.status`,action:'NEW.status',time:'NEW.resolved_at',actor:kind==='skill-proposal'?'NEW.resolved_by':'NULL'};
    historical.push({table,v:resolution,order:'resolved_at,id'});
    db.exec(`CREATE TRIGGER IF NOT EXISTS evolution_${table}_resolve AFTER UPDATE OF status ON ${table}
      WHEN OLD.status!=NEW.status AND NEW.status!='pending'
      BEGIN ${insert(resolution,'recorded')} END;`);
  }

  // Configuration has no complete older ledger. Capture an honest current
  // baseline and all subsequent changes, without inventing earlier revisions.
  for (const [table,id,kind,columns] of [
    ['bots','id','profile',['name','label','description','instructions','model']],
    ['bot_setups','bot_id','setup',['brief','onboarding_status','revision']],
  ] as const) {
    const snapshot=(alias:string)=>`json_object(${columns.flatMap(c=>[`'${c}'`,`${alias}.${c}`]).join(',')})`;
    const v=values({bot:`NEW.${id}`,key:`'${kind}:'||lower(hex(randomblob(16)))`,kind:`'${kind}'`,id:`NEW.${id}`,action:"'updated'",after:snapshot('NEW')});
    db.exec(`CREATE TRIGGER IF NOT EXISTS evolution_${kind}_insert AFTER INSERT ON ${table} BEGIN ${insert({...v,action:"'created'"},'recorded')} END;
      CREATE TRIGGER IF NOT EXISTS evolution_${kind}_update AFTER UPDATE OF ${columns.join(',')} ON ${table}
      WHEN ${columns.map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR ')}
      BEGIN ${insert({...v,before:snapshot('OLD')},'recorded')} END;`);
    historical.push({table,v:{...v,key:`'${kind}:baseline'`,action:"'baseline'",reason:"'Current configuration when history tracking started; earlier changes may be unavailable.'"},order:id});
  }
  historical.push({table:'memories',order:'created_at,id',v:values({bot:'NEW.bot_id',key:"'memory-baseline:'||NEW.id",kind:"'memory'",id:'NEW.id',revision:'NEW.revision',action:"'baseline'",reason:"'Current memory when tracking started; no earlier retained memory event is available.'",after:"json_object('id',NEW.id,'text',NEW.text,'revision',NEW.revision,'status',NEW.status,'target',NEW.target,'scope',NEW.scope,'evidence',json(NEW.evidence))",evidence:'NEW.evidence'})});

  // Backfill only retained evidence. Reads do not perform this migration, and
  // migration-held owners remain untouched. Stable keys make restart idempotent.
  db.transaction(()=>{
    const write=db.prepare(`INSERT INTO agent_evolution
      (user_id,bot_id,version,source_key,kind,source_id,source_revision,action,actor,reason,run_id,before_snapshot,after_snapshot,evidence,occurred_at,recorded_at,origin)
      SELECT user_id,id,COALESCE((SELECT MAX(version) FROM agent_evolution WHERE bot_id=bots.id),0)+1,
      @key,@kind,@id,@revision,@action,@actor,@reason,@run,@before,@after,@evidence,@time,${clock},@origin FROM bots WHERE id=@bot
      AND NOT EXISTS(SELECT 1 FROM agent_evolution WHERE bot_id=@bot AND source_key=@key)`);
    const capturedAt=Date.now();
    const parts=historical.map(({table,v})=>{
      const sql=fields.map(k=>`${v[k]===clock?capturedAt:v[k]} AS "${k}"`).join(',');
      const resolved=v.time==='NEW.resolved_at';
      const baseline=v.action==="'baseline'";
      return `SELECT ${sql},'${baseline?'baseline':'historical'}' AS origin FROM (SELECT * FROM ${table} WHERE (${legacyWritableRows(db,table)})) AS NEW ${resolved?"WHERE resolved_at IS NOT NULL AND status!='pending'":''}`;
    });
    const read=db.prepare(`SELECT * FROM (${parts.join(' UNION ALL ')}) candidate
      WHERE NOT EXISTS(SELECT 1 FROM agent_evolution WHERE bot_id=candidate.bot AND source_key=candidate.key)
      AND (origin!='baseline' OR NOT EXISTS(SELECT 1 FROM agent_evolution WHERE bot_id=candidate.bot AND kind=candidate.kind AND source_id=candidate.id))
      ORDER BY time,key LIMIT 50`);
    for(;;) {
      const rows=read.all() as Record<string,any>[];
      for(const row of rows) {
        write.run({...row,revision:row.revision===null?null:String(row.revision)});
      }
      if(rows.length<50)break;
    }
  })();
}
