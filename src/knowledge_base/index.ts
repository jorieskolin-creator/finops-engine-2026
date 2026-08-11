
import type { KnowledgePacketStage, KnowledgeTaxonomyRegistry, RemoteKnowledgeBaseDocument, RemoteKnowledgeBaseIndex, ShadowKnowledgePacket, StrategicTactic, TacticActivityPlaybookEntry } from '../types';
import criteriaData from './finops_criteria.json';
import antipatternData from './finops_antipatterns.json';
import keywordsData from './finops_preflight_keywords.json';
import taxonomyData from './finops_evidence_taxonomy.json';
import personasData from './finops_personas.json';
import tacticsData from './finops_tactics_database.json';
import tacticActivityPlaybookData from './finops_tactic_activity_playbook.json';
import validationData from './finops_validation_rules.json';
import taxonomyRegistryData from './finops_taxonomy_registry.json';

export const FINOPS_CRITERIA = criteriaData.criteria;
export const FINOPS_ANTIPATTERNS = antipatternData.criteria;
export const FINOPS_KEYWORDS = keywordsData;
export const FINOPS_EVIDENCE_TAXONOMY = taxonomyData;
export const FINOPS_PERSONAS = personasData;
export const FINOPS_TACTICS_LOCAL = tacticsData.tactics as StrategicTactic[];
export const FINOPS_TACTIC_ACTIVITY_PLAYBOOK = tacticActivityPlaybookData.entries as TacticActivityPlaybookEntry[];
export const FINOPS_VALIDATION_RULES = validationData;
export const FINOPS_TAXONOMY_REGISTRY = taxonomyRegistryData as KnowledgeTaxonomyRegistry;

// Extract the primary case-study company from a tactic. The DB uses the
// convention "COMPANY: prose..." for each case_study; we pull the leading
// upper-case token. Falls back to "(no company)" if absent.
export function extractTacticCompany(t: StrategicTactic): string {
  const cs = t.case_study || '';
  const m = cs.match(/^([A-Z][A-Z0-9 &/.-]+):/);
  return m ? m[1].trim() : '(no company)';
}

// Hard ID → canonical_name → company table, one line per tactic. Designed to
// be injected at the TOP of the synthesis SSOT so the model can never confuse
// which company is paired with which tactic ID. Without this, the model leans
// on training-data associations (e.g. Spotify ↔ tagging) and emits IDs that
// don't match the DB's actual pairings.
export function buildTacticIdTable(tactics: StrategicTactic[] = FINOPS_TACTICS_LOCAL): string {
  return tactics
    .map(t => `${t.id} — ${t.canonical_name ?? '(unnamed)'} — ${extractTacticCompany(t)}`)
    .join('\n');
}

// Set of valid tactic IDs for the post-synthesis ID scanner.
export function validTacticIdSet(tactics: StrategicTactic[] = FINOPS_TACTICS_LOCAL): Set<string> {
  return new Set(tactics.map(t => t.id));
}

export function buildTacticActivityContext(
  tactics: StrategicTactic[] = FINOPS_TACTICS_LOCAL,
  entries: TacticActivityPlaybookEntry[] = FINOPS_TACTIC_ACTIVITY_PLAYBOOK
): string {
  const tacticIds = new Set(tactics.map(t => t.id));
  const byId = new Map(tactics.map(t => [t.id, t]));
  return entries
    .filter(entry => tacticIds.has(entry.tactic_id))
    .map(entry => {
      const tactic = byId.get(entry.tactic_id);
      return [
        `[${entry.tactic_id}] ${tactic?.canonical_name || tactic?.problem_pattern || 'Unnamed tactic'}`,
        `KB coverage: maturity=${entry.maturity_criteria.join(', ')}; antipattern=${entry.antipattern_criteria.join(', ')}`,
        `Activity goal: ${entry.activity_goal}`,
        `Use when: ${entry.when_to_use.join('; ')}`,
        `Do not use when: ${entry.when_not_to_use.join('; ')}`,
        `Prerequisite evidence: ${entry.prerequisite_evidence.join('; ')}`,
        `Implementation activities: ${entry.implementation_activities.join('; ')}`,
        `Owner roles: ${entry.owner_roles.join(', ')}`,
        `Expected artifacts: ${entry.expected_artifacts.join(', ')}`,
        `Acceptance criteria: ${entry.acceptance_criteria.join('; ')}`,
        `Risks and controls: ${entry.risks_and_controls.join('; ')}`
      ].join('\n');
    })
    .join('\n\n---\n\n');
}

