const target = new URL(process.env.TARGET_URL ?? 'http://127.0.0.1:4000/health');
const local = ['localhost','127.0.0.1','::1'].includes(target.hostname);
if (!local && process.env.ALLOW_STAGING_LOAD_TEST !== 'true') throw new Error('Refusing non-local load test without ALLOW_STAGING_LOAD_TEST=true');
const total = Math.min(10_000, Math.max(1, Number(process.env.REQUESTS ?? 100)));
const concurrency = Math.min(100, Math.max(1, Number(process.env.CONCURRENCY ?? 10)));
let next = 0, failed = 0; const latencies = [];
async function runner(){ while(next < total){ next++; const start=performance.now(); try { const response=await fetch(target,{signal:AbortSignal.timeout(10_000)}); if(!response.ok) failed++; await response.arrayBuffer(); } catch { failed++; } latencies.push(performance.now()-start); }}
await Promise.all(Array.from({length:concurrency},runner)); latencies.sort((a,b)=>a-b);
const p=(n)=>Math.round(latencies[Math.min(latencies.length-1,Math.floor(latencies.length*n))]??0);
console.log(JSON.stringify({target:target.origin+target.pathname,total,concurrency,failed,p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99)},null,2));
if(failed) process.exitCode=1;
