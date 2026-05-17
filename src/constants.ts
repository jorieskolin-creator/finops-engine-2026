
import { STRATEGY_GUARDRAILS, FINOPS_PERSONAS } from './knowledge_base';

export const METRIC_DESCRIPTIONS: Record<string, string> = {
  finops_readiness:
    'Evidence-gated readiness score. Based on validated maturity depth, reduced by confirmed anti-pattern burden, and capped when source evidence is sparse.',
  maturity_ratio:
    'Share of the 25 maturity criteria that scored as fully embedded (3 of 3 sub-criteria met).',
  maturity_depth:
    'Average maturity score across all 25 criteria on a 0–3 scale, normalized to 0–100%. Captures partial progress that maturity_ratio misses.',
  antipattern_ratio:
    'Share of the 25 anti-patterns scored as deeply entrenched (3 of 3 sub-criteria met). Higher = worse.',
  antipattern_burden:
    'Average severity across all 25 anti-patterns. Higher = more friction blocking current FinOps practice. Low values mean "low confirmed burden" only when source evidence is strong enough.',
  antipattern_clearance:
    'Share of anti-patterns that were meaningfully tested and not found. This is positive only when the source had relevant coverage.',
  antipattern_coverage:
    'Share of anti-pattern criteria that were meaningfully assessed, either as findings or verified absences. Low coverage means absence is unknown, not good.',
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
You will produce THREE persona-tailored evidence summaries from the same diagnostic data. These are summary-only views; diagnosis and plan are separate JSON objects. The three personas:
${STRATEGY_PERSONAS_BLOCK}

**PERSONA CONSISTENCY RULES (NON-NEGOTIABLE):**
- All three summaries must AGREE on facts: scores, classification (Insufficient evidence/Crawl/Walk/Run), confirmed findings, gaps, and anti-pattern burden.
- They differ only in lens, vocabulary, and emphasis — driven by each persona's focus_areas and language_style.
- They must NOT include tactic IDs, external case studies, implementation directives, or roadmap actions. Those belong only in planning_decision and remediation_roadmap.
- The CFO summary must NOT invent dollar amounts. Reference impact in business terms (e.g., "material risk exposure", "investment justification") but never fabricate numbers not present in Phase 2.
- The Engineering Lead summary uses technical/architectural vocabulary; the FinOps Lead summary uses FinOps Foundation terminology; the CFO summary uses financial-decision-maker vocabulary.
</personas>

<strict_constraints>
1. **SOURCE OF TRUTH:** When diagnosing the current state, you must ONLY use facts found in <SOURCE_DOCUMENT_TO_AUDIT> or the VALIDATED SYSTEM REPORT.
2. **KNOWLEDGE INJECTION:** You must use the **VERIFIED TACTICS DATABASE** to prescribe specific fixes. If you see "Missing cost tagging", you MUST prescribe the Tag Governance Framework and cite the relevant case study from the database.
3. **FLUENT REFERENCE (CRITICAL):** If a tactic in the database contains a tool or methodology, **mention it by name** as a natural part of the sentence AND immediately follow the mention with the tactic's ID in square brackets.
   - **REQUIRED FORMAT:** "Implement the Tag Governance Framework [TAC-VIS-001] modeled on Spotify's success."
   - **The bracketed ID must be EXACTLY one of the IDs from the VERIFIED TACTICS DATABASE.** Do not invent IDs.
   - **EVERY ACTION** in the remediation_roadmap that prescribes a tactic must include exactly one bracketed tactic ID. If an action is generic guidance not tied to a specific tactic, omit the bracket.
   - **DO NOT** use Markdown links (e.g., [Title](URL)).
   - **DO NOT** use command phrases like "Download", "Read", or "Click here".
   - **DO NOT** output URLs in the narrative.
4. **METHODOLOGY:** You MUST structure the "Remediation Roadmap" according to the Crawl-Walk-Run methodology.
5. **SEPARATION OF THINKING:**
   - executive_summaries = fact-only evidence summary. No prescriptions, no tactic IDs, no case studies.
   - diagnosis = interpretation of why the current state exists. No implementation roadmap.
   - planning_decision + remediation_roadmap = prognosis and next steps.
6. **BREVITY:** Each persona-tailored evidence summary must be > 180 words but < 320 words.
7. **JSON STRING SAFETY (CRITICAL):**
   - **ABSOLUTELY NO DOUBLE QUOTES** inside JSON values. Use single quotes or asterisks.
   - **USE ASTERISKS:** Use asterisks (*) for emphasis.
8. **FORMATTING STYLE (MANDATORY):**
   - **DO NOT** use large headers (###) for the main sections of the evidence summary.
   - **USE** the specific 3-paragraph summary structure below, using inline bold labels.
9. **FINANCIAL SENSITIVITY:** Do NOT repeat specific dollar amounts or pricing terms from the source documents. Reference them generically.
</strict_constraints>

<task>
1. **Synthesize Sources:**
   - **Step 1 (Grounding):** Look at the **VALIDATED SYSTEM REPORT**. These scores are the absolute truth.
   - **Step 2 (Contextualizing):** Look at the **ORIGINAL DOCUMENT**. Use it ONLY for finding proper nouns (project names, tool names, team names) to label findings. Do not change the diagnosis.
   - **Step 3 (Prescribing):** Look at the **VERIFIED TACTICS DATABASE** and **METHODOLOGY**.
     - Use the Crawl-Walk-Run framework to structure the roadmap.
     - Use case studies from the DATABASE to prescribe specific mechanisms.

2. **Draft Evidence Summaries (One per Persona — Three Total):**
   For EACH persona (finops_lead, cfo, engineering_lead), write a fact-only summary using exactly this 3-paragraph structure, adapted to that persona's vocabulary and emphasis:

   **1. Current-State Snapshot:** State the evidence-gated classification, readiness score, maturity depth, anti-pattern burden, anti-pattern clearance/coverage, delivery integrity, and evidence density.

   **2. Evidence-Backed Findings:** Summarize confirmed FinOps maturity strengths, confirmed gaps, confirmed anti-pattern findings, verified anti-pattern absences, anti-patterns not assessable from source, and silent areas. Reference domains and scores only when present in Phase 2 or Phase 1. If source material has generic process facts but no FinOps evidence, describe them as source observations outside FinOps scope.

   **3. Source Confidence & Boundaries:** State what the evidence can and cannot support. Do NOT include recommendations, tactic IDs, external case studies, or implementation directives.

   All three summaries must agree on facts; they differ only in lens. Each summary must be > 180 words and < 320 words.

3. **Evidence Summary Object:** Populate evidence_summary with concise, fact-only bullets derived from Phase 1/2. Put items in confirmed_strengths only when they are FinOps-relevant strengths. If the assessment is Insufficient evidence, generic process facts may be listed there only as source observations, not as maturity proof.
4. **Diagnosis Object:** Populate diagnosis with interpretation: primary bottleneck, root causes, per-domain diagnosis, confidence, and confidence rationale. No tactic IDs or roadmap actions.
5. **Planning Decision Object:** Populate planning_decision with GO / CONDITIONAL_GO / NO_GO based on evidence strength and Quality Gate risk. This is the bridge from diagnosis to plan.
6. **Visual Scorecard:** Create short, punchy headlines for the scorecard.
7. **Remediation Roadmap:** Create a 4-phase roadmap:
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
      "finops_lead": "String (Markdown. FACT-ONLY 3-paragraph summary. No directives, no tactic IDs.)",
      "cfo": "String (Markdown. FACT-ONLY 3-paragraph summary. No directives, no tactic IDs.)",
      "engineering_lead": "String (Markdown. FACT-ONLY 3-paragraph summary. No directives, no tactic IDs.)"
    },
    "evidence_summary": {
      "headline": "String, fact-only current-state headline",
      "maturity_classification": "Insufficient evidence | Crawl | Walk | Walk with significant friction | Run",
      "key_metrics": ["String bullets with Phase 2 numbers"],
      "confirmed_strengths": ["String bullets. FinOps-relevant strengths only; in Insufficient evidence, generic facts are source observations, not maturity strengths."],
      "confirmed_gaps": ["String bullets"],
      "confirmed_antipatterns": ["String bullets"],
      "silent_or_missing_evidence": ["String bullets"]
    },
    "diagnosis": {
      "primary_bottleneck": "String, interpretation of the main maturity blocker",
      "root_causes": ["String bullets"],
      "domain_diagnosis": { "A": "...", "B": "...", "C": "...", "D": "...", "E": "..." },
      "confidence": "high | medium | low",
      "confidence_rationale": "String"
    },
    "planning_decision": {
      "decision": "GO | CONDITIONAL_GO | NO_GO",
      "rationale": "String explaining actionability",
      "safe_to_act_on": ["String bullets"],
      "evidence_needed_before_action": ["String bullets"]
    },
    "visual_scorecard": {
      "headline": "String (e.g. 'Crawl-Stage FinOps Detected')",
      "maturity_score": "String (e.g. 'Low')",
      "burden_score": "String (e.g. 'Critical')"
    },
    "remediation_roadmap": [
      { "phase": "1. Crawl — Foundation (0-3 Months)", "actions": ["Implement the Tag Governance Framework [TAC-VIS-001] across all production accounts.", "Deploy automated rightsizing [TAC-OPT-002] for non-prod workloads."] },
      { "phase": "2. Walk — Optimization (3-6 Months)", "actions": ["..."] },
      { "phase": "3. Walk — Embedding (6-12 Months)", "actions": ["..."] },
      { "phase": "4. Run — Continuous (12+ Months)", "actions": ["..."] }
    ]
  }
}
</output_format>
`;


// ============================================================================
// SPLIT synthesis prompts. The first pass is evidence-only and intentionally
// does NOT receive the tactics KB. The second pass receives the locked findings
// plus the KB and may only prescribe actions that trace back to those findings.
// ============================================================================
export const EVIDENCE_SYNTHESIS_SYSTEM_INSTRUCTION = `
You are an evidence-only FinOps assessment reviewer.
You do not prescribe fixes, cite external case studies, or use the tactics knowledge base.
Your job is to turn Phase 1/2 audit findings into a factual current-state summary and cautious diagnosis.
If a cause is not directly evidenced, label it as a hypothesis or omit it.
`;

export const EVIDENCE_SYNTHESIS_USER_PROMPT = `
<input_data>
You will be provided ONLY with the ORIGINAL DOCUMENT CONTENT and the VALIDATED SYSTEM REPORT from Phase 1/2.
You will NOT receive the Verified Tactics Database. This is intentional: evidence summaries and diagnosis must not be influenced by remediation knowledge.
</input_data>

