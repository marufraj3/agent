import { normalizeDigits } from '../ai/language-normalizer.js';
export type ParsedFollowUpTime = { kind:'scheduled'; at:Date } | {kind:'ambiguous'; question:string} | {kind:'none'};
const HOUR=3_600_000, MINUTE=60_000, DHAKA=6*HOUR;
function dhakaParts(date:Date){ const shifted=new Date(date.getTime()+DHAKA); return {y:shifted.getUTCFullYear(),m:shifted.getUTCMonth(),d:shifted.getUTCDate(),h:shifted.getUTCHours()}; }
function dhakaDate(y:number,m:number,d:number,h:number,minute=0){ return new Date(Date.UTC(y,m,d,h,minute)-DHAKA); }
export function parseFollowUpTime(text:string, now=new Date()):ParsedFollowUpTime {
  const value=normalizeDigits(text).toLowerCase();
  if (!/(মনে করিয়ে|জানাবেন|follow.?up|remind|পরে order|পরে অর্ডার)/iu.test(value)) return {kind:'none'};
  const minutes=value.match(/(\d{1,4})\s*(?:মিনিট|minute)s?\s*(?:পরে|later)/iu)?.[1]; if(minutes) return {kind:'scheduled',at:new Date(now.getTime()+Number(minutes)*MINUTE)};
  const hours=value.match(/(\d{1,2})\s*(?:ঘণ্টা|ঘন্টা|hour)s?\s*(?:পরে|later)/iu)?.[1]; if(hours) return {kind:'scheduled',at:new Date(now.getTime()+Number(hours)*HOUR)};
  const p=dhakaParts(now); const tomorrow=/আগামীকাল|কাল|tomorrow/iu.test(value); const today=/আজ|tonight|রাতে/iu.test(value);
  const evening=/সন্ধ্যা|evening/iu.test(value); const night=/রাত|tonight/iu.test(value);
  if(tomorrow && !evening && !night && !/\d{1,2}(?::\d{2})?/.test(value)) return {kind:'ambiguous',question:'কাল কোন সময় আপনাকে মনে করিয়ে দিলে সুবিধা হবে?'};
  if(tomorrow||today){ const explicit=value.match(/(?:at|সময়)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i); let hour=evening?19:night?21:explicit?Number(explicit[1]):19; if(explicit?.[3]==='pm'&&hour<12)hour+=12; const day=p.d+(tomorrow?1:0); return {kind:'scheduled',at:dhakaDate(p.y,p.m,day,hour,explicit?.[2]?Number(explicit[2]):0)}; }
  return {kind:'ambiguous',question:'কখন আপনাকে মনে করিয়ে দিলে সুবিধা হবে?'};
}
