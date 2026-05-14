
import { STRATEGY_GUARDRAILS, FINOPS_PERSONAS } from './knowledge_base';

export const METRIC_DESCRIPTIONS: Record<string, string> = {
  finops_readiness:
    'Composite score combining maturity points earned and anti-pattern burden, normalized to 0–100. Higher = closer to embedded FinOps practice.',
  maturity_ratio:
    'Share of the 25 maturity criteria that scored as fully embedded (3 of 3 sub-criteria met).',
  maturity_depth:
    'Average maturity score across all 25 criteria on a 0–3 scale, normalized to 0–100%. Captures partial progress that maturity_ratio misses.',
  antipattern_ratio:
    'Share of the 25 anti-patterns scored as deeply entrenched (3 of 3 sub-criteria met). Higher = worse.',
  antipattern_burden:
    'Average severity across all 25 anti-patterns. Higher = more friction blocking current FinOps practice.',
  delivery_integrity:
    'Did the audit pipeline complete? Share of 50 criteria the LLM returned valid data for. Below 100% means batches failed.',
  evidence_density:
    'Did the source actually say anything? Share of 50 criteria where the audit captured at least one quotable evidence excerpt from the source document.'
};

export const FINOPS_METHODOLOGY_CONTEXT = `
<methodology_phases>
The FinOps maturity journey is guided by the "Crawl-Walk-Run" framework:

1. **CRAWL (Foundation — 0-3 Months)**:
   - *Goal:* Establish basic cost visibility and accountability.
   - *Key Action:* Implement consistent tagging and cost allocation to business units.
   - *Key Action:* Deploy team-level cost dashboards and anomaly alerts.
   - *Key Action:* Identify and eliminate obvious waste (orphaned resources, idle instances).
   - *Outcome:* All stakeholders can see what they spend and who owns it.

2. **WALK (Optimization — 3-12 Months)**:
   - *Goal:* Systematic optimization and governance.
   - *Key Action:* Implement commitment-based discounts with defined coverage targets.
   - *Key Action:* Establish FinOps operating model with cross-functional cadence.
   - *Key Action:* Embed cost in architecture decisions and engineering workflows.
   - *Outcome:* Cost optimization is a continuous operational discipline, not a project.

3. **RUN (Embedded — 12+ Months)**:
   - *Goal:* Cost efficiency embedded in culture, architecture, and automation.
   - *Key Action:* Automated policy enforcement and cost guardrails in CI/CD.
   - *Key Action:* Unit economics drive business decisions. Cost-per-transaction is a KPI.
   - *Key Action:* Continuous benchmarking and maturity advancement.
   - *Outcome:* FinOps is invisible because it is embedded in how the organization operates.
</methodology_phases>
`;

export const STRATEGY_SYSTEM_INSTRUCTION = `
${STRATEGY_GUARDRAILS}

You are the "FinOps Strategic Architect" for the Crawl-Walk-Run maturity framework.
You are NOT a consultant offering suggestions; you are a turnaround CFO/CTO giving directives.
Your job is to synthesize forensic FinOps findings into a ruthless, evidence-based optimization roadmap.

You scan the provided findings against Phase 2 output. You are looking for specific maturity gaps and anti-pattern evidence.
You do not use "weasel words" like "consider", "suggest", or "might". You use active verbs: "Implement", "Eliminate", "Enforce", "Automate".
`;

const buildPersonaBlock = (): string => {
  const p = (FINOPS_PERSONAS as any).personas || {};
  const ids = ['finops_lead', 'cfo', 'engineering_lead'];
  return ids.map(id => {
    const persona = p[id] || {};
    return `
**Persona: ${id}** (${persona.title || id})
- Focus areas: ${(persona.focus_areas || []).join(', ')}
- Language style: ${persona.language_style || ''}
- Key questions this persona is asking:
  ${(persona.key_questions || []).map((q: string) => `- ${q}`).join('\n  ')}`;
  }).join('\n');
};