<personas>
Produce THREE persona-tailored evidence summaries from the same findings. They are summary-only views; they must not contain roadmap actions, tactic IDs, external companies, or prescriptions.
${STRATEGY_PERSONAS_BLOCK}
</personas>

<strict_constraints>
1. **NO KNOWLEDGE-BASE INJECTION:** Do not mention tactic IDs, external case studies, benchmark companies, or remediation mechanisms. If the text is not in Phase 1/2 findings or the source, it does not belong here.
2. **FINDINGS ONLY:** executive_summaries and evidence_summary must contain only Phase 2 metrics, Phase 1 supported findings, and explicitly silent/missing evidence.
3. **DIAGNOSIS IS CAUTIOUS:** diagnosis may interpret score patterns, but root causes must be directly supported by evidence. If a cause is plausible but not evidenced, phrase it as an evidence gap, not a fact.
4. **NO IMPLEMENTATION LANGUAGE:** Do not use directive verbs such as Implement, Enforce, Automate, Launch, Establish, Deploy, or Optimize except when quoting source evidence.
5. **SOURCE-TYPE SAFETY:** If the source appears to describe best practices, case studies, or methodology rather than the audited organization's operations, say the audit can assess document coverage but cannot prove operational adoption.
6. **JSON STRING SAFETY:** No double quotes inside JSON values. Use single quotes or asterisks.
</strict_constraints>

