export { configureCoordinationRuntime, enqueueInternalMessage, drainInternalRequests, pendingDecision, botOccupied, getInternalRequest, listInternalRequests } from './requests.js';
export { coordinationPrompt, teamState } from './state.js';
export { setCoordinationEnabled, coordinationPreTurn, reviewCoordination } from './supervision.js';
export { dailySynopsisContext, bindReportIntent, reconcileReportCoverage } from './reports.js';
import { onInternalJobFinished, recoverInternalRequests, type CoordinationFinish } from './requests.js';
import { finishCoordinationReview, reviewCoordination } from './supervision.js';
import { reconcileReportCoverage } from './reports.js';
export function onCoordinationJobFinished(input:CoordinationFinish) {
 onInternalJobFinished(input);finishCoordinationReview(input);reconcileReportCoverage();
}
export function startCoordinationRuntime() {
 recoverInternalRequests();reconcileReportCoverage();reviewCoordination();
 const timer=setInterval(()=>{try{recoverInternalRequests();reconcileReportCoverage();reviewCoordination();}catch(e){console.error('[coordination]',e instanceof Error?e.message:'Runtime failed');}},15000);timer.unref();
 return ()=>clearInterval(timer);
}
