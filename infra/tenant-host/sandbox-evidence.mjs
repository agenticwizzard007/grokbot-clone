/** Chrome 157's internal status table complements, not replaces, kernel containment probes. */
export function assertChromeSandbox(html){
  const clean=value=>value.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim();
  const rows=[...html.matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)].map(row=>[clean(row[1]),clean(row[2])]);
  for(const [name,value] of Object.entries({'Layer 1 Sandbox':'Namespace','PID namespaces':'Yes','Network namespaces':'Yes','Seccomp-BPF sandbox':'Yes'})){
    const matches=rows.filter(row=>row[0]===name);
    if(matches.length!==1||matches[0][1]!==value)throw Error('Chrome did not uniquely report namespace AND seccomp-BPF sandboxing');
  }
  return {namespace:true,seccomp:true};
}