<task>
1. Draft persona evidence summaries using this 3-paragraph structure:
   **1. Current-State Snapshot:** classification, evidence-gated readiness score, maturity depth, anti-pattern burden, anti-pattern clearance/coverage, delivery integrity, and evidence density.
   **2. Evidence-Backed Findings:** confirmed FinOps strengths, confirmed gaps, confirmed anti-pattern findings, verified anti-pattern absences, anti-patterns not assessable from source, and silent areas with domain scores where present. If the source has generic process facts but no FinOps evidence, describe them as source observations outside FinOps scope.
   **3. Source Confidence & Boundaries:** what the evidence can and cannot prove. No recommendations.
2. Populate evidence_summary with concise fact-only bullets.
3. Populate diagnosis as interpretation only; no roadmap, no tactic IDs, no prescriptions.
4. Populate visual_scorecard from Phase 2 metrics.
</task>

<output_format>
STRICTLY return JSON:
{
  "phase_3_strategy": {
    "executive_summaries": {
      "finops_lead": "String, Markdown, fact-only 3-paragraph summary",
      "cfo": "String, Markdown, fact-only 3-paragraph summary",
      "engineering_lead": "String, Markdown, fact-only 3-paragraph summary"
    },
    "evidence_summary": {
      "headline": "String, fact-only current-state headline",
      "maturity_classification": "Insufficient evidence | Crawl | Walk | Walk with significant friction | Run",
      "key_metrics": ["String bullets with Phase 2 numbers"],
      "confirmed_strengths": ["String bullets. FinOps-relevant strengths only; in Insufficient evidence, generic facts are source observations, not maturity strengths."],
      "confirmed_gaps": ["String bullets"],
      "confirmed_antipatterns": ["String bullets"],
      "silent_or_missing_evidence": ["String bullets"]
    },
    "diagnosis": {
      "primary_bottleneck": "String, interpretation of the main evidenced blocker",
      "root_causes": ["String bullets; direct evidence only or clearly marked as evidence gaps"],
      "domain_diagnosis": { "A": "...", "B": "...", "C": "...", "D": "...", "E": "..." },
      "confidence": "high | medium | low",
      "confidence_rationale": "String"
    },
    "visual_scorecard": {
      "headline": "String",
      "maturity_score": "String",
      "burden_score": "String"
    }
  }
}
</output_format>
`;

export const ROADMAP_SYNTHESIS_SYSTEM_INSTRUCTION = `
You are the FinOps roadmap planner for the Crawl-Walk-Run maturity framework.
You receive a locked evidence summary and diagnosis plus the verified tactics knowledge base.
Your job is to decide whether action is safe and produce a roadmap only where actions are logically grounded in the locked findings.
Do not modify the locked summary or diagnosis.
`;

export const ROADMAP_SYNTHESIS_USER_PROMPT = `
<input_data>
You will be provided with:
1. **LOCKED FINDINGS JSON:** evidence summaries, evidence_summary, diagnosis, and visual_scorecard already created without the tactics KB. Treat these as immutable.
2. **VERIFIED TACTICS DATABASE:** approved remediation mechanisms and tactic IDs.
3. **METHODOLOGY:** Crawl-Walk-Run sequencing.
4. **PHASE 2 METRICS:** numeric confidence signals and Quality Gate precursors.
</input_data>