const MASTER_BINGO_FINOPS = {
  maturity: FINOPS_CRITERIA.map(c => ({
    id: c.id,
    batch: c.batch,
    title: c.title,
    desc: c.description
  })),
  antipattern: FINOPS_ANTIPATTERNS.map(c => ({
    id: c.id,
    batch: c.batch,
    title: c.title,
    desc: c.description
  }))
};

export { MASTER_BINGO_FINOPS };

const buildBatchXml = (items: typeof FINOPS_CRITERIA, batchId: string): string => {
  return items
    .filter(c => c.batch === batchId)
    .map(c => `
        <item id="${c.id}">
            <title>${c.title}</title>
            <description>${c.description}</description>
            <criteria>
            ${c.sub_criteria.map((sc, i) => `${i + 1}. ${sc}`).join('\n            ')}
            </criteria>
        </item>`)
    .join('\n');
};

interface BatchDefinition {
  title: string;
  maturity: string;
  antipattern: string;
}

export const BATCH_TITLES: Record<string, string> = {
  A: 'Cost Visibility & Allocation',
  B: 'Rate & Usage Optimization',
  C: 'Governance & Policy',
  D: 'Architecture & Engineering',
  E: 'Culture & Organization',
  F: 'GenAI & AI Cost Management'
};

export const TAXONOMY_DOCUMENT_NAMING = FINOPS_TAXONOMY_REGISTRY.kb_document_naming;
export const TAXONOMY_USAGE_BOUNDARIES = FINOPS_TAXONOMY_REGISTRY.usage_boundaries;

export const BATCH_IDS = Object.keys(BATCH_TITLES);

export const BATCH_DEFINITIONS: Record<string, BatchDefinition> = {};
for (const batchId of BATCH_IDS) {
  BATCH_DEFINITIONS[batchId] = {
    title: BATCH_TITLES[batchId],
    maturity: buildBatchXml(FINOPS_CRITERIA, batchId),
    antipattern: buildBatchXml(FINOPS_ANTIPATTERNS, batchId)
  };
}

export const STRATEGY_GUARDRAILS = `
<strategy_guardrails>
You are synthesizing a strategy from a forensic audit. These rules are non-negotiable:

1. **Source of Truth — No Inference Beyond Phase 2:** Every diagnostic claim must be traceable to either the VALIDATED SYSTEM REPORT (Phase 2 metrics) or the SOURCE_DOCUMENT_TO_AUDIT. Do not invent findings, scores, or behaviors.

2. **Tactic Citations are Mandatory:** Every actionable recommendation that prescribes a specific mechanism MUST cite at least one tactic ID from the VERIFIED TACTICS DATABASE, in the form [TAC-XXX-NNN]. Tactic IDs must be copied verbatim from the database — do not invent IDs, do not paraphrase IDs.

3. **No Weasel Words:** Forbidden phrases include "consider", "might", "could potentially", "perhaps", "it may be worth", "you could try", "we suggest exploring". Be direct ("Implement", "Enforce", "Eliminate") or omit the action.

4. **No Fabricated Numbers:** Do not invent dollar amounts, percentages, headcounts, or account numbers. Any percentage cited in prose must correspond to a value present in Phase 2 metrics.

5. **Forensic Tone, Not Consultative:** Describe findings and prescribed actions. Do not offer opinions, hedge, or editorialize. The reader is an executive who needs directives, not options.

6. **Financial Sensitivity:** Do not echo specific dollar amounts, customer names, or account numbers from the source document. Reference them generically.
</strategy_guardrails>
`;

