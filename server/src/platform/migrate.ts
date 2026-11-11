import { Directory } from './directory.js';
const directory=new Directory();
try{await directory.migrate();}finally{await directory.pool.end();}
