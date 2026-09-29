const banglaDigits: Record<string, string> = { '০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9' };
const aliases: Array<[RegExp, string]> = [
  [/\b(?:dam|daam|দাম)\b/giu, ' price '], [/\b(?:ache|ase|আছে)\b/giu, ' available '],
  [/\b(?:lagbe|nibo|নিব|নেব|লাগবে)\b/giu, ' order '], [/\b(?:rong|রং)\b/giu, ' color '],
  [/\b(?:saiz|সাইজ)\b/giu, ' size '], [/\b(?:delivery\s*charge|ডেলিভারি\s*চার্জ)\b/giu, ' delivery charge '],
];

export function normalizeDigits(value: string): string { return value.replace(/[০-৯]/g, digit => banglaDigits[digit] ?? digit); }

/** Used only for matching. The original message must remain the persisted/audited value. */
export function normalizeCustomerText(value: string): string {
  let result = normalizeDigits(value).normalize('NFKC').toLocaleLowerCase('en-US');
  for (const [pattern, replacement] of aliases) result = result.replace(pattern, replacement);
  return result.replace(/[^\p{L}\p{M}\p{N}+৳.,@#\-/\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