export const SHARED_GUARDRAILS = `
<task>
You are a **Cloud Financial Forensic Auditor**. Your job is to extract **explicit proof** from the text.
**CRITICAL:** You must NOT give the "benefit of the doubt". You are looking for Traceable Evidence.

For EVERY item in the provided Knowledge Base, you must determine **Signal Strength (Count)**:

**SCALE:**
*   **0 (Absent):** No evidence found.
    *   *Stream A (Maturity):* This is **BAD** (Missing Capability).
    *   *Stream B (Anti-Pattern):* This is only **GOOD** when relevant source coverage verifies that the harmful pattern was tested and not found. Otherwise it is **unknown / not assessed**.
*   **1 (Aspirational):** Buzzwords, plans, or vague intent only. Plans = Score 1 max.
*   **2 (Operational):** Behavior or process is described and functioning.
*   **3 (Embedded):** Explicit mechanisms, automation, enforcement, or cultural norms.
    *   *Stream A (Maturity):* This is **GOOD** (Mature Capability).
    *   *Stream B (Anti-Pattern):* This is **BAD** (Deep Structural Problem).

**RULES OF EVIDENCE (THE "CLEAN ROOM" PROTOCOL):**
1. **Source of Truth:** You must **ONLY** extract evidence from the XML tag <UNTRUSTED_CONTENT>.
2. **No Inference:** If the text says "We plan to implement cost tagging", that is NOT evidence of a tagging system. Score 1 max.
3. **Tool Presence ≠ Practice:** Mentioning a tool does not prove active use. Look for HOW it is used.
4. **Silence is Data:** If the text is silent, score is **0**. Do not hallucinate.
5. **Financial Sensitivity:** Do not extract specific dollar amounts or account numbers.
6. **Documentation ≠ Practice:** A policy document = Score 1-2. Only enforcement evidence = Score 3.

**DOCUMENT-TYPE SIGNATURES (USE TO HONOR "SILENCE IS DATA"):**
Real source documents are often single-purpose. A narrow document is EXPECTED to be silent on most criteria. Do not infer evidence for criteria the document type would not naturally cover. Common signatures:

*   **Tagging / cost allocation policy:** Expect evidence in A1 (tagging), A2 (allocation). Expect SILENCE in B (optimization), D (architecture), E (culture), and F (GenAI/token cost) unless those topics are explicitly covered. Anti-patterns: expect SILENCE — a policy doc declares intent, it does not describe organizational behavior.
*   **Cloud governance / FinOps policy:** Expect evidence in C1–C5 (governance, policy, procurement, compliance) and A1 (tagging declared). Expect evidence in F4 only if AI/token budgets, quotas, or guardrails are explicitly described. Expect SILENCE in B (no actual optimization actions), D (no architecture details), E1–E3 (no observed culture), and F otherwise.
*   **FinOps team charter / CoE model:** Expect evidence in C1 (FinOps team), E4 (executive sponsorship if signed). Expect evidence in F5 only if AI value governance or AI cost ownership is explicitly part of the charter. Expect SILENCE in A4 (dashboards not described), B (no optimization described), D (no architecture), and F otherwise.
*   **Cloud strategy document:** Expect SCATTERED evidence at score 1 across A, C, D — strategy documents describe intent, not operations. "Plans = Score 1 max" applies aggressively here. Expect SILENCE in detailed operational evidence.
*   **RI / Savings Plan strategy:** Expect evidence in B1 (commitments) and possibly B5 (storage). Expect SILENCE in A (no allocation), C (no governance framing), D (no architecture), E (no culture).
*   **Cost optimization review / report:** Expect evidence in B1–B5 (optimization is the topic) and possibly A4 (dashboards used for the review). May contain LEGITIMATE anti-pattern evidence in B (waste, over-provisioning) because the review surfaced them. Expect SILENCE in C policy and E culture.
*   **Dashboard screenshot (image input):** A single dashboard image evidences A4 (Cloud Cost Dashboards) at Score 2–3 — the dashboard is in use. Possibly A2 (Showback) if breakdown by team/cost-center is visible, or F1/F4 if token/API/model spend, AI budgets, or AI anomalies are visible. Expect SILENCE on B/C/D/E/F unless the dashboard explicitly displays those signals. Evidence_source is "image".
*   **Architecture diagram (image input):** May evidence D1 (Cost-Aware Architecture), D2 (IaC), D3 (Scaling), D4 (Multi-Cloud), or F3 if model routing, AI gateway, context controls, cache layers, or token budget controls are annotated. Expect SILENCE on A/B/C/E/F unless the diagram shows tagging, cost annotations, AI cost controls, or org-level callouts. Evidence_source is "image".
*   **Org chart (image input):** Evidences C3 (Operating Model RACI), E1 (FinOps Team), E3 (Exec Sponsorship), E4 (Cross-Functional Collaboration) when FinOps roles or reporting lines are visible. Expect SILENCE elsewhere. Evidence_source is "image".
*   **General organizational status report (multi-topic):** Evidence may appear across all batches; this is the only doc type where broad coverage is expected.

If the document looks like ONE of these single-purpose types, do not invent evidence for the other batches to "balance" the audit. A score of 0 on a batch the document does not cover is the correct answer. The same principle applies to single-purpose image inputs.
</task>

<output_format>
STRICTLY return a JSON object. Do not include any text outside the JSON.
**IMPORTANT**: You must analyze ALL 10 items in this batch. Do not skip items.
If an item has score 0, you must still provide the reasoning why (e.g., "Document was silent").

**STEP-BY-STEP FORMATTING**:
For every item, include a "reasoning" field BEFORE the score.
For every item with score > 0, include at least one evidence quote from the source document.
</output_format>
`;