<reference_material>
${FINOPS_METHODOLOGY_CONTEXT}
</reference_material>

<strict_constraints>
1. **LOCKED FINDINGS:** Do not change, reinterpret, or add factual claims to the evidence summary or diagnosis. The roadmap must answer: what actions logically follow from these findings?
2. **GROUNDING RULE:** Every roadmap action must trace to at least one confirmed gap, confirmed anti-pattern, silent/missing evidence item, or diagnosis statement in LOCKED FINDINGS.
3. **TACTICS KB SCOPE:** Use the Verified Tactics Database only for prescriptions, mechanism names, case-study references, and tactic IDs. Never use it to alter current-state findings.
4. **TACTIC ID RULE:** Every prescribed tactic action must include exactly one valid bracketed tactic ID from the database. Generic evidence-gathering actions should omit tactic IDs.
5. **PLANNING DECISION:**
   - GO only when evidence is strong and no unresolved fact-check warnings are being regenerated.
   - CONDITIONAL_GO when action is useful but some source claims, assumptions, or confidence limitations remain.
   - NO_GO when the evidence supports validation only.
6. **NO NEW CURRENT-STATE CLAIMS:** Roadmap and planning_decision may not introduce new assertions about the audited organization that are absent from LOCKED FINDINGS.
7. **JSON STRING SAFETY:** No double quotes inside JSON values. Use single quotes or asterisks.
</strict_constraints>

<task>
1. Populate planning_decision from the locked findings and confidence signals.
2. Create a 4-phase remediation_roadmap using Crawl-Walk-Run sequencing:
   - 1. Crawl — Foundation (0-3 Months)
   - 2. Walk — Optimization (3-6 Months)
   - 3. Walk — Embedding (6-12 Months)
   - 4. Run — Continuous (12+ Months)
3. If evidence is low or mixed, use validation/baseline actions first and mark assumptions/confidence when requested by the prompt appendix.
</task>

