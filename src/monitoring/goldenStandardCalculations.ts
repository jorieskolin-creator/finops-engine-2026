import type { CaseId } from './goldenStandardSuite';

export function numericObservations(
  caseId: CaseId,
  files: Array<{ name: string; text: string; sourceId?: string }>,
  admittedSourceIds?: ReadonlySet<string>,
  admittedByDomain?: Readonly<Record<string, ReadonlySet<string>>>,
) {
  const isAdmitted = (file: { sourceId?: string }, domains?: readonly string[]) => {
    if (!file.sourceId) return true;
    if (admittedByDomain && domains?.length) {
      return domains.some(domain => admittedByDomain[domain]?.has(file.sourceId!) === true);
    }
    return !admittedSourceIds || admittedSourceIds.has(file.sourceId);
  };
  const text = (prefix: string, domains?: readonly string[]) => {
    const matched = files.find(file => file.name.startsWith(prefix));
    if (!matched || !isAdmitted(matched, domains)) return '';
    return matched.text.replace(/\s+/g, ' ');
  };
  const values = (source: string, pattern: RegExp) => {
    const match = source.match(pattern);
    return match ? match.slice(1).map(value => Number(value.replace(/,/g, ''))) : [];
  };
  const money = String.raw`([\d,]+(?:\.\d+)?)`;
  const weekly = values(text('06-', ['B']), new RegExp(`posted workload costs of EUR ${money} and EUR ${money}`));
  const weeklyDelta = weekly.length === 2 ? weekly[0] - weekly[1] : null;
  if (caseId === 'clear-block') return [];
  if (caseId === 'near-block-conditional-go') {
    const budgets = values(text('05-', ['C', 'A']), new RegExp(`EUR ${money} approved to EUR ${money} forecast`));
    return [
      budgets.length === 2 ? budgets[1] - budgets[0] : null,
      values(text('04-', ['B']), new RegExp(`EUR ${money} observed lower run cost`))[0] ?? null,
      values(text('04-', ['B']), /ENT-RI-00032 was underused at ([\d.]+)%/)[0] ?? null,
    ];
  }
  if (caseId === 'clear-warn') {
    return [
      weeklyDelta,
      values(text('06-', ['B']), /ENT-RI-00032 at ([\d.]+)%/)[0] ?? null,
      values(text('06-', ['B']), /threshold is ([\d.]+)% reservation utilization/)[0] ?? null,
    ];
  }
  const ai = text('09-', ['F']);
  const endpoints = [...ai.matchAll(new RegExp(`EUR ${money} billed inference`, 'g'))]
    .map(match => Math.round(Number(match[1].replace(/,/g, '')) * 100));
  const overhead = values(ai, new RegExp(`overhead of EUR ${money}`))[0];
  const tasks = values(ai, /divided by ([\d,]+) completed tasks/)[0];
  const total = endpoints.length === 2 && Number.isFinite(overhead)
    ? (endpoints[0] + endpoints[1] + Math.round(overhead * 100)) / 100 : null;
  const checks = [
    values(text('08-', ['D', 'C']), new RegExp(`revised plan at EUR ${money}`))[0] ?? null,
    total,
    total !== null && tasks > 0 ? total / tasks : null,
  ];
  return caseId === 'clear-go' ? [...checks, weeklyDelta] : checks;
}