const FALLBACK_TACTICS: StrategicTactic[] = [
  {
    id: "TAC-FALLBACK",
    category: "Visibility",
    problem_pattern: "Missing Cost Visibility",
    solution_mechanism: "Implement Team-Level Cost Dashboards",
    case_study: "AIRBNB: Built internal cost attribution platform showing real-time cost per service."
  }
];

const emptyRemoteKbIndex = (reason: string): RemoteKnowledgeBaseIndex => ({
  status: {
    source: 'built_in',
    document_count: 0,
    failure_count: reason ? 1 : 0,
  },
  documents: [],
  failures: reason ? [{ pathname: 'Knowledge Base/', reason }] : [],
});

let remoteKbIndexPromise: Promise<RemoteKnowledgeBaseIndex> | null = null;

const normalizeKbText = (text: string, maxChars: number): string => {
  const compacted = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return compacted.length > maxChars
    ? `${compacted.slice(0, maxChars).trim()}\n[truncated]`
    : compacted;
};

const SHADOW_SECTION_LIMIT = 6000;
const SHADOW_PACKET_LIMIT = 45_000;

const STAGE_SECTION_KEYS: Record<KnowledgePacketStage, string[]> = {
  forensic_audit: [
    'canonical_definition', 'primary_assessment_questions', 'state_interpretation',
    'detailed_interpretation', 'evidence_requirements', 'strong_evidence_examples',
    'moderate_evidence_examples', 'weak_evidence_examples', 'contradictory_evidence_examples',
    'accepted_evidence_types', 'provider_mapping', 'focus_normalized_interpretation',
    'false_positive_guards', 'validation_questions', 'detection_heuristics',
    'operational_indicators', 'prohibited_inference_rules', 'scoring_guidance'
  ],
  evidence_check: [
    'canonical_definition', 'state_interpretation', 'evidence_requirements',
    'strong_evidence_examples', 'moderate_evidence_examples', 'weak_evidence_examples',
    'contradictory_evidence_examples', 'accepted_evidence_types', 'false_positive_guards',
    'validation_questions', 'detection_heuristics', 'prohibited_inference_rules', 'scoring_guidance'
  ],
  synthesis: [
    'canonical_definition', 'state_interpretation', 'evidence_requirements',
    'contradictory_evidence_examples', 'false_positive_guards', 'prohibited_inference_rules',
    'scoring_guidance', 'risk_notes'
  ],
  roadmap_synthesis: [
    'canonical_definition', 'related_capabilities', 'risk_notes',
    'remediation_tactic_notes', 'prohibited_inference_rules'
  ]
};

