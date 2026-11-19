// Vulnerability gate for tenant images (owner decision D2, 2026-11-19).
// HIGH/CRITICAL findings with an upstream fix always fail. A finding without a fix passes only when a
// reviewed exception names the exact CVE, package and image, explains reachability for that image, is
// already approved and has not expired. Exceptions last at most 30 days from approval.
// The parser is the publication boundary: anything that is not a well-formed Trivy report fails closed.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
export const MAX_EXCEPTION_DAYS=30;
// Scan identities. APP_IMAGE, RUNNER_IMAGE and MCP_IMAGE are one shared application image by design,
// so they share the 'app' scope; every other component has its own.
export const IMAGES=['app','hostBase','desktopBase','desktop','host'];
const COMPONENT_IMAGES={APP_IMAGE:'app',RUNNER_IMAGE:'app',MCP_IMAGE:'app',DESKTOP_IMAGE:'desktop',HOST_BASE:'hostBase'};
const SEVERITIES=['UNKNOWN','LOW','MEDIUM','HIGH','CRITICAL'];
const DAY=86_400_000;
const date=value=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value??''))return NaN;
  const ms=Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms)&&new Date(ms).toISOString().slice(0,10)===value?ms:NaN;
};
export function imageScope(label){
  const scope=IMAGES.includes(label)?label:COMPONENT_IMAGES[label];
  if(!scope)throw Error(`Unknown scan image ${JSON.stringify(label)}`);
  return scope;
}
export function validateExceptions(doc){
  if(!doc||typeof doc!=='object'||!Array.isArray(doc.exceptions))throw Error('Scan exceptions must contain an exceptions array');
  const seen=new Set();
  for(const e of doc.exceptions){
    const label=`${e?.id}/${e?.package}/${e?.image}`;
    if(!/^(CVE-\d{4}-\d{4,}|GHSA(-[a-z0-9]{4}){3})$/.test(e?.id??''))throw Error(`Invalid exception id ${label}`);
    if(!/^[A-Za-z0-9._+:@/-]{1,200}$/.test(e?.package??''))throw Error(`Invalid exception package ${label}`);
    if(!IMAGES.includes(e?.image))throw Error(`Exception ${label} must name one image: ${IMAGES.join(', ')}`);
    if(!['HIGH','CRITICAL'].includes(e?.severity))throw Error(`Exception ${label} must state HIGH or CRITICAL`);
    if(typeof e?.reachability!=='string'||e.reachability.trim().length<20)throw Error(`Exception ${label} needs a reachability note`);
    if(!/^[A-Za-z0-9-]{1,39}$/.test(e?.approvedBy??''))throw Error(`Exception ${label} needs approvedBy`);
    const approved=date(e.approved),expires=date(e.expires);
    if(Number.isNaN(approved)||Number.isNaN(expires)||expires<=approved)throw Error(`Exception ${label} needs real approved < expires dates (YYYY-MM-DD)`);
    if(expires-approved>MAX_EXCEPTION_DAYS*DAY)throw Error(`Exception ${label} exceeds ${MAX_EXCEPTION_DAYS} days`);
    if(seen.has(label))throw Error(`Duplicate exception ${label}`);
    seen.add(label);
  }
  return doc.exceptions;
}
// Accepts Trivy's JSON schema version 2 only. A clean scan is a valid report whose results list no
// HIGH/CRITICAL vulnerabilities; a missing, empty or malformed report is never clean.
export function readFindings(report){
  if(!report||typeof report!=='object'||Array.isArray(report))throw Error('Scan report is missing or not an object');
  if(report.SchemaVersion!==2)throw Error('Unsupported scan report schema (expected Trivy SchemaVersion 2)');
  if(typeof report.ArtifactName!=='string'||!report.ArtifactName)throw Error('Scan report has no artifact name');
  if(!Array.isArray(report.Results))throw Error('Scan report has no results list');
  const findings=[];
  for(const result of report.Results){
    if(!result||typeof result!=='object'||typeof result.Target!=='string')throw Error('Scan report has a malformed result');
    if(result.Vulnerabilities===undefined||result.Vulnerabilities===null)continue;
    if(!Array.isArray(result.Vulnerabilities))throw Error(`Scan result ${result.Target} has malformed vulnerabilities`);
    for(const v of result.Vulnerabilities){
      if(!v||typeof v!=='object'||typeof v.VulnerabilityID!=='string'||!v.VulnerabilityID||typeof v.PkgName!=='string'||!v.PkgName||!SEVERITIES.includes(v.Severity))
        throw Error(`Scan result ${result.Target} has a malformed vulnerability`);
      if(v.FixedVersion!==undefined&&typeof v.FixedVersion!=='string')throw Error(`Scan result ${result.Target} has a malformed fixed version`);
      if(!['HIGH','CRITICAL'].includes(v.Severity))continue;
      findings.push({id:v.VulnerabilityID,package:v.PkgName,severity:v.Severity,target:result.Target,installed:v.InstalledVersion??'',fixed:v.FixedVersion||''});
    }
  }
  return findings;
}
export function evaluateScan(report,doc,now=Date.now(),image){
  const scope=imageScope(image);
  const exceptions=validateExceptions(doc);
  const findings=readFindings(report);
  const violations=[],accepted=[];
  for(const f of findings){
    if(f.fixed){violations.push({...f,reason:'fix available'});continue;}
    const e=exceptions.find(x=>x.id===f.id&&x.package===f.package&&x.image===scope);
    if(!e){violations.push({...f,reason:`no exception for image ${scope}`});continue;}
    if(date(e.approved)>now){violations.push({...f,reason:`exception not yet approved (${e.approved})`});continue;}
    if(date(e.expires)<=now){violations.push({...f,reason:`exception expired ${e.expires}`});continue;}
    if(f.severity==='CRITICAL'&&e.severity!=='CRITICAL'){violations.push({...f,reason:'exception approved for HIGH only'});continue;}
    accepted.push({...f,expires:e.expires});
  }
  return {image:scope,total:findings.length,violations,accepted};
}
export function loadExceptions(file=new URL('./scan-exceptions.json',import.meta.url)){
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
export function gate(reportFile,label,exceptionsFile,now=Date.now()){
  const result=evaluateScan(JSON.parse(fs.readFileSync(reportFile,'utf8')),loadExceptions(exceptionsFile),now,label);
  console.error(`[scan-gate] ${label}: ${result.total} HIGH/CRITICAL, ${result.accepted.length} under exception, ${result.violations.length} blocking`);
  for(const v of result.violations.slice(0,50))console.error(`  ${v.severity} ${v.id} ${v.package} ${v.installed}${v.fixed?` -> ${v.fixed}`:''} (${v.target}): ${v.reason}`);
  if(result.violations.length>50)console.error(`  … ${result.violations.length-50} more`);
  return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [reportFile,label,exceptionsFile]=process.argv.slice(2);
  try{if(!reportFile||!label)throw Error('Usage: scan-gate.mjs <trivy-report.json> <image> [exceptions.json]');
    if(gate(reportFile,label,exceptionsFile).violations.length)process.exitCode=1;}
  catch(error){console.error(`[scan-gate] ${label??'image'}: ${error.message}`);process.exitCode=1;}
}
