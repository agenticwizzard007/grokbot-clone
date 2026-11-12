import { db } from '../db.js';
import { sha256 } from '../lib/ids.js';
import { ownedBot } from '../knowledge/common.js';
import { authorizedMemories } from '../knowledge/memory.js';
import { authorizedSkills } from '../knowledge/skills.js';

/** A generation may hold its system prompt inside a subscription subprocess.
 * Fence its next action when authorized knowledge or native instructions change;
 * restart the model with current DB context before executing that action.
 */
export function contextRevision(userId:string,botId:string):string {
 ownedBot(userId,botId);
 const bot=db.prepare('SELECT generation,instructions,model,name,label,description,is_primary FROM bots WHERE id=? AND user_id=?').get(botId,userId);
 const setup=db.prepare('SELECT revision,onboarding_status FROM bot_setups WHERE bot_id=?').get(botId);
 return sha256(JSON.stringify({bot,setup,memories:authorizedMemories(userId,botId).map(m=>[m.id,m.revision,m.target]),skills:authorizedSkills(userId,botId).map(s=>[s.id,s.revision])}));
}