const REQUIRED_STAGE_SECTIONS: Record<KnowledgePacketStage, string[]> = {
  forensic_audit: ['canonical_definition', 'evidence_requirements', 'false_positive_guards', 'validation_questions', 'scoring_guidance'],
  evidence_check: ['canonical_definition', 'evidence_requirements', 'false_positive_guards', 'validation_questions'],
  synthesis: ['canonical_definition', 'evidence_requirements', 'false_positive_guards'],
  roadmap_synthesis: ['canonical_definition', 'risk_notes', 'remediation_tactic_notes']
};

const sectionSatisfied = (sections: Record<string, string>, key: string): boolean => {
  if (sections[key]?.trim()) return true;
  if (key === 'evidence_requirements') {
    return [
      'strong_evidence_examples', 'moderate_evidence_examples', 'weak_evidence_examples',
      'contradictory_evidence_examples', 'accepted_evidence_types'
    ].some(child => sections[child]?.trim());
  }
  return false;
};

const shadowHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const stageForLabel = (label?: string): KnowledgePacketStage => {
  if (label?.includes('evidence')) return 'evidence_check';
  if (label?.includes('roadmap') || label?.includes('strategy')) return 'roadmap_synthesis';
  if (label?.includes('synthesis')) return 'synthesis';
  return 'forensic_audit';
};