<output_format>
STRICTLY return JSON:
{
  "phase_3_strategy": {
    "planning_decision": {
      "decision": "GO | CONDITIONAL_GO | NO_GO",
      "rationale": "String explaining actionability from locked findings",
      "safe_to_act_on": ["String bullets"],
      "evidence_needed_before_action": ["String bullets"]
    },
    "remediation_roadmap": [
      { "phase": "1. Crawl — Foundation (0-3 Months)", "actions": ["Action grounded in locked findings with [TAC-XXX-000] when prescribing a tactic"] },
      { "phase": "2. Walk — Optimization (3-6 Months)", "actions": ["..."] },
      { "phase": "3. Walk — Embedding (6-12 Months)", "actions": ["..."] },
      { "phase": "4. Run — Continuous (12+ Months)", "actions": ["..."] }
    ]
  }
}
</output_format>
`;

export const ROADMAP_SYNTHESIS_PROMPT_CAUTIOUS_APPENDIX = `
<cautious_mode_overrides>
This run produced MEDIUM-confidence evidence. The roadmap may proceed only as CONDITIONAL_GO unless the locked findings clearly state high confidence and no major evidence gaps.
Each remediation_roadmap item MUST include:
- "confidence": "high" | "medium" | "low"
- "assumptions": short assumptions that must hold for that phase to apply.
Prefer baseline/validation actions before scaling controls.
</cautious_mode_overrides>
`;

// ============================================================================
// CAUTIOUS variant — MEDIUM bracket. Same shape as DIRECTIVE but every phase
// declares its confidence and the assumptions that must hold for it to apply.
// Hedged verbs allowed alongside directive ones. Tactic IDs and case studies
// remain in use (and stay verified against the Tactics DB by fact-check).
// ============================================================================
export const STRATEGY_USER_PROMPT_CAUTIOUS = `
${STRATEGY_USER_PROMPT}

<cautious_mode_overrides>
This run produced MEDIUM-confidence evidence (mixed density, some silent areas, partial delivery integrity). Apply these overrides on top of the rules above:

1. **Hedged language permitted alongside directive verbs.** Where evidence directly supports a step, use "Implement"/"Eliminate"/"Enforce". Where evidence is partial or inferred, use "Pilot", "Establish a baseline for", "Validate before scaling". Do NOT use "consider"/"might"/"could" — those remain weasel words.

2. **Per-phase confidence (REQUIRED).** Each entry in remediation_roadmap MUST include a "confidence" field with value "high", "medium", or "low":
   - "high"   = phase is supported by direct evidence in Phase 1/2 and the prerequisite signals exist in the source.
   - "medium" = phase is reasonable given audit findings but rests on assumptions about org context not directly evidenced.
   - "low"    = phase is generic FinOps best practice; the source does not yet support a confident prescription.

3. **Per-phase assumptions (REQUIRED).** Each entry MUST include an "assumptions" array — short statements (≤15 words each, max 4 per phase) listing what must hold for the phase to be applicable. Examples: "tag coverage baseline exists today", "engineering teams have dashboard tooling", "finance approves multi-year commitments". If a phase has no non-trivial assumptions, return an empty array.

4. **Persona summaries.** In the 3rd paragraph ("Source Confidence & Boundaries"), include a one-sentence confidence statement that mirrors the strongest phase confidence (e.g., "Evidence confidence is medium overall; the Crawl phase is high-confidence, later phases rest on assumptions about org readiness."). Do not place directives in the summary.

5. **Output schema additions.** The remediation_roadmap items now look like:
   { "phase": "1. Crawl — Foundation (0-3 Months)", "actions": [...], "confidence": "high|medium|low", "assumptions": ["...", "..."] }
   Keep evidence_summary, diagnosis, planning_decision, executive_summaries, and visual_scorecard in the output shape.
</cautious_mode_overrides>
`;

// ============================================================================
// FINDINGS variant — LOW bracket. NO directive roadmap, NO tactic IDs, NO
// case studies, NO claimed outcomes. The output describes what the audit CAN
// say truthfully and what evidence the user needs to gather before a real
// strategy can be prescribed. The schema diverges materially.
// ============================================================================
export const STRATEGY_USER_PROMPT_FINDINGS = `
<role>
You are an evidence-only FinOps reviewer. The audit you are reading produced LOW-confidence signal: insufficient evidence density, low delivery integrity, or too many silent criteria. A directive roadmap would be irresponsible — you would be inventing prescriptions on top of insufficient data.

Instead, produce an HONEST FINDINGS REPORT that tells the reader what the audit can support, what it cannot, and what they need to gather before a real strategy can be written.
</role>

<reference_material>
${FINOPS_METHODOLOGY_CONTEXT}
</reference_material>

<personas>
You still write three persona-tailored evidence summaries (finops_lead, cfo, engineering_lead). All three describe THE SAME findings. They differ only in vocabulary and emphasis.
${STRATEGY_PERSONAS_BLOCK}
</personas>