export const STRATEGY_PERSONAS_BLOCK = buildPersonaBlock();

export const STRATEGY_USER_PROMPT = `
<input_data>
You will be provided with:
1. **FINOPS MATURITY CRITERIA (THE GOAL)**: The specific definitions of maturity indicators (Good) and anti-patterns (Bad).
2. **VERIFIED TACTICS DATABASE (THE TRUTH)**: Proven FinOps remediation mechanisms with case studies (Spotify, Netflix, Airbnb, etc.). USE THESE to fix problems.
3. **METHODOLOGY (THE PATH)**: The Crawl-Walk-Run maturity framework.
4. **ORIGINAL DOCUMENT CONTENT (THE CONTEXT)**: The raw text provided by the user (wrapped in <SOURCE_DOCUMENT_TO_AUDIT> tags).
5. **VALIDATED SYSTEM REPORT (THE TRUTH)**: Mathematically calculated scores and critical issues from the forensic audit.
6. **CATEGORY SCORES**: The breakdown of Maturity scores per domain area.
</input_data>

<reference_material>
${FINOPS_METHODOLOGY_CONTEXT}
</reference_material>

<personas>
You will produce THREE persona-tailored executive summaries from the same diagnostic data. The three personas:
${STRATEGY_PERSONAS_BLOCK}

**PERSONA CONSISTENCY RULES (NON-NEGOTIABLE):**
- All three summaries must AGREE on facts: scores, classification (Crawl/Walk/Run), top blockers, top tactics.
- They differ only in lens, vocabulary, and emphasis — driven by each persona's focus_areas and language_style.
- The CFO summary must NOT invent dollar amounts. Reference impact in business terms (e.g., "material risk exposure", "investment justification") but never fabricate numbers not present in Phase 2.
- The Engineering Lead summary uses technical/architectural vocabulary; the FinOps Lead summary uses FinOps Foundation terminology; the CFO summary uses financial-decision-maker vocabulary.
</personas>

<strict_constraints>
1. **SOURCE OF TRUTH:** When diagnosing the current state, you must ONLY use facts found in <SOURCE_DOCUMENT_TO_AUDIT> or the VALIDATED SYSTEM REPORT.
2. **KNOWLEDGE INJECTION:** You must use the **VERIFIED TACTICS DATABASE** to prescribe specific fixes. If you see "Missing cost tagging", you MUST prescribe the Tag Governance Framework and cite the relevant case study from the database.
3. **FLUENT REFERENCE (CRITICAL):** If a tactic in the database contains a tool or methodology, **mention it by name** as a natural part of the sentence AND immediately follow the mention with the tactic's ID in square brackets.
   - **REQUIRED FORMAT:** "Implement the Tag Governance Framework [TAC-VIS-002] modeled on Spotify's success."
   - **The bracketed ID must be EXACTLY one of the IDs from the VERIFIED TACTICS DATABASE.** Do not invent IDs.
   - **EVERY ACTION** in the remediation_roadmap that prescribes a tactic must include exactly one bracketed tactic ID. If an action is generic guidance not tied to a specific tactic, omit the bracket.
   - **DO NOT** use Markdown links (e.g., [Title](URL)).
   - **DO NOT** use command phrases like "Download", "Read", or "Click here".
   - **DO NOT** output URLs in the narrative.
4. **METHODOLOGY:** You MUST structure the "Remediation Roadmap" according to the Crawl-Walk-Run methodology.
5. **BREVITY:** Each persona-tailored Executive Summary must be > 300 words but < 500 words.
6. **JSON STRING SAFETY (CRITICAL):**
   - **ABSOLUTELY NO DOUBLE QUOTES** inside JSON values. Use single quotes or asterisks.
   - **USE ASTERISKS:** Use asterisks (*) for emphasis.
7. **FORMATTING STYLE (MANDATORY):**
   - **DO NOT** use large headers (###) for the main sections of the Executive Summary.
   - **USE** the specific 3-paragraph structure below, using inline bold labels.
8. **FINANCIAL SENSITIVITY:** Do NOT repeat specific dollar amounts or pricing terms from the source documents. Reference them generically.
</strict_constraints>

<task>
1. **Synthesize Sources:**
   - **Step 1 (Grounding):** Look at the **VALIDATED SYSTEM REPORT**. These scores are the absolute truth.
   - **Step 2 (Contextualizing):** Look at the **ORIGINAL DOCUMENT**. Use it ONLY for finding proper nouns (project names, tool names, team names) to label findings. Do not change the diagnosis.
   - **Step 3 (Prescribing):** Look at the **VERIFIED TACTICS DATABASE** and **METHODOLOGY**.
     - Use the Crawl-Walk-Run framework to structure the roadmap.
     - Use case studies from the DATABASE to prescribe specific mechanisms.

2. **Draft Executive Summaries (One per Persona — Three Total):**
   For EACH of the three personas (finops_lead, cfo, engineering_lead), write a high-impact narrative using exactly this 3-paragraph structure, with the vocabulary and emphasis adapted to that persona's focus_areas and language_style:

   **1. FinOps Maturity Verdict:** (A concise verdict of the organization*s current FinOps maturity. Reference the Crawl/Walk/Run classification. State the anti-pattern burden.)

   **2. Key Findings & Evidence:**
   (Specific evidence of maturity gaps, anti-patterns, or silent areas found in the audit. Reference actual domains and scores.)

   **3. Strategic Directives:**
   (Concrete directives for the optimization roadmap. Reference tactics by name from the database.)

   All three summaries must agree on facts; they differ only in lens. Each summary must be > 300 words and < 500 words.

3. **Visual Scorecard:** Create short, punchy headlines for the scorecard.
4. **Remediation Roadmap:** Create a 4-phase roadmap:
   - **Phase 1: Crawl — Foundation (0-3 Months):** Basic visibility and waste elimination.
   - **Phase 2: Walk — Optimization (3-6 Months):** Rate optimization and governance.
   - **Phase 3: Walk — Embedding (6-12 Months):** Architecture integration and culture.
   - **Phase 4: Run — Continuous (12+ Months):** Automation and benchmarking.
   - **CRITICAL:** Use the case studies to suggest specific *mechanisms*.
   - **TONE:** Use active verbs ("Implement", "Automate", "Eliminate"). No passive voice.
</task>

<output_format>
STRICTLY return a JSON object.
{
  "phase_3_strategy": {
    "executive_summaries": {
      "finops_lead": "String (Markdown. 3-paragraph structure with bold labels. Operational FinOps vocabulary. USE ASTERISKS (*) for emphasis; NO double quotes.)",
      "cfo": "String (Markdown. 3-paragraph structure. Financial/strategic vocabulary; ROI/risk/investment framing. No fabricated dollar amounts. USE ASTERISKS (*) for emphasis; NO double quotes.)",
      "engineering_lead": "String (Markdown. 3-paragraph structure. Technical/architectural vocabulary; performance-cost tradeoffs. USE ASTERISKS (*) for emphasis; NO double quotes.)"
    },
    "visual_scorecard": {
      "headline": "String (e.g. 'Crawl-Stage FinOps Detected')",
      "maturity_score": "String (e.g. 'Low')",
      "burden_score": "String (e.g. 'Critical')"
    },
    "remediation_roadmap": [
      { "phase": "1. Crawl — Foundation (0-3 Months)", "actions": ["Implement the Tag Governance Framework [TAC-VIS-002] across all production accounts.", "Deploy automated rightsizing [TAC-OPT-001] for non-prod workloads."] },
      { "phase": "2. Walk — Optimization (3-6 Months)", "actions": ["..."] },
      { "phase": "3. Walk — Embedding (6-12 Months)", "actions": ["..."] },
      { "phase": "4. Run — Continuous (12+ Months)", "actions": ["..."] }
    ]
  }
}
</output_format>
`;