export const buildShadowKnowledgePacket = (
  index: RemoteKnowledgeBaseIndex,
  options: { batchId?: string; stage: KnowledgePacketStage }
): ShadowKnowledgePacket => {
  const sourceDocuments = (index.documents || [])
    .filter(doc => !options.batchId || doc.domain_id === options.batchId)
    .sort((a, b) => `${a.stream}.${a.criterion_id}`.localeCompare(`${b.stream}.${b.criterion_id}`));
  const missingRequirements: string[] = [];
  const coverageIssues: string[] = [];
  const oversizedSections: string[] = [];
  const pageLimitDocuments: string[] = [];
  let packetChars = 0;
  const documents: ShadowKnowledgePacket['documents'] = [];

  const expectedDomains = options.batchId ? [options.batchId] : BATCH_IDS;
  const expectedDocumentKeys = new Set(expectedDomains.flatMap(domainId => (
    Array.from({ length: 5 }, (_, index) => [
      `maturity:${domainId}${index + 1}`,
      `antipattern:AP-${domainId}${index + 1}`
    ]).flat()
  )));
  const documentKeyCounts = new Map<string, number>();
  for (const doc of sourceDocuments) {
    const key = `${doc.stream}:${doc.criterion_id}`;
    documentKeyCounts.set(key, (documentKeyCounts.get(key) || 0) + 1);
  }
  for (const key of expectedDocumentKeys) {
    if (!documentKeyCounts.has(key)) coverageIssues.push(`missing:${key}`);
  }
  for (const [key, count] of documentKeyCounts) {
    if (!expectedDocumentKeys.has(key)) coverageIssues.push(`unexpected:${key}`);
    if (count > 1) coverageIssues.push(`duplicate:${key}:${count}`);
  }

  for (const doc of sourceDocuments) {
    const sections = doc.sections || {};
    if (!doc.kb_id) missingRequirements.push(`${doc.criterion_id}:kb_id`);
    if (!doc.version) missingRequirements.push(`${doc.criterion_id}:version`);
    if (!doc.pdf_sha256) missingRequirements.push(`${doc.criterion_id}:pdf_sha256`);
    if (!doc.extracted_text_sha256) missingRequirements.push(`${doc.criterion_id}:extracted_text_sha256`);
    if (!doc.allowed_uses.length) missingRequirements.push(`${doc.criterion_id}:allowed_uses`);
    if (!doc.forbidden_uses.length) missingRequirements.push(`${doc.criterion_id}:forbidden_uses`);
    if (doc.extraction?.section_order_valid === false) {
      missingRequirements.push(`${doc.criterion_id}:section_order_valid`);
    }
    if (doc.extraction?.duplicate_section_headings?.length) {
      missingRequirements.push(`${doc.criterion_id}:unique_section_headings`);
    }
    const required = [
      ...REQUIRED_STAGE_SECTIONS[options.stage],
      ...(doc.stream === 'antipattern' && options.stage !== 'roadmap_synthesis'
        ? ['state_interpretation', 'prohibited_inference_rules']
        : [])
    ];
    for (const key of new Set(required)) {
      if (!sectionSatisfied(sections, key)) missingRequirements.push(`${doc.criterion_id}:${key}`);
    }
    if (doc.extraction?.page_limit_reached) pageLimitDocuments.push(doc.criterion_id);

    const includedSections: string[] = [];
    const omittedSections: string[] = [];
    const parts: string[] = [];
    for (const key of STAGE_SECTION_KEYS[options.stage]) {
      const value = sections[key]?.trim();
      if (!value) continue;
      if (value.length > SHADOW_SECTION_LIMIT) {
        oversizedSections.push(`${doc.criterion_id}:${key}`);
        omittedSections.push(key);
        continue;
      }
      const part = `[KB_SECTION name="${key}"]\n${value}\n[/KB_SECTION]`;
      if (packetChars + part.length > SHADOW_PACKET_LIMIT) {
        omittedSections.push(key);
        continue;
      }
      includedSections.push(key);
      parts.push(part);
      packetChars += part.length;
    }
    documents.push({
      kb_id: doc.kb_id,
      version: doc.version,
      domain_id: doc.domain_id,
      capability_id: doc.capability_id,
      criterion_id: doc.criterion_id,
      stream: doc.stream,
      pdf_sha256: doc.pdf_sha256,
      extracted_text_sha256: doc.extracted_text_sha256,
      allowed_uses: [...doc.allowed_uses].sort(),
      forbidden_uses: [...doc.forbidden_uses].sort(),
      extraction_complete: !doc.extraction?.page_limit_reached,
      extraction_warnings: [
        ...(doc.extraction?.page_limit_reached ? ['PAGE_LIMIT_REACHED'] : []),
        ...(doc.extraction?.sparse_pages || []).map(page => `SPARSE_PAGE:${page}`),
        ...(doc.extraction?.section_order_valid === false ? ['SECTION_ORDER_INVALID'] : []),
        ...(doc.extraction?.duplicate_section_headings || []).map(key => `DUPLICATE_SECTION:${key}`)
      ],
      included_sections: includedSections,
      omitted_sections: omittedSections,
      text: parts.join('\n\n')
    });
  }

  const hashInput = JSON.stringify({
    schema_version: 'shadow_knowledge_packet_v1',
    mode: 'shadow',
    stage: options.stage,
    domain: options.batchId,
    source: index.status.source,
    documents
  });
  const ready = sourceDocuments.length > 0
    && index.status.source === 'remote_blob'
    && coverageIssues.length === 0
    && missingRequirements.length === 0
    && oversizedSections.length === 0
    && pageLimitDocuments.length === 0
    && documents.every(doc => doc.omitted_sections.length === 0);
  return {
    schema_version: 'shadow_knowledge_packet_v1',
    mode: 'shadow',
    stage: options.stage,
    domain_id: options.batchId,
    source: index.status.source,
    readiness: ready ? 'READY' : 'NOT_READY',
    packet_hash: shadowHash(hashInput),
    document_count: documents.length,
    char_count: packetChars,
    missing_requirements: missingRequirements,
    coverage_issues: coverageIssues,
    oversized_sections: oversizedSections,
    page_limit_documents: pageLimitDocuments,
    documents
  };
};

const formatKbDoc = (doc: RemoteKnowledgeBaseDocument, maxChars: number): string => {
  const allowed = doc.allowed_uses?.length ? doc.allowed_uses.join(', ') : 'rubric_context';
  const forbidden = doc.forbidden_uses?.length ? doc.forbidden_uses.join(', ') : 'customer_current_state_claim, source_evidence_quote';
  const categories = doc.evidence_categories?.length ? doc.evidence_categories.join(', ') : '(not declared)';
  return [
    `[${doc.stream.toUpperCase()} ${doc.criterion_id}] ${doc.title}`,
    `Domain: ${doc.domain_id} ${doc.domain_name}`,
    `Capability: ${doc.capability_id}`,
    `Evidence categories: ${categories}`,
    `Allowed uses: ${allowed}`,
    `Forbidden uses: ${forbidden}`,
    'Reference content:',
    normalizeKbText(doc.body_excerpt || '', maxChars),
  ].join('\n');
};

