
import { StrategicTactic } from '../types';
import criteriaData from './finops_criteria.json';
import antipatternData from './finops_antipatterns.json';
import keywordsData from './finops_preflight_keywords.json';
import taxonomyData from './finops_evidence_taxonomy.json';
import personasData from './finops_personas.json';
import tacticsData from './finops_tactics_database.json';
import validationData from './finops_validation_rules.json';

export const FINOPS_CRITERIA = criteriaData.criteria;
export const FINOPS_ANTIPATTERNS = antipatternData.criteria;
export const FINOPS_KEYWORDS = keywordsData;
export const FINOPS_EVIDENCE_TAXONOMY = taxonomyData;
export const FINOPS_PERSONAS = personasData;
export const FINOPS_TACTICS_LOCAL = tacticsData.tactics as StrategicTactic[];
export const FINOPS_VALIDATION_RULES = validationData;

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
  E: 'Culture & Organization'
};

export const BATCH_DEFINITIONS: Record<string, BatchDefinition> = {};
for (const batchId of ['A', 'B', 'C', 'D', 'E']) {
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
    *   *Stream B (Anti-Pattern):* This is **GOOD** (Clean/Healthy).
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

*   **Tagging / cost allocation policy:** Expect evidence in A1 (tagging), A2 (allocation). Expect SILENCE in B (optimization), D (architecture), E (culture). Anti-patterns: expect SILENCE — a policy doc declares intent, it does not describe organizational behavior.
*   **Cloud governance / FinOps policy:** Expect evidence in C1–C5 (governance, policy, procurement, compliance) and A1 (tagging declared). Expect SILENCE in B (no actual optimization actions), D (no architecture details), E1–E3 (no observed culture).
*   **FinOps team charter / CoE model:** Expect evidence in C1 (FinOps team), E4 (executive sponsorship if signed). Expect SILENCE in A4 (dashboards not described), B (no optimization described), D (no architecture).
*   **Cloud strategy document:** Expect SCATTERED evidence at score 1 across A, C, D — strategy documents describe intent, not operations. "Plans = Score 1 max" applies aggressively here. Expect SILENCE in detailed operational evidence.
*   **RI / Savings Plan strategy:** Expect evidence in B1 (commitments) and possibly B5 (storage). Expect SILENCE in A (no allocation), C (no governance framing), D (no architecture), E (no culture).
*   **Cost optimization review / report:** Expect evidence in B1–B5 (optimization is the topic) and possibly A4 (dashboards used for the review). May contain LEGITIMATE anti-pattern evidence in B (waste, over-provisioning) because the review surfaced them. Expect SILENCE in C policy and E culture.
*   **Dashboard screenshot (image input):** A single dashboard image evidences A4 (Cloud Cost Dashboards) at Score 2–3 — the dashboard is in use. Possibly A2 (Showback) if breakdown by team/cost-center is visible. Expect SILENCE on B/C/D/E unless the dashboard explicitly displays those signals. Evidence_source is "image".
*   **Architecture diagram (image input):** May evidence D1 (Cost-Aware Architecture), D2 (IaC), D3 (Scaling), D4 (Multi-Cloud) depending on what is annotated. Expect SILENCE on A/B/C/E unless the diagram shows tagging, cost annotations, or org-level callouts. Evidence_source is "image".
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

export const knowledgeBaseService = {
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
        console.error("[FinOps KnowledgeBase] Remote fetch failed, using local DB:", error);
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

    return `<VERIFIED_TACTICS_DATABASE>\n${formattedContext}\n</VERIFIED_TACTICS_DATABASE>`;
  }
};
