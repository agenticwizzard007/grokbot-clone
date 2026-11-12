import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AuthVars } from './lib/auth.js';
import { WorkflowError, createGoal, listGoals, controlGoal, verifyGoal, goalInputSchema, evidenceSchema } from './agent/goals.js';
import { createWorkflow, getWorkflow, listWorkflows, startWorkflow, controlWorkflow, addWorkflowDependency,
  delegateWorkflowTask, completeWorkflowTask, workflowInputSchema, startGoalExecution } from './agent/workflows.js';

export const workflowApi=new Hono<AuthVars>();
workflowApi.use('*',requireUser);
workflowApi.onError((err,c)=>{
  if(err instanceof WorkflowError)return c.json({error:err.message},err.status);
  if(err instanceof z.ZodError)return c.json({error:'Invalid workflow request.',details:err.issues.map(i=>({path:i.path,message:i.message}))},400);
  if(err instanceof SyntaxError)return c.json({error:'Invalid JSON request.'},400);
  console.error('[workflows]',err);return c.json({error:'Workflow operation failed.'},500);
});
const owner=(c:{get:(key:'user')=>{id:string}})=>c.get('user').id;
const control=z.object({action:z.enum(['pause','resume','block','stop']),reason:z.string().max(2000).optional()}).strict();
const evidence=z.object({evidence:z.array(evidenceSchema).min(1).max(30)}).strict();
workflowApi.get('/',c=>{const user=owner(c),botId=c.req.query('botId');return c.json({goals:listGoals(user,botId),workflows:listWorkflows(user,botId)});});
workflowApi.post('/goals',async c=>{
  const {botId,start,...input}=goalInputSchema.extend({botId:z.string().min(1),start:z.boolean().default(true)}).parse(await c.req.json());
  const goal=createGoal(owner(c),botId,input);if(start)startGoalExecution(owner(c),goal.id);return c.json({goal},201);
});
workflowApi.post('/goals/:id/control',async c=>{const a=control.parse(await c.req.json());return c.json({goal:controlGoal(owner(c),c.req.param('id'),a.action,a.reason)});});
workflowApi.post('/goals/:id/verify',async c=>{const a=evidence.parse(await c.req.json());return c.json({goal:verifyGoal(owner(c),c.req.param('id'),a.evidence)});});
workflowApi.post('/',async c=>{const {botId,...input}=workflowInputSchema.extend({botId:z.string().min(1)}).parse(await c.req.json());return c.json({workflow:createWorkflow(owner(c),botId,input)},201);});
workflowApi.get('/:id',c=>c.json({workflow:getWorkflow(owner(c),c.req.param('id'))}));
workflowApi.post('/:id/start',c=>c.json({workflow:startWorkflow(owner(c),c.req.param('id'))}));
workflowApi.post('/:id/control',async c=>{const a=control.parse(await c.req.json());return c.json({workflow:controlWorkflow(owner(c),c.req.param('id'),a.action,a.reason)});});
workflowApi.post('/:id/dependencies',async c=>{
  const a=z.object({taskId:z.string(),dependsOnId:z.string()}).strict().parse(await c.req.json());return c.json({workflow:addWorkflowDependency(owner(c),c.req.param('id'),a.taskId,a.dependsOnId)});
});
workflowApi.post('/:id/tasks/:taskId/delegate',c=>c.json({childBotId:delegateWorkflowTask(owner(c),c.req.param('id'),c.req.param('taskId'))}));
workflowApi.post('/:id/tasks/:taskId/complete',async c=>{const a=evidence.parse(await c.req.json());return c.json({workflow:completeWorkflowTask(owner(c),c.req.param('id'),c.req.param('taskId'),a.evidence)});});