const formatRemoteKbContext = (
  index: RemoteKnowledgeBaseIndex,
  options: { batchId?: string; maxDocChars?: number; label?: string } = {}
): string => {
  const batchId = options.batchId;
  const maxDocChars = options.maxDocChars ?? (batchId ? 1400 : 650);
  const documents = (index.documents || [])
    .filter(doc => !batchId || doc.domain_id === batchId)
    .sort((a, b) => `${a.stream}.${a.criterion_id}`.localeCompare(`${b.stream}.${b.criterion_id}`));

  if (documents.length === 0) {
    const reason = index.failures?.[0]?.reason || 'remote KB unavailable';
    return `<REFERENCE_KNOWLEDGE_BASE status="fallback">
Remote PDF Knowledge Base unavailable or empty (${reason}). Use built-in criteria and tactics only.
</REFERENCE_KNOWLEDGE_BASE>`;
  }

  const scope = batchId ? `Batch ${batchId}` : 'All domains';
  return `<REFERENCE_KNOWLEDGE_BASE status="${index.status.source}" scope="${scope}" usage="rubric_reference_only_not_customer_evidence">
Remote PDF Knowledge Base loaded: ${index.status.document_count} document(s), ${index.status.failure_count} parse/validation issue(s).

BOUNDARIES:
- Use this KB only for rubric interpretation, evidence requirements, false-positive checks, validation questions, and roadmap/remediation patterns.
- Never cite this KB as proof of the assessed customer's current state.
- Never copy KB text into source_evidence_quote.
- Evidence summaries and diagnosis must remain grounded in uploaded source material, Phase 1 evidence quotes, and Phase 2 metrics.

${documents.map(doc => formatKbDoc(doc, maxDocChars)).join('\n\n---\n\n')}
</REFERENCE_KNOWLEDGE_BASE>`;
};

