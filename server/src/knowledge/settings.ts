import { db,now } from '../db.js';
import { expectedRevision,KnowledgeError,ownedBot } from './common.js';
import { assertWritable } from './access.js';
export const LEARNING_DEFAULTS={enabled:true,automaticReview:true,memoryReview:true,skillReview:true,memoryTurnInterval:10,skillIterationInterval:10,skillApproval:false,maxIterations:16,maxInputTokens:null as number|null,auxiliaryModel:null as string|null,auxiliaryProvider:null as string|null,curatorEnabled:true,curatorIntervalHours:168,curatorMinIdleHours:2,curatorStaleDays:14,curatorArchiveDays:30,curatorConsolidate:false};
export type LearningSettings=typeof LEARNING_DEFAULTS;
export function learningSettings(userId:string,botId?:string) {
  if(botId) ownedBot(userId,botId);
  const get=(id:string)=>db.prepare('SELECT * FROM knowledge_learning_settings WHERE user_id=? AND bot_id=?').get(userId,id) as any;
  const account=get(''), override=botId?get(botId):null;
  const accountSettings={...LEARNING_DEFAULTS,...JSON.parse(account?.settings??'{}')};
  return {settings:{...accountSettings,...JSON.parse(override?.settings??'{}')} as LearningSettings,account:accountSettings as LearningSettings,overrides:override?JSON.parse(override.settings):null,revision:botId?override?.revision??0:account?.revision??0,accountRevision:account?.revision??0,botId:botId??null};
}
export const settingsVersion=(userId:string,botId:string)=>{const s=learningSettings(userId,botId);return `${s.accountRevision}:${s.revision}`;};
export function patchLearningSettings(userId:string,input:{botId?:string;expectedRevision:number;settings:Partial<LearningSettings>}) {
  return db.transaction(()=>{
    if(input.botId) assertWritable(userId,input.botId);
    else {const bots=db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId) as any[];for(const b of bots)assertWritable(userId,b.id);}
    const cur=learningSettings(userId,input.botId);expectedRevision(cur.revision,input.expectedRevision);
    if(!input.settings||typeof input.settings!=='object'||Array.isArray(input.settings))throw new KnowledgeError('settings must be an object');
    const next:Record<string,unknown>=input.botId?(Object.keys(input.settings).length?{...cur.overrides}:{}): {...cur.account};
    for(const [k,v] of Object.entries(input.settings)){
      if(!(k in LEARNING_DEFAULTS))throw new KnowledgeError(`Unknown setting ${k}`);
      if(v===null && input.botId && !['maxInputTokens','auxiliaryModel','auxiliaryProvider'].includes(k)){delete next[k];continue;}
      const d=LEARNING_DEFAULTS[k as keyof LearningSettings];
      if(typeof d==='boolean' && typeof v!=='boolean')throw new KnowledgeError(`${k} must be boolean`);
      if(typeof d==='number' && (typeof v!=='number'||!Number.isFinite(v)||v<0||v>100000||k!=='curatorMinIdleHours'&&!Number.isSafeInteger(v)))throw new KnowledgeError(`Invalid ${k}`);
      if(k==='maxIterations' && (typeof v!=='number'||v<1||v>128))throw new KnowledgeError('maxIterations must be 1–128');
      if(k==='maxInputTokens'&&v!==null&&(!Number.isSafeInteger(v)||Math.abs(v as number)>10000000))throw new KnowledgeError('Invalid maxInputTokens');
      if(['auxiliaryModel','auxiliaryProvider'].includes(k)&&v!==null&&(typeof v!=='string'||!v.trim()||v.length>200))throw new KnowledgeError(`Invalid ${k}`);
      next[k]=v;
    }
    db.prepare('INSERT INTO knowledge_learning_settings(user_id,bot_id,revision,settings,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET revision=excluded.revision,settings=excluded.settings,updated_at=excluded.updated_at').run(userId,input.botId??'',cur.revision+1,JSON.stringify(next),now());
    return learningSettings(userId,input.botId);
  })();
}