<strict_constraints>
1. **NO directive language.** Do NOT use "Implement", "Eliminate", "Enforce", "Automate", or any other verb that prescribes action on this organization. Use evidence verbs: "The audit shows", "The source document indicates", "No evidence was found for".
2. **NO tactic IDs.** Do NOT reference [TAC-XXX-NNN] codes. Do NOT cite external companies (Spotify, Netflix, Airbnb, etc.). The Verified Tactics Database is OFF-LIMITS in this mode.
3. **NO claimed outcomes.** Do NOT promise percentages, savings, or timelines.
4. **NO remediation_roadmap.** Return an empty array for that field.
5. **EVIDENCE REQUIREMENT.** Every finding you state MUST be traceable to a specific Phase 1 evidence quote or Phase 2 metric. If you cannot anchor it, do not state it.
6. **JSON STRING SAFETY.** No double quotes inside string values. Use asterisks for emphasis.
7. **BREVITY.** Each persona summary: 150-250 words (shorter than directive mode — there is less to say).
</strict_constraints>

<task>
1. **Executive summaries (one per persona)** with this 3-paragraph structure:
   **1. What the audit found:** Concise summary of the evidence-backed observations. Reference the Crawl/Walk/Run classification ONLY if Phase 2 metrics directly support it; otherwise say "classification is provisional pending more evidence".
   **2. What is missing:** Explicit list of what the audit could NOT confirm — silent criteria, anti-patterns that were not assessable from source coverage, contradictions in the source, areas where evidence density is too low to score.
   **3. What is needed before a directive roadmap can be written:** The validation plan — what specific source material the next assessment cycle should include.

2. **Visual scorecard** — produce as usual; this is mechanical (Phase 2 numbers).

3. **Findings mode payload (REQUIRED):**
   - "evidence_backed_findings": 4-8 short observations directly traceable to Phase 1/2.
   - "candidate_themes": 3-6 high-level remediation THEMES (NOT directives). Examples: "tagging governance", "commitment strategy", "engineering cost ownership". No tactic IDs, no companies.
   - "missing_evidence": 4-8 specific things the source did not contain that would have raised confidence (e.g., "no tagging policy document attached", "no quarterly cost review minutes", "no named FinOps team headcount").
   - "validation_plan": 3-6 concrete next-cycle actions for the user — what to gather before re-running the assessment.
</task>

<output_format>
STRICTLY return JSON. The schema in FINDINGS mode:
{
  "phase_3_strategy": {
    "executive_summaries": {
      "finops_lead": "String, Markdown, 3-paragraph structure, 150-250 words",
      "cfo": "String, Markdown, 3-paragraph structure, 150-250 words",
      "engineering_lead": "String, Markdown, 3-paragraph structure, 150-250 words"
    },
    "evidence_summary": {
      "headline": "String, fact-only findings headline",
      "maturity_classification": "Insufficient evidence | Crawl | Walk | Walk with significant friction | Run",
      "key_metrics": ["String bullets with Phase 2 numbers"],
      "confirmed_strengths": ["String bullets. FinOps-relevant strengths only; in Insufficient evidence, generic facts are source observations, not maturity strengths."],
      "confirmed_gaps": ["String bullets"],
      "confirmed_antipatterns": ["String bullets"],
      "silent_or_missing_evidence": ["String bullets"]
    },
    "diagnosis": {
      "primary_bottleneck": "String, provisional interpretation only",
      "root_causes": ["String bullets"],
      "domain_diagnosis": { "A": "...", "B": "...", "C": "...", "D": "...", "E": "..." },
      "confidence": "low",
      "confidence_rationale": "String"
    },
    "planning_decision": {
      "decision": "NO_GO",
      "rationale": "Evidence does not support a directive roadmap yet.",
      "safe_to_act_on": ["Gather missing evidence", "Validate candidate themes"],
      "evidence_needed_before_action": ["String bullets"]
    },
    "visual_scorecard": {
      "headline": "String (e.g. 'Insufficient Evidence — Provisional Findings Only')",
      "maturity_score": "String",
      "burden_score": "String"
    },
    "remediation_roadmap": [],
    "findings_mode": {
      "evidence_backed_findings": ["..."],
      "candidate_themes": ["..."],
      "missing_evidence": ["..."],
      "validation_plan": ["..."]
    }
  }
}
</output_format>
`;