export const knowledgeBaseService = {
  async fetchReferenceKnowledgeBaseIndex(): Promise<RemoteKnowledgeBaseIndex> {
    if (remoteKbIndexPromise) return remoteKbIndexPromise;
    remoteKbIndexPromise = (async () => {
      try {
        if (typeof fetch !== 'function') {
          return emptyRemoteKbIndex('fetch API unavailable');
        }
        const response = await fetch('/api/kb-index', {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error(`/api/kb-index HTTP ${response.status}`);
        }
        const index = await response.json() as RemoteKnowledgeBaseIndex;
        if (!index?.documents) {
          return emptyRemoteKbIndex('remote KB index response was malformed');
        }
        if (index.status?.source === 'remote_blob') {
          console.info(`[FinOps KnowledgeBase] Remote PDF KB loaded: ${index.status.document_count} documents.`);
        } else {
          console.info('[FinOps KnowledgeBase] Using built-in KB fallback (error_code=REMOTE_KB_FALLBACK).');
        }
        return index;
      } catch (error: any) {
        console.warn('[FinOps KnowledgeBase] Remote PDF KB unavailable; using built-in fallback (error_code=REMOTE_KB_UNAVAILABLE).');
        return emptyRemoteKbIndex(error?.message || String(error));
      }
    })();
    return remoteKbIndexPromise;
  },

  async fetchReferenceKnowledgeBaseContext(options: { batchId?: string; maxDocChars?: number; label?: string } = {}): Promise<string> {
    const index = await this.fetchReferenceKnowledgeBaseIndex();
    const shadowPacket = buildShadowKnowledgePacket(index, {
      batchId: options.batchId,
      stage: stageForLabel(options.label)
    });
    const shadowKey = `${options.batchId || 'all'}:${shadowPacket.stage}`;
    index.status.shadow_packets = {
      ...(index.status.shadow_packets || {}),
      [shadowKey]: {
        stage: shadowPacket.stage,
        domain_id: shadowPacket.domain_id,
        readiness: shadowPacket.readiness,
        packet_hash: shadowPacket.packet_hash,
        document_count: shadowPacket.document_count,
        char_count: shadowPacket.char_count,
        missing_requirement_count: shadowPacket.missing_requirements.length,
        coverage_issue_count: shadowPacket.coverage_issues.length,
        oversized_section_count: shadowPacket.oversized_sections.length,
        page_limit_document_count: shadowPacket.page_limit_documents.length
      }
    };
    console.info(
      `[FinOps KnowledgeBase] Shadow packet stage=${shadowPacket.stage} readiness=${shadowPacket.readiness}`
      + ` documents=${shadowPacket.document_count} missing=${shadowPacket.missing_requirements.length}`
      + ` coverage=${shadowPacket.coverage_issues.length}`
      + ` oversized=${shadowPacket.oversized_sections.length} page_limited=${shadowPacket.page_limit_documents.length}`
    );
    return formatRemoteKbContext(index, options);
  },

  async fetchStrategicPlaybook(): Promise<string> {
    let tactics: StrategicTactic[] = [];
    let blobUrl: string | undefined = undefined;

    const HARDCODED_URL = "";

    const meta = import.meta as any;
    if (meta?.env?.VITE_FINOPS_TACTICS_URL) {
      blobUrl = meta.env.VITE_FINOPS_TACTICS_URL;
    }

    if (!blobUrl) {
      try {
        // @ts-ignore
        if (typeof process !== 'undefined' && process.env?.VITE_FINOPS_TACTICS_URL) {
          // @ts-ignore
          blobUrl = process.env.VITE_FINOPS_TACTICS_URL;
        }
      } catch (e) {}
    }

    if (blobUrl) {
      try {
        console.log(`[FinOps KnowledgeBase] Fetching tactics DB from Vercel Blob...`);
        const response = await fetch(blobUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          cache: 'force-cache'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        tactics = await response.json();
      } catch (error) {
        console.error("[FinOps KnowledgeBase] Remote fetch failed; using local DB (error_code=REMOTE_PLAYBOOK_UNAVAILABLE).");
        tactics = FINOPS_TACTICS_LOCAL;
      }
    } else {
      console.info("[FinOps KnowledgeBase] No remote URL configured. Using built-in tactics database.");
      tactics = FINOPS_TACTICS_LOCAL;
    }

    if (!tactics || tactics.length === 0) {
      tactics = FALLBACK_TACTICS;
    }

    const formattedContext = tactics.map(t => {
      let entry = `[${t.category}] IF FOUND "${t.problem_pattern}" -> PRESCRIBE "${t.solution_mechanism}".`;
      entry += `\n   PROOF: ${t.case_study}`;
      if (t.prerequisites?.length) {
        entry += `\n   PREREQUISITES: ${t.prerequisites.join(', ')}`;
      }
      if (t.expected_outcome) {
        entry += `\n   EXPECTED OUTCOME: ${t.expected_outcome}`;
      }
      if (t.risk_notes) {
        entry += `\n   RISK: ${t.risk_notes}`;
      }
      if (t.resource_label) {
        entry += `\n   REFERENCE: ${t.resource_label}`;
      }
      return entry;
    }).join("\n\n");

    const activityContext = buildTacticActivityContext(tactics);

    return `<VERIFIED_TACTICS_DATABASE>
${formattedContext}
</VERIFIED_TACTICS_DATABASE>

<TACTIC_ACTIVITY_PLAYBOOK usage="roadmap_activity_guidance_only_not_customer_evidence">
BOUNDARIES:
- Use this playbook only to enrich roadmap WHY, WHAT, and HOW for tactic actions that are already grounded in locked findings.
- Never cite this playbook as proof of the assessed organization's current state.
- Never copy this playbook into source_evidence_quote.
- If the locked findings do not match the tactic coverage or use-when rules, withhold the tactic ID.

${activityContext || '(no tactic activity playbook entries available)'}
</TACTIC_ACTIVITY_PLAYBOOK>`;
  }
};
