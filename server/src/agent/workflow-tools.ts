import { z } from 'zod';
import type { ToolDef, ToolCtx, ToolResult } from './tools.js';
import { createGoal, getGoal, listGoals, controlGoal, verifyGoal, goalInputSchema, evidenceSchema, WorkflowError, ownWorkflowBot } from './goals.js';
import {
  createWorkflow, getWorkflow, listWorkflows, startWorkflow, controlWorkflow, addWorkflowDependency,
  delegateWorkflowTask, completeWorkflowTask, workflowInputSchema, startGoalExecution, workflowScope, workflowToolGate,
} from './workflows.js';

function define<S extends z.ZodType>(name:string,description:string,schema:S,fn:(args:z.output<S>,ctx:ToolCtx)=>unknown|Promise<unknown>,endTurn=false):ToolDef {
  const {$schema,...parameters}=z.toJSONSchema(schema,{io:'input'});
  return {name,description,parameters,activity:'working',label:'Updating workflow',impl:async(args,ctx):Promise<ToolResult>=>{
    try{
      const gate=workflowToolGate(ctx,name);if(!gate.allowed)throw new WorkflowError(gate.reason!);
      // Hermes denies child kanban mutation; preserve the same leaf boundary so
      // delegated workers cannot mint independent goals to evade shared budgets.
      if(['create_goal','create_workflow','delegate_workflow_task'].includes(name) && (ownWorkflowBot(ctx.userId,ctx.botId).parent_bot_id || workflowScope(ctx)?.taskId))throw new WorkflowError('Delegated workers return task results; the parent owns goals and workflow creation.');
      return {output:JSON.stringify(await fn(schema.parse(args),ctx)),...(endTurn?{endTurn:true}:{})};
    }
    catch(e){return {output:JSON.stringify({error:e instanceof Error ? e.message : 'Workflow operation failed.'}),isError:true};}
  }};
}
const id=z.string().min(1),action=z.enum(['pause','resume','block','stop']);
function parentWorkflow(ctx:ToolCtx,workflowId:string) {
  const w=getWorkflow(ctx.userId,workflowId);
  if(w.botId!==ctx.botId)throw new WorkflowError('Only the parent agent can control this workflow.',404);
  const scope=workflowScope(ctx);
  if(scope && (scope.goalId ? w.goalId!==scope.goalId : w.id!==scope.workflowId))throw new WorkflowError('A native run can only control workflows in its existing goal/workflow scope.');
  return w;
}
function parentGoal(ctx:ToolCtx,goalId:string) {
  const g=getGoal(ctx.userId,goalId);if(g.botId!==ctx.botId)throw new WorkflowError('Goal not found for this agent.',404);return g;
}
export const WORKFLOW_TOOLS:ToolDef[]=[
  define('create_goal','Create an explicitly requested persistent goal with concrete acceptance criteria. Only set budgets when requested by the user; omitted or zero maxTurns means no turn limit. Work continues through the existing queue until verified, paused, blocked or explicitly budget-limited. Completion requires existing evidence, never a boolean.',goalInputSchema, (a,c)=>{
    const goal=createGoal(c.userId,c.botId,a);startGoalExecution(c.userId,goal.id,c.jobId);return goal;
  }),
  define('control_goal','Pause, resume, block with a reason, or stop a persistent goal. Stop propagates to workflow children. Exhausted budgets cannot be resumed silently.',z.object({goal_id:id,action,reason:z.string().max(2000).optional()}).strict(),(a,c)=>{
    parentGoal(c,a.goal_id);return controlGoal(c.userId,a.goal_id,a.action,a.reason);
  }),
  define('verify_goal','Verify every acceptance criterion against a persisted assistant/tool row, owner-private file or schema-validated workflow result. Marks complete only after all checks and dependent tasks pass.',z.object({goal_id:id,evidence:z.array(evidenceSchema).min(1).max(30)}).strict(),(a,c)=>{
    parentGoal(c,a.goal_id);return verifyGoal(c.userId,a.goal_id,a.evidence);
  },true),
  define('get_workflows','Read this agent’s native goals, dependency graph, child assignments, validated results and blockers.',z.object({}).strict(),(_a,c)=>({goals:listGoals(c.userId,c.botId),workflows:listWorkflows(c.userId,c.botId)})),
  define('create_workflow','Create a native dependency task graph. Each task needs a stable key, instructions and evidence criteria. dependsOn contains prerequisite keys. Output schemas are JSON Schema; workerBotId assigns an existing activated permanent specialist; delegate without it creates a native child bot when started. Creation alone does not start execution. Within a persistent goal its goalId is inherited and cannot be replaced.',workflowInputSchema,(a,c)=>{
    const scope=workflowScope(c);
    if(scope?.goalId) {
      if(a.goalId && a.goalId!==scope.goalId)throw new WorkflowError('Workflow goalId must match the current persistent goal.');
      return createWorkflow(c.userId,c.botId,{...a,goalId:scope.goalId});
    }
    if(scope?.workflowId)throw new WorkflowError('Use this run’s existing task graph instead of creating an untracked workflow.');
    return createWorkflow(c.userId,c.botId,a);
  }),
  define('start_workflow','Start ready tasks on the existing Swarm job queue. Dependencies must be verified complete before followers run.',z.object({workflow_id:id}).strict(),(a,c)=>{
    parentWorkflow(c,a.workflow_id);return startWorkflow(c.userId,a.workflow_id);
  }),
  define('control_workflow','Pause, resume, block, or stop a native workflow. Resume after restart is explicit because prior work may have produced external effects.',z.object({workflow_id:id,action,reason:z.string().max(2000).optional()}).strict(),(a,c)=>{
    parentWorkflow(c,a.workflow_id);return controlWorkflow(c.userId,a.workflow_id,a.action,a.reason);
  }),
  define('add_workflow_dependency','Add a prerequisite to a not-yet-admitted task. Cycles and cross-workflow links are rejected.',z.object({workflow_id:id,task_id:id,depends_on_id:id}).strict(),(a,c)=>{
    parentWorkflow(c,a.workflow_id);return addWorkflowDependency(c.userId,a.workflow_id,a.task_id,a.depends_on_id);
  }),
  define('delegate_workflow_task','Assign a ready workflow task to a native child bot with persisted lineage and the task’s output contract. Uses the normal Swarm queue, tools and provider.',z.object({workflow_id:id,task_id:id,workerBotId:id.optional()}).strict(),(a,c)=>{
    parentWorkflow(c,a.workflow_id);return {childBotId:delegateWorkflowTask(c.userId,a.workflow_id,a.task_id,a.workerBotId)};
  }),
  define('complete_workflow_task','Verify concrete acceptance evidence for a task. Dependencies and any required structured result must already validate. A completion claim alone is never sufficient.',z.object({workflow_id:id,task_id:id,evidence:z.array(evidenceSchema).min(1).max(30)}).strict(),(a,c)=>{const scope=workflowScope(c);if(scope?.taskId && (scope.taskId!==a.task_id||scope.workflowId!==a.workflow_id))throw new WorkflowError('Worker completion must match the current task.');return completeWorkflowTask(c.userId,a.workflow_id,a.task_id,a.evidence.map(e=>e.kind==='result'?e:{...e,botId:e.botId??c.botId}),c.botId);},true),
];
