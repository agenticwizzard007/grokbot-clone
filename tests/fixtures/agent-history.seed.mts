import fs from 'node:fs';
const {db}=await import('../../server/src/db.js');
(await import('../../server/src/agent/subagents.js')).initSubagents();
(await import('../../server/src/agent/rooms.js')).initRooms();
const {createBot}=await import('../../server/src/bots.js');
const {appendRow}=await import('../../server/src/store.js');
const {createSkill,updateSkill,stageSkillProposal}=await import('../../server/src/knowledge/skills.js');
const {saveMemory}=await import('../../server/src/knowledge/memory.js');
const file=process.env.HISTORY_FIXTURE_FILE!;
try {
 if(process.argv[2]==='revise') {
  const f=JSON.parse(fs.readFileSync(file,'utf8'));const row=db.prepare('SELECT revision FROM skills WHERE id=?').get(f.skillId) as {revision:number};
  updateSkill(f.userId,f.skillId,{body:'New accepted procedure after the history page opened.'},row.revision);
 } else {
  const userId='usr_history_browser_owner';db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,'history@example.test','History fixture',Date.now());
  const bot=createBot(userId,{name:'Quinn',isPrimary:true});
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('history-browser-token',userId,Date.now(),Date.now()+600000);
  const row=appendRow(bot.id,'message',{type:'message',role:'user',text:'Please prioritize overdue work and keep reports brief.'});const evidence=[{botId:bot.id,generation:1,seq:row.seq}];
  saveMemory(userId,bot.id,{text:'Keep reports brief.',evidence});
  const skill=createSkill(userId,bot.id,{name:'Reporting',description:'Weekly reporting',body:'Initial report procedure.'});
  for(let revision=1;revision<=35;revision++)updateSkill(userId,skill.id,{body:`Accepted procedure ${revision}: lead with overdue work.`},revision);
  stageSkillProposal(userId,bot.id,{skillId:skill.id,expectedRevision:36,content:{name:'Reporting',description:'Weekly reporting',body:'Proposed procedure awaiting review.'},reason:'A suggestion based on the original request',evidence});
  fs.writeFileSync(file,JSON.stringify({userId,botId:bot.id,skillId:skill.id}));
 }
}finally{db.close();}
