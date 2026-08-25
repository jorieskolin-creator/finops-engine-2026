
import { STRATEGY_GUARDRAILS, FINOPS_PERSONAS } from './knowledge_base';

export const METRIC_DESCRIPTIONS: Record<string, string> = {
  finops_readiness:
    'Compatibility alias for Adjusted FinOps Maturity: Observed Maturity multiplied by the square root of assessment resolution. It drives CRAWL/WALK/RUN only when Assessment Sufficiency passes.',
  corroborated_maturity:
    'Paired maturity using only capability/anti-pattern pairs where both sides are resolved. Unknown pairs are excluded, not scored as zero.',
  observed_maturity:
    'Evidence-weighted paired maturity across fully and partially resolved pairs. A pair with only one resolved side receives half resolution credit.',
  assessment_resolution:
    'Weighted share of the configured pair surface resolved: full pairs receive 1.0 credit, one-sided pairs 0.5, unresolved pairs 0.',
  adjusted_maturity:
    'Observed Maturity multiplied by the square root of assessment resolution. This is the active maturity score when Assessment Sufficiency passes.',
  maturity_ratio:
    'Share of maturity criteria that scored as fully embedded (3 of 3 sub-criteria met).',
  maturity_depth:
    'Average maturity score across all criteria on a 0–3 scale, normalized to 0–100%. Captures partial progress that maturity_ratio misses.',
  maturity_zero_ratio:
    'Share of assessed maturity capabilities that scored 0/3. Higher means more evidence-backed capability gaps; it does not mean evidence was missing.',
  antipattern_ratio:
    'Share of anti-pattern criteria with a confirmed or partial harmful-pattern signal. Higher = more widespread observed friction.',
  antipattern_burden:
    'Average severity across all anti-patterns. Higher = more friction blocking current FinOps practice. Low values mean "low confirmed burden" only when source evidence is strong enough.',
  capability_attainment:
    'Supported capability questions across the complete 30-criterion surface, normalized to 0–100%. Higher is better; unknown criteria earn no points but are not confirmed gaps.',
  antipattern_control:
    'Control improves only from tested anti-pattern absence across the complete 30-criterion surface. Present, partial, unknown, and not-assessed criteria earn no control points; verified harmful severity is reported separately as burden.',
  antipattern_clearance:
    'Share of anti-patterns that were meaningfully tested and not found. This is positive only when the source had relevant coverage.',
  antipattern_coverage:
    'Share of anti-pattern criteria that were meaningfully assessed, either as findings or verified absences. Low coverage means absence is unknown, not good.',
  antipattern_finding_ratio:
    'Share of assessed anti-patterns with a confirmed or partial harmful-pattern signal. Higher means more anti-pattern burden; a tested 0/3 means no harmful subcriteria were evidenced.',
  delivery_integrity:
    'Did the audit pipeline complete? Share of maturity and anti-pattern criteria the LLM returned valid data for. Below 100% means batches failed.',
  evidence_density:
    'Did the source actually cover the criterion? Share of maturity and anti-pattern criteria with verified source coverage, including positive evidence, quote-backed gaps, anti-pattern findings, and verified anti-pattern absences.'
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
- Phase 2 percentages are metric/index values unless the metric name explicitly says spend. Never describe anti-pattern_burden as a share of cloud spend; call it the confirmed anti-pattern burden index.
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
10. **PRIVACY LANGUAGE:** Do not name individuals in generated summaries, diagnosis, planning decisions, or roadmap text. Avoid repeating the assessed organization/legal entity name unless it is essential to preserve meaning; prefer neutral labels such as "the assessed organization", "the finance team", "the engineering team", or "the FinOps team".
</strict_constraints>

<task>
1. **Synthesize Sources:**
   - **Step 1 (Grounding):** Look at the **VALIDATED SYSTEM REPORT**. These scores are the absolute truth.
   - **Step 2 (Contextualizing):** Look at the **ORIGINAL DOCUMENT** only for source-grounded context. Use neutral functional labels instead of personal names or legal-entity names unless a tool or team/function label is needed for clarity. Do not change the diagnosis.
   - **Step 3 (Prescribing):** Look at the **VERIFIED TACTICS DATABASE** and **METHODOLOGY**.
     - Use the Crawl-Walk-Run framework to structure the roadmap.
     - Use case studies from the DATABASE to prescribe specific mechanisms.

2. **Draft Evidence Summaries (One per Persona — Three Total):**
   For EACH persona (finops_lead, cfo, engineering_lead), write a fact-only summary using exactly this 3-paragraph structure, adapted to that persona's vocabulary and emphasis:

   **1. Current-State Snapshot:** State Corroborated Maturity, Observed Maturity, Assessment Resolution, Adjusted FinOps Maturity, Assessment Sufficiency, and the maturity classification. Keep anti-pattern burden/coverage, delivery integrity, and evidence density as diagnostics. Explain that unknown evidence is excluded from observed values and reduces resolution; it does not prove capability absence or anti-pattern presence.

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
   - **GROUNDING:** Every action must answer a confirmed gap, confirmed anti-pattern, missing-evidence need, or diagnosis statement. Do not add broad activity-to-outcome, product-cadence, growth, scale, or baseline actions unless those exact problems appear in the locked findings.
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
      "domain_diagnosis": { "A": "...", "B": "...", "C": "...", "D": "...", "E": "...", "F": "..." },
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
4. **CANONICAL DOMAIN LABELS:** Use these exact A-F labels and do not invent thematic names:
   - A = Cost Visibility & Allocation
   - B = Rate & Usage Optimization
   - C = Governance & Policy
   - D = Architecture & Engineering
   - E = Culture & Organization
   - F = GenAI & AI Cost Management
5. **NO DOMAIN REASSIGNMENT:** Do not attribute B findings to D, D findings to E, governance/culture findings to A, or GenAI/token-cost findings to A-E merely because they sound related. Domain diagnosis must follow the criterion IDs in Phase 1/2.
6. **NO IMPLEMENTATION LANGUAGE:** Do not use directive verbs such as Implement, Enforce, Automate, Launch, Establish, Deploy, or Optimize except when quoting source evidence.
7. **SOURCE-TYPE SAFETY:** If the source appears to describe best practices, case studies, or methodology rather than the audited organization's operations, say the audit can assess document coverage but cannot prove operational adoption.
8. **PRIVACY LANGUAGE:** Do not name individuals. Avoid repeating the assessed organization/legal entity name unless it is essential to preserve meaning; prefer neutral labels such as "the assessed organization", "the finance team", "the engineering team", or "the FinOps team".
9. **JSON STRING SAFETY:** No double quotes inside JSON values. Use single quotes or asterisks.
10. **ASSESSMENT-STATUS FIDELITY:** A criterion marked unsupported, verification_unresolved, or not_assessed is an evidence/verification gap. Never describe it as a confirmed weak, partial, missing, or immature control. Only an assessed, source-backed criterion may support current-state strength or deficiency language.
11. **BOUNDED RESPONSE:** Keep each persona summary at or below 180 words. Use at most five bullets per evidence_summary list, at most three root causes, at most 55 words per domain diagnosis, and at most 80 words for confidence rationale. Do not repeat the same finding across multiple bullets in one section.
</strict_constraints>

<task>
1. Draft persona evidence summaries using this 3-paragraph structure:
   **1. Current-State Snapshot:** Corroborated Maturity, Observed Maturity, Assessment Resolution, Adjusted FinOps Maturity, Assessment Sufficiency, and classification. Keep anti-pattern burden/coverage, delivery integrity, and evidence density as diagnostics. Explain that unknown evidence is excluded from observed values and reduces resolution; it does not prove capability absence or anti-pattern presence.
   **2. Evidence-Backed Findings:** confirmed FinOps strengths, confirmed gaps, confirmed anti-pattern findings, verified anti-pattern absences, anti-patterns not assessable from source, and silent areas with domain scores where present. If the source has generic process facts but no FinOps evidence, describe them as source observations outside FinOps scope.
   **3. Source Confidence & Boundaries:** what the evidence can and cannot prove. No recommendations.
2. Populate evidence_summary with concise fact-only bullets.
3. Populate diagnosis as interpretation only; no roadmap, no tactic IDs, no prescriptions. The domain_diagnosis keys A-F must use the canonical labels above and summarize only findings from the matching A-F criteria family.
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
      "domain_diagnosis": { "A": "...", "B": "...", "C": "...", "D": "...", "E": "...", "F": "..." },
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
3. **TACTIC ACTIVITY PLAYBOOK:** KB-aligned implementation activities, roles, artifacts, and acceptance criteria for approved tactic IDs.
4. **METHODOLOGY:** Crawl-Walk-Run sequencing.
5. **PHASE 2 METRICS:** numeric confidence signals and Quality Gate precursors.
</input_data>

<reference_material>
${FINOPS_METHODOLOGY_CONTEXT}
</reference_material>

<strict_constraints>
1. **LOCKED FINDINGS:** Do not change, reinterpret, or add factual claims to the evidence summary or diagnosis. The roadmap must answer: what actions logically follow from these findings?
2. **GROUNDING RULE:** Every roadmap action must trace to at least one confirmed gap, confirmed anti-pattern, silent/missing evidence item, or diagnosis statement in LOCKED FINDINGS. Prefer 2-4 actions per phase when the locked findings support them. If a phase has fewer than 2 genuinely grounded actions, return fewer actions rather than inventing filler.
3. **TACTICS KB SCOPE:** Use the Verified Tactics Database and Tactic Activity Playbook only for prescriptions, mechanism names, case-study references, activity detail, artifacts, roles, and acceptance criteria. Never use them to alter current-state findings.
4. **TACTIC ID RULE:** Follow the supplied Governed Tactic Selection Plan. Every PRIMARY tactic marked REQUIRED must be evaluated and initially represented in at least one roadmap action with its exact bracketed ID so independent review can verify applicability. If authoritative locked findings satisfy a supplied do-not-use condition, do not disguise the conflict; the Quality Checker may quarantine that tactic as contraindicated. For OPTIONAL tactics, include exactly one valid bracketed tactic ID only when the locked finding and applicability guidance support it. Generic evidence-gathering and genuinely supplemental custom actions should omit tactic IDs. Never invent an ID.
5. **PLANNING DECISION:**
   - GO only when evidence is strong and no unresolved fact-check warnings are being regenerated.
   - CONDITIONAL_GO when action is useful but some source claims, assumptions, or confidence limitations remain.
   - NO_GO when the evidence supports validation only.
6. **NO NEW CURRENT-STATE CLAIMS:** Roadmap and planning_decision may not introduce new assertions about the audited organization that are absent from LOCKED FINDINGS.
7. **NO BASELINE OVERREACH:** Do not prescribe establishing a baseline for a value that is already quantified in the locked findings. Use the existing baseline as evidence and prescribe only the next grounded control.
8. **NO CULTURE/GOVERNANCE OVERREACH:** Do not use optional culture or governance tactic IDs for generic improvement language. A REQUIRED direct mapping is allowed only for its activated criterion and must not be used to imply that another anti-pattern exists.
9. **NO VAGUE MATURITY ACTIONS:** Do not prescribe shifting from activity tracking to outcome tracking, product-level cadence embedding, growth/scale operating model work, or access-pattern baselines unless that exact gap appears in LOCKED FINDINGS or the Governed Tactic Selection Plan marks the corresponding tactic REQUIRED. A required action must remain limited to the activated finding.
10. **WHY / WHAT GROUNDING:** Each roadmap phase must include "why" and "what" paragraphs. They are roadmap claims and must be grounded exactly like actions. Do not introduce new current-state facts, unsupported financial impact, or "closes the gap" language unless the locked findings include explicit acceptance criteria proving closure.
11. **ACTIVITY PLAYBOOK BOUNDARY:** REQUIRED direct mappings are authoritative after deterministic activation by a verified finding. Use activity playbook content to make HOW actions concrete. For optional expansion, select a tactic only after its KB coverage and use-when rules match locked findings. Expected artifacts and semantic hints are candidate clues, not activation proof.
12. **RISK-CONTROL ADAPTATION:** Use the selected tactic's risks and controls as guidance. Adapt the control to the grounded action and supplied context; do not copy boilerplate mechanically and do not invent a customer condition.
13. **CUSTOM ACTIONS:** When the approved catalog does not fully address a verified finding, a supplemental action may omit a tactic ID. It must state a concrete owner, artifact, acceptance condition, and context-appropriate risk control. Never present a custom action as an approved tactic.
14. **PRIVACY LANGUAGE:** Do not name individuals. Avoid repeating the assessed organization/legal entity name; use "the assessed organization" or functional labels such as finance, engineering, platform, or FinOps team.
15. **JSON STRING SAFETY:** No double quotes inside JSON values. Use single quotes or asterisks.
16. **ASSESSMENT-STATUS FIDELITY:** Treat unsupported, verification_unresolved, and not_assessed criteria only as evidence/verification gaps. Do not call them weak, partial, missing, or immature controls, and do not prescribe remediation for an unverified deficiency. An evidence-collection action is allowed; a control-remediation action requires a separate assessed finding.
17. **EXPLICIT FINDING REFERENCES:** Every action must include one or more exact bracketed criterion references from LOCKED FINDINGS, such as [A5], [AP-B3], or [F1-F5]. These references are mandatory provenance, not tactic IDs. Do not cite a criterion that does not support the action. Evidence-collection actions must cite the corresponding assessment-gap criteria.
18. **BOUNDED RESPONSE:** Keep each why and what paragraph between 50 and 90 words. Use 2-4 grounded actions per phase when available. Each action must be concise while retaining owner, artifact, acceptance condition, and risk control; avoid repeating phase narrative inside actions.
</strict_constraints>

<task>
1. Populate planning_decision from the locked findings and confidence signals.
2. Create a 4-phase remediation_roadmap using Crawl-Walk-Run sequencing. Keep all four phase headings, but actions arrays may be empty where the evidence does not support a grounded action:
   - 1. Crawl — Foundation (0-3 Months)
   - 2. Walk — Optimization (3-6 Months)
   - 3. Walk — Embedding (6-12 Months)
   - 4. Run — Continuous (12+ Months)
3. For every phase:
   - "why": 50-90 words explaining why this phase exists, referencing only locked findings, confirmed gaps, confirmed anti-patterns, missing-evidence needs, diagnosis statements, and matching KB mechanisms.
   - "what": 50-90 words describing the intended change/outcome without inventing unproven benefits or claiming a gap is fully closed unless the locked findings prove the acceptance criteria.
   - "actions": the HOW layer — 2-4 concise, concrete bullets grounded in locked findings where possible. Every action must include exact bracketed finding references. Include all REQUIRED tactics from the Governed Tactic Selection Plan across the roadmap. Use the Tactic Activity Playbook for practical activity, owner, artifact, acceptance, and adapted risk-control language. Evaluate OPTIONAL tactics semantically; omit their IDs when applicability is not supported. If fewer than 2 grounded HOW actions exist for a phase, use fewer and do not pad with generic work.
   - "confidence": "high", "medium", or "low" according to how directly the locked findings support the phase.
   - "assumptions": up to four short assumptions that must hold for the phase to apply; return an empty array when none are needed.
   - Do not write blanket claims that every gap maps to a verified KB tactic. Use narrower wording: source-confirmed gaps drive the roadmap; tactic IDs are used only where an exact KB match is supported.
4. If evidence is low or mixed, use validation actions first and mark assumptions/confidence when requested by the prompt appendix.
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
      { "phase": "1. Crawl — Foundation (0-3 Months)", "why": "50-90 grounded words", "what": "50-90 grounded words", "actions": ["Owner performs a grounded action with artifact, acceptance, risk control, and [A3] [TAC-VIS-004] where applicable"], "confidence": "high|medium|low", "assumptions": [] },
      { "phase": "2. Walk — Optimization (3-6 Months)", "why": "50-90 grounded words", "what": "50-90 grounded words", "actions": ["2-4 grounded HOW actions with exact finding references"], "confidence": "high|medium|low", "assumptions": [] },
      { "phase": "3. Walk — Embedding (6-12 Months)", "why": "50-90 grounded words", "what": "50-90 grounded words", "actions": ["2-4 grounded HOW actions with exact finding references"], "confidence": "high|medium|low", "assumptions": [] },
      { "phase": "4. Run — Continuous (12+ Months)", "why": "50-90 grounded words", "what": "50-90 grounded words", "actions": ["2-4 grounded HOW actions with exact finding references"], "confidence": "high|medium|low", "assumptions": [] }
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
   { "phase": "1. Crawl — Foundation (0-3 Months)", "why": "50-90 grounded words", "what": "50-90 grounded words", "actions": [...], "confidence": "high|medium|low", "assumptions": ["...", "..."] }
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
      "domain_diagnosis": { "A": "...", "B": "...", "C": "...", "D": "...", "E": "...", "F": "..." },
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
