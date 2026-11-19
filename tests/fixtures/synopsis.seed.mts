const {db}=await import('../../server/src/db.js');
(await import('../../server/src/agent/subagents.js')).initSubagents();
(await import('../../server/src/agent/rooms.js')).initRooms();
const {createBot}=await import('../../server/src/bots.js');
const userId='synopsis-browser-owner';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,userId+'@example.test','Synopsis owner',Date.now());
createBot(userId,{name:'Quinn',isPrimary:true});
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('synopsis-browser-token',userId,Date.now(),Date.now()+600000);
db.close();
