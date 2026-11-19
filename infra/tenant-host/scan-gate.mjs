// Vulnerability gate for tenant images (owner decision D2, 2026-11-19).
// HIGH/CRITICAL findings with an upstream fix always fail. A finding without a fix passes only when a
// reviewed exception names the exact CVE and package, explains reachability, and has not expired.
// Exceptions last at most 30 days from approval and cannot be extended by editing the policy field.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
export const MAX_EXCEPTION_DAYS=30;
const DAY=86_400_000;
const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value??'')?Date.parse(`${value}T00:00:00Z`):NaN;
export function validateExceptions(doc){
  if(!doc||!Array.isArray(doc.exceptions))throw Error('Scan exceptions must contain an exceptions array');
  const seen=new Set();
  for(const e of doc.exceptions){
    const label=`${e?.id}/${e?.package}`;
    if(!/^(CVE-\d{4}-\d{4,}|GHSA(-[a-z0-9]{4}){3})$/.test(e?.id??''))throw Error(`Invalid exception id ${label}`);
    if(!/^[A-Za-z0-9._+:@/-]{1,200}$/.test(e?.package??''))throw Error(`Invalid exception package ${label}`);
    if(!['HIGH','CRITICAL'].includes(e?.severity))throw Error(`Exception ${label} must state HIGH or CRITICAL`);
    if(typeof e?.reachability!=='string'||e.reachability.trim().length<20)throw Error(`Exception ${label} needs a reachability note`);
    if(!/^[A-Za-z0-9-]{1,39}$/.test(e?.approvedBy??''))throw Error(`Exception ${label} needs approvedBy`);
    const approved=date(e.approved),expires=date(e.expires);
    if(Number.isNaN(approved)||Number.isNaN(expires)||expires<=approved)throw Error(`Exception ${label} needs approved < expires dates (YYYY-MM-DD)`);
    if(expires-approved>MAX_EXCEPTION_DAYS*DAY)throw Error(`Exception ${label} exceeds ${MAX_EXCEPTION_DAYS} days`);
    if(seen.has(label))throw Error(`Duplicate exception ${label}`);
    seen.add(label);
  }
  return doc.exceptions;
}
export function evaluateScan(report,doc,now=Date.now()){
  const exceptions=validateExceptions(doc);
  const findings=[];
  for(const result of report?.Results??[])for(const v of result?.Vulnerabilities??[]){
    if(!['HIGH','CRITICAL'].includes(v.Severity))continue;
    findings.push({id:v.VulnerabilityID,package:v.PkgName,severity:v.Severity,target:result.Target,installed:v.InstalledVersion,fixed:v.FixedVersion||''});
  }
  const violations=[],accepted=[];
  for(const f of findings){
    if(f.fixed){violations.push({...f,reason:'fix available'});continue;}
    const e=exceptions.find(x=>x.id===f.id&&x.package===f.package);
    if(!e){violations.push({...f,reason:'no exception'});continue;}
    if(date(e.expires)<=now){violations.push({...f,reason:`exception expired ${e.expires}`});continue;}
    if(f.severity==='CRITICAL'&&e.severity!=='CRITICAL'){violations.push({...f,reason:'exception approved for HIGH only'});continue;}
    accepted.push({...f,expires:e.expires});
  }
  return {total:findings.length,violations,accepted};
}
export function loadExceptions(file=new URL('./scan-exceptions.json',import.meta.url)){
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
export function gate(reportFile,label,exceptionsFile){
  const result=evaluateScan(JSON.parse(fs.readFileSync(reportFile,'utf8')),loadExceptions(exceptionsFile));
  console.error(`[scan-gate] ${label}: ${result.total} HIGH/CRITICAL, ${result.accepted.length} under exception, ${result.violations.length} blocking`);
  for(const v of result.violations.slice(0,50))console.error(`  ${v.severity} ${v.id} ${v.package} ${v.installed}${v.fixed?` -> ${v.fixed}`:''} (${v.target}): ${v.reason}`);
  if(result.violations.length>50)console.error(`  … ${result.violations.length-50} more`);
  return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [reportFile,label='image',exceptionsFile]=process.argv.slice(2);
  try{if(!reportFile)throw Error('Usage: scan-gate.mjs <trivy-report.json> [label] [exceptions.json]');
    if(gate(reportFile,label,exceptionsFile).violations.length)process.exitCode=1;}
  catch(error){console.error(error.message);process.exitCode=1;}
}
