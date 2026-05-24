# BRD — AI Volume Estimate Feedback Loop

**Document ID:** CL-BRD-001
**Project:** CrewLogicAI Volume Estimate Self-Improvement
**Version:** 1.0
**Date Drafted:** Sunday, May 24, 2026
**Author:** Charles Dennis (owner) with Claude (architect)
**Status:** Approved for implementation, build deferred to next available session
**Target Build:** Single focused session (~5 hours), recommended within next 30 days

---

## 1. Executive Summary

CrewLogicAI's AI-driven volume estimation (truck/cubic-yard sizing per charge row from photos and voice transcripts) is the primary value driver of the application. Today, AI-produced volume numbers are presented to the estimator who accepts or overrides them with no structured feedback loop. The system has no mechanism to learn from estimator corrections, no data to support prompt refinement, and no visibility into AI accuracy patterns by area, room type, or franchise.

This project introduces a lightweight, low-friction feedback capture mechanism that records:
- The AI's original volume prediction
- The estimator's final accepted volume
- A direction-aware reason code explaining the override
- Free-text annotation (optional)
- Contextual metadata (room type, photo count, transcript presence)

Captured data is intended to support a 90-day evaluation cycle after which the AI estimation prompt will be refined based on observed adjustment patterns. The mechanism is designed to be invisible when not needed (no prompt if estimator accepts AI value) and to gracefully degrade if estimators skip the feedback prompt.

**Out of scope for this release:** automatic AI prompt adjustment, surcharge-row feedback (mattress count, TV count, etc.), aggregated reporting UI for estimators.

---

## 2. Business Objectives

| ID | Objective | Measurement |
|----|-----------|-------------|
| BO-1 | Capture structured data on estimator overrides of AI volume predictions | Number of `charge_adjustments` rows over 90 days; engagement rate (rows with non-NULL reason) |
| BO-2 | Identify systematic AI weaknesses by room type, area, and item profile | Distinct patterns visible in aggregation queries after 90-day window |
| BO-3 | Enable data-driven AI prompt improvements at 90-day mark | At least one specific prompt refinement applied based on top-3 reason codes |
| BO-4 | Avoid degrading the estimator experience | <5% increase in time-per-estimate; ≥40% engagement rate with reason picker |

---

## 3. Stakeholders

| Role | Stakeholder | Interest |
|------|-------------|----------|
| Product Owner | Charles Dennis | Final accuracy of CrewLogicAI volume estimates; multi-tenant SaaS roadmap |
| Primary Users | Franchise owners (currently Junkluggers franchisees) and their estimators | Faster, more accurate on-site estimating |
| Data Consumer | Charles (today); future franchise owners viewing their own data | 90-day analysis to inform AI improvements |
| Implementer | Claude Code (with Charles' approval gates) | Faithful execution of this spec |

---

## 4. Scope

### 4.1 In Scope

- New Supabase table `charge_adjustments` with schema, indexes, RLS policies, and triggers as defined in §8
- Modifications to `index.html` to:
  - Snapshot AI prediction metadata when the AI returns a volume estimate
  - Detect transitions between "matches AI" and "overrides AI" state per charge
  - Render an inline reason picker UI when an override transition occurs
  - Insert/update/delete `charge_adjustments` rows in response to volume changes
- Documentation:
  - Update `CLAUDE.md` with the new schema and workflow
  - Save reporting SQL queries to `reports/charge_adjustments.sql` in the repo
- Version bump and changelog entry

### 4.2 Out of Scope

- Automatic prompt refinement (manual at 90-day mark)
- UI for estimators or owners to view aggregated adjustment data (raw SQL queries are sufficient for v1)
- Feedback capture on surcharges, packing fees, or any charge type beyond truck-volume tiers
- Multi-tenant analytics dashboard
- Real-time AI re-prompting based on adjustment patterns
- Backfill of historical estimates (data capture begins on deploy date)

### 4.3 Assumptions

- Existing AI estimation flow (`crewlogic-ai` Edge Function, `action: analyzeEstimate`) returns a deterministic volume value per charge that can be snapshotted
- The frontend's existing charge object (in `currentEstimate.payload.charges[i]`) has a stable structure where new fields can be added without breaking other code paths
- Supabase PostgREST supports the `ON CONFLICT` upsert pattern used in §9
- Authenticated users (any role) can write to `charge_adjustments` per the RLS policy in §8.4 — tightening is deferred

---

## 5. Functional Requirements

### 5.1 AI Prediction Snapshot

**FR-1.** When `crewlogic-ai` returns a volume prediction for a charge, the frontend SHALL persist on that charge object the following snapshot fields:

- `_aiVolume` (number) — the AI's predicted volume in truck units
- `_aiArea` (string) — e.g., "Basement"
- `_aiRoom` (string) — e.g., "Workshop/Shed"
- `_aiDescription` (string) — the AI's item description
- `_photoCount` (integer) — count of photos the AI processed for this charge
- `_hadVoiceTranscript` (boolean) — whether a voice transcript was provided
- `_lastVolumeMatchedAI` (boolean) — initialized to `true`; tracks state transitions

These fields use the underscore prefix to mark them as in-memory tracking metadata and SHALL NOT be persisted to the `estimates` table.

### 5.2 Transition Detection

**FR-2.** When the volume value for a charge changes, the system SHALL evaluate whether the change represents:

- (a) **AI → Override transition:** previous value matched `_aiVolume`, new value does not → fire reason picker AND insert/upsert row
- (b) **Override → AI return:** previous value did not match `_aiVolume`, new value does → delete row (no picker)
- (c) **Override → Override change:** both old and new values differ from `_aiVolume` → upsert row with new `final_volume`, do NOT re-fire picker, preserve existing `adjustment_reason`
- (d) **AI → AI (no change):** new value still matches `_aiVolume` → no-op

**FR-3.** Volume equality SHALL be evaluated with exact numeric comparison after both values are normalized to the same decimal precision (recommended: 3 decimal places).

### 5.3 Reason Picker UI

**FR-4.** When fired, the reason picker SHALL render inline within the charge row (not as a modal) immediately below the volume dropdown.

**FR-5.** The reason picker SHALL present 4 reason codes plus an "Other" free-text option, scoped by adjustment direction:

**When estimator INCREASES volume (direction = 'up'):**

1. `missed_items` — "AI missed items entirely (closet contents, behind/under furniture, attic access)"
2. `underestimated_bulk` — "AI underestimated bulk (heavy/dense items, larger than they appear)"
3. `packing_inefficiency` — "Packing inefficiency not accounted for (loose stuff, mixed sizes)"
4. `disassembly_volume` — "Items need disassembly that takes truck space (frames, beds, exercise equipment)"
5. `other` — free text input

**When estimator DECREASES volume (direction = 'down'):**

1. `customer_keeping` — "AI counted items the customer is keeping (Not Included)"
2. `background_items` — "AI counted items not actually in scope (background)"
3. `will_disassemble` — "Items will be disassembled before removal (fits in less space)"
4. `nest_stack` — "AI over-counted bulk for items that nest/stack (boxes, similar-shaped goods)"
5. `other` — free text input

**FR-6.** The reason picker SHALL include a "Skip" affordance equally prominent to the reason buttons. Skipping records a row with `adjustment_reason = NULL`.

**FR-7.** The free-text input for "Other" SHALL enforce a 200-character maximum (hard cap in frontend; corresponding DB column has no length limit but is documented as ≤200 chars by convention).

**FR-8.** The reason picker SHALL dismiss automatically after a reason is selected (or Skip is clicked).

**FR-9.** Once a reason has been captured (or skipped) for a given charge in a given session, the picker SHALL NOT re-fire for that charge unless the volume returns to AI value and is then changed again.

### 5.4 Data Persistence

**FR-10.** Volume changes that trigger inserts, updates, or deletes against `charge_adjustments` SHALL execute via Supabase PostgREST using the existing `supabaseFetch` helper.

**FR-11.** Failures in writing to `charge_adjustments` SHALL NOT block the user's volume change from being saved to the estimate. The feedback capture is best-effort; estimating must continue regardless. Errors SHALL be logged to console.

**FR-12.** The system SHALL NOT issue redundant writes. If the user fiddles with the volume value rapidly (e.g., 1/4 → 1/2 → 3/8 → 1/2 in a few seconds), the system should debounce or otherwise avoid writing on every keystroke. Recommended: write only on dropdown commit (change event), not on every intermediate keystroke.

### 5.5 Reporting

**FR-13.** Four reporting SQL queries SHALL be saved to `reports/charge_adjustments.sql` in the repository:

1. Adjustments by reason and direction
2. AI accuracy by area
3. Engagement (reason vs skip rate)
4. Adjustment magnitude distribution

Full query text is provided in §11.

---

## 6. Non-Functional Requirements

### 6.1 Performance

- **NFR-1.** The reason picker SHALL render within 100ms of the triggering volume change.
- **NFR-2.** The `charge_adjustments` insert/upsert SHALL complete within 500ms under normal network conditions. Failures or timeouts SHALL be silent (logged only).
- **NFR-3.** No additional latency SHALL be introduced to the AI volume estimation flow itself. Snapshot fields are captured from the existing AI response payload.

### 6.2 Reliability

- **NFR-4.** A failed write to `charge_adjustments` SHALL NOT cause user-facing errors or disrupt the estimating workflow.
- **NFR-5.** Concurrent writes for the same `(estimate_id, charge_idx)` pair SHALL be handled by the database's unique constraint plus the upsert pattern. Last-write-wins on `final_volume` is acceptable.

### 6.3 Data Integrity

- **NFR-6.** The combination of `estimate_id` + `charge_idx` SHALL be unique in `charge_adjustments`. Enforced by DB constraint.
- **NFR-7.** `direction` SHALL always reflect the sign of `(final_volume - ai_volume)` at write time. The CHECK constraint enforces value validity ('up' | 'down').
- **NFR-8.** Existing reason and note text SHALL be preserved across upserts when the user is merely changing the `final_volume` without re-engaging the picker. Implementation guidance in §9.3.

### 6.4 Privacy / Security

- **NFR-9.** No customer PII (name, address, phone) SHALL be written to `charge_adjustments`. The `ai_description` field is item descriptions only and is acceptable.
- **NFR-10.** RLS policies on `charge_adjustments` allow authenticated INSERT/UPDATE/DELETE/SELECT. Tightening to per-franchise scoping is deferred to a future task once the data model is proven.

### 6.5 Observability

- **NFR-11.** All write operations to `charge_adjustments` SHALL log successes and failures via `console.log` / `console.error` with prefix `[adj]` for grep-ability.

---

## 7. Success Criteria

| ID | Criterion | Measurement Method | Target |
|----|-----------|---------------------|--------|
| SC-1 | Mechanism captures rows when estimators override AI | Query: `SELECT COUNT(*) FROM charge_adjustments WHERE created_at > deploy_date` | >0 within first 7 days |
| SC-2 | Engagement with reason picker is meaningful | Query: % of rows with non-NULL `adjustment_reason` | ≥40% at 30-day mark |
| SC-3 | No regression to estimating speed or reliability | Subjective: monitor in-app feedback, error rates | No feedback reports tied to volume picker; no console error spike |
| SC-4 | At 90 days, sufficient data exists to inform prompt refinement | Query: SUM of rows per reason × area combination | At least 3 reason × area combinations with ≥10 rows each |
| SC-5 | At least one AI prompt refinement is shipped by Day 120 | New version of `crewlogic-ai` with documented refinement | Yes/No (gate for completing the loop) |

---

## 8. Database Schema

### 8.1 SQL Migration

File path: `migrations/009_charge_adjustments.sql` (assuming a `migrations/` folder exists by build time; if not, file path is `supabase/migrations/009_charge_adjustments.sql` or wherever the project's convention places SQL migrations).

```sql
-- ============================================================================
-- charge_adjustments — AI volume estimate feedback loop
-- ============================================================================
-- Captures estimator overrides of AI-predicted volumes per charge row.
-- One row per (estimate_id, charge_idx) representing the current state of
-- disagreement between AI and estimator. Returning the volume to AI's value
-- DELETES the row.
--
-- Reason codes are direction-aware (different codes when increasing vs
-- decreasing volume). See BRD §5.3 for the canonical reason list.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.charge_adjustments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_id         uuid REFERENCES public.franchises(id) ON DELETE CASCADE,

  -- Charge identity
  estimate_id          text NOT NULL,        -- business estimate ID (e.g. "1779383540297")
  charge_idx           int NOT NULL,         -- index within estimates.payload.charges array

  -- AI's snapshot at time of first override
  ai_volume            numeric NOT NULL,
  ai_area              text,
  ai_room              text,
  ai_description       text,

  -- Current state of the override
  final_volume         numeric NOT NULL,
  direction            text NOT NULL CHECK (direction IN ('up', 'down')),

  -- Feedback (nullable — estimator may skip)
  adjustment_reason    text,                 -- one of the codes in BRD §5.3
  adjustment_note      text,                 -- free text, ≤200 chars enforced in frontend

  -- Context for analysis
  photo_count          int,
  had_voice_transcript boolean,

  -- Metadata
  user_email           text,
  user_role            text,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now(),

  UNIQUE (estimate_id, charge_idx)
);

-- Indexes
CREATE INDEX IF NOT EXISTS adj_franchise_created
  ON public.charge_adjustments (franchise_id, created_at DESC);

CREATE INDEX IF NOT EXISTS adj_reason
  ON public.charge_adjustments (adjustment_reason);

CREATE INDEX IF NOT EXISTS adj_direction
  ON public.charge_adjustments (direction);

CREATE INDEX IF NOT EXISTS adj_ai_area
  ON public.charge_adjustments (ai_area);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_charge_adjustment_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS charge_adjustments_updated_at_trigger
  ON public.charge_adjustments;

CREATE TRIGGER charge_adjustments_updated_at_trigger
  BEFORE UPDATE ON public.charge_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_charge_adjustment_updated_at();

-- Row-level security
ALTER TABLE public.charge_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS adj_insert_auth ON public.charge_adjustments;
CREATE POLICY adj_insert_auth ON public.charge_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS adj_update_auth ON public.charge_adjustments;
CREATE POLICY adj_update_auth ON public.charge_adjustments
  FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS adj_delete_auth ON public.charge_adjustments;
CREATE POLICY adj_delete_auth ON public.charge_adjustments
  FOR DELETE TO authenticated
  USING (true);

DROP POLICY IF EXISTS adj_select_auth ON public.charge_adjustments;
CREATE POLICY adj_select_auth ON public.charge_adjustments
  FOR SELECT TO authenticated
  USING (true);

-- Verification
SELECT 'charge_adjustments' AS object,
       (SELECT COUNT(*) FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'charge_adjustments') AS exists;

SELECT 'index' AS object, indexname
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'charge_adjustments'
 ORDER BY indexname;
```

### 8.2 Schema Field Reference

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK; auto-generated |
| `franchise_id` | uuid | FK to `franchises.id`; CASCADE on franchise delete |
| `estimate_id` | text | Business estimate ID; matches `estimates.estimate_id` |
| `charge_idx` | int | 0-based index in `currentEstimate.payload.charges` |
| `ai_volume` | numeric | Volume AI suggested at first override |
| `ai_area` | text | e.g. "Basement", "Garage" |
| `ai_room` | text | e.g. "Workshop/Shed" |
| `ai_description` | text | AI's item description |
| `final_volume` | numeric | Current accepted volume |
| `direction` | text | 'up' or 'down'; enforced via CHECK constraint |
| `adjustment_reason` | text | One of the 8 codes in §5.3, or 'other', or NULL |
| `adjustment_note` | text | Free-text annotation; ≤200 chars by frontend convention |
| `photo_count` | int | How many photos the AI processed for this charge |
| `had_voice_transcript` | boolean | Whether voice was used |
| `user_email` | text | Email of the estimator who made the adjustment |
| `user_role` | text | Role at time of adjustment ('owner' or 'crew') |
| `created_at` | timestamptz | Insert time |
| `updated_at` | timestamptz | Maintained by trigger |

### 8.3 Constraints

- `UNIQUE (estimate_id, charge_idx)` — one row per charge maximum
- `CHECK direction IN ('up', 'down')` — direction validity
- FK on `franchise_id` with CASCADE — if franchise deleted, adjustment rows go with it

### 8.4 Row-Level Security

Initial policies are permissive (`USING (true)`) for all authenticated users on all operations. The application layer SHALL scope queries by `franchise_id` when reading data. Per-franchise RLS enforcement is deferred to a separate task.

---

## 9. Frontend Implementation

### 9.1 File and Function Locations

All changes are in `index.html`. Approximate line ranges to look for:

- **Charge object creation** when AI returns a result: search for the AI response handler in `crewlogic-ai` action calls (likely around `generateJobSummary` or similar — find the handler that mutates `charge.volume` or `charge.area` post-AI).
- **Volume dropdown change handler:** search for the `onchange` or event listener on `[data-charge-volume]` or similar. The dropdown is part of `renderCharges()`.
- **Estimate save flow** is unrelated — do NOT touch `saveEstimateDraft` or the `estimates` upsert path.

### 9.2 Snapshot Capture (FR-1)

In the AI response handler, after the AI returns the predicted volume and the charge object is updated:

```javascript
// AI volume estimate feedback snapshot (BRD §5.1)
// Captures the AI's prediction at the moment it is presented to the estimator.
// Used to detect overrides and as snapshot data on the charge_adjustments row.
function snapshotAIPrediction(charge, aiResult) {
  charge._aiVolume = roundVolume(aiResult.volume);   // see §9.4 for precision helper
  charge._aiArea = aiResult.area || charge.area || null;
  charge._aiRoom = aiResult.room || charge.room || null;
  charge._aiDescription = aiResult.itemList || aiResult.description || null;
  charge._photoCount = (charge.photos || []).length;
  charge._hadVoiceTranscript = !!(aiResult.transcript || aiResult.hadTranscript);
  charge._lastVolumeMatchedAI = true; // initial state
  charge._reasonPickerCharge = null;   // see §9.5
}
```

Call this function at the point the AI response is applied to the charge. Do not snapshot for manually-created charges (no AI involvement).

### 9.3 Volume Change Handler (FR-2)

Replace the existing volume dropdown change handler logic with:

```javascript
// Volume change with feedback-loop integration (BRD §5.2)
async function onChargeVolumeChange(charge, newVolume) {
  const normalized = roundVolume(newVolume);
  const aiVolume = charge._aiVolume;

  // If no AI snapshot exists (manual charge or pre-snapshot data),
  // just update the value and exit. No feedback to capture.
  if (typeof aiVolume !== 'number') {
    charge.volume = normalized;
    return;
  }

  const matchesAI = (normalized === aiVolume);
  const wasMatching = charge._lastVolumeMatchedAI === true;

  charge.volume = normalized;

  if (matchesAI && !wasMatching) {
    // Override → AI return. Delete the row.
    charge._lastVolumeMatchedAI = true;
    hideReasonPicker(charge);
    await deleteAdjustment(charge).catch(e => console.error('[adj] delete failed', e));
  } else if (!matchesAI && wasMatching) {
    // AI → Override transition. Upsert row with NULL reason, show picker.
    charge._lastVolumeMatchedAI = false;
    await upsertAdjustment(charge, null, null).catch(e => console.error('[adj] upsert failed', e));
    showReasonPicker(charge);
  } else if (!matchesAI && !wasMatching) {
    // Override → Override change. Upsert preserving existing reason.
    await upsertAdjustment(charge, undefined, undefined)
      .catch(e => console.error('[adj] upsert failed', e));
    // Do not re-fire picker.
  }
  // else: matchesAI && wasMatching — no-op
}
```

**Important nuance in §9.3:** The `upsertAdjustment(charge, undefined, undefined)` case (override → override change) must NOT overwrite an existing reason. Implementation approaches in §9.6.

### 9.4 Precision Helper

```javascript
// Normalize volume values for exact comparison.
// CrewLogicAI uses 1/8 fraction increments: 0.125, 0.25, 0.375, 0.5, etc.
// Three decimal places is more than enough.
function roundVolume(v) {
  if (typeof v !== 'number' || isNaN(v)) return null;
  return Math.round(v * 1000) / 1000;
}
```

### 9.5 Reason Picker UI

The picker renders inline below the volume dropdown for the affected charge. Recommended DOM structure:

```html
<div class="adj-reason-picker" data-charge-idx="${idx}" data-direction="${direction}">
  <div class="adj-reason-prompt">
    Why did you change this from ${aiVolumeLabel} to ${finalVolumeLabel}?
  </div>
  <div class="adj-reason-options">
    <!-- 4 reason buttons based on direction (see §5.3) -->
    <button class="adj-reason-btn" data-code="missed_items">AI missed items</button>
    <button class="adj-reason-btn" data-code="underestimated_bulk">Bulk underestimated</button>
    <!-- ... etc ... -->
    <button class="adj-reason-btn" data-code="other">Other</button>
  </div>
  <div class="adj-reason-other-input" style="display:none;">
    <input type="text" maxlength="200" placeholder="Why? (optional, max 200 chars)" />
  </div>
  <button class="adj-reason-skip">Skip</button>
</div>
```

**Styling notes:**

- Use existing CSS variables (`--bg-card`, `--text-muted`, `--accent-green`, `--radius-sm`, `--border`) for consistency
- Pad with `12px` to match other inline UI elements
- Each reason button is a full-width row, easy to tap on mobile
- The Skip affordance is visually equally prominent — no negative connotation
- The "Other" button reveals the text input on click

**Direction-aware rendering:**

```javascript
const REASON_CODES = {
  up: [
    { code: 'missed_items',        label: 'AI missed items entirely (closet, behind, attic)' },
    { code: 'underestimated_bulk', label: 'AI underestimated bulk (heavier/larger than they appear)' },
    { code: 'packing_inefficiency',label: 'Packing inefficiency (loose stuff, mixed sizes)' },
    { code: 'disassembly_volume',  label: 'Items need disassembly (frames, beds, equipment)' },
    { code: 'other',               label: 'Other...' },
  ],
  down: [
    { code: 'customer_keeping', label: 'Items customer is keeping (Not Included)' },
    { code: 'background_items', label: 'AI counted background items not in scope' },
    { code: 'will_disassemble', label: 'Will be disassembled before removal (fits less)' },
    { code: 'nest_stack',       label: 'Items nest/stack (boxes, similar shapes)' },
    { code: 'other',            label: 'Other...' },
  ],
};
```

**Show/hide functions:**

```javascript
function showReasonPicker(charge) {
  charge._reasonPickerCharge = true;
  renderCharges();  // existing render will pick up the picker state
}

function hideReasonPicker(charge) {
  charge._reasonPickerCharge = false;
  renderCharges();
}

async function onReasonPicked(charge, code, note) {
  await upsertAdjustment(charge, code, note || null)
    .catch(e => console.error('[adj] reason write failed', e));
  hideReasonPicker(charge);
}

async function onReasonSkipped(charge) {
  // Row already inserted with NULL reason at transition; skip is a no-op write.
  hideReasonPicker(charge);
}
```

### 9.6 Upsert Helper (FR-10, NFR-8)

```javascript
// Upsert a charge_adjustments row.
// `reason` semantics:
//   null      → write NULL reason (e.g. initial insert or after Skip)
//   string    → write this reason
//   undefined → preserve existing reason (for override→override changes)
async function upsertAdjustment(charge, reason, note) {
  const directionVal = charge.volume > charge._aiVolume ? 'up' : 'down';

  const baseRow = {
    franchise_id: currentUser.franchiseInternalID,
    estimate_id: currentEstimate.estimateID,
    charge_idx: getChargeIdx(charge),
    ai_volume: charge._aiVolume,
    ai_area: charge._aiArea,
    ai_room: charge._aiRoom,
    ai_description: charge._aiDescription,
    final_volume: charge.volume,
    direction: directionVal,
    photo_count: charge._photoCount,
    had_voice_transcript: charge._hadVoiceTranscript,
    user_email: currentUser.email,
    user_role: currentUser.role,
  };

  if (reason !== undefined) {
    baseRow.adjustment_reason = reason;
    baseRow.adjustment_note = note;
  }

  // PostgREST upsert: on_conflict=estimate_id,charge_idx
  // Prefer: resolution=merge-duplicates
  // If reason is undefined we omit those keys from the body so the upsert
  // does NOT overwrite existing reason/note. PostgREST merges only present fields.
  const res = await supabaseFetch(
    '/rest/v1/charge_adjustments?on_conflict=estimate_id,charge_idx',
    {
      method: 'POST',
      headers: {
        'Prefer': 'resolution=merge-duplicates,return=minimal',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(baseRow),
    }
  );

  console.log('[adj] upsert', { estimate_id: baseRow.estimate_id, charge_idx: baseRow.charge_idx, reason });
  return res;
}

async function deleteAdjustment(charge) {
  const estId = encodeURIComponent(currentEstimate.estimateID);
  const idx = getChargeIdx(charge);
  await supabaseFetch(
    `/rest/v1/charge_adjustments?estimate_id=eq.${estId}&charge_idx=eq.${idx}`,
    { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
  );
  console.log('[adj] delete', { estimate_id: currentEstimate.estimateID, charge_idx: idx });
}

function getChargeIdx(charge) {
  // Charges array doesn't carry a stable .idx field.
  // Find by reference identity.
  const arr = currentEstimate.payload.charges;
  return arr.indexOf(charge);
}
```

**Note on PostgREST upsert behavior:** Whether `resolution=merge-duplicates` truly merges only the keys provided (vs. replacing the entire row) depends on the PostgREST version and how the row is constructed. **Test this assumption during implementation.** If it does NOT merge field-by-field, use this alternative: read the existing row first, merge keys in JavaScript, then write the full row back.

Alternative if PostgREST upsert is not field-merging:

```javascript
// Read-merge-write pattern (fallback if upsert overwrites everything)
async function upsertAdjustmentByReadMerge(charge, reason, note) {
  const estId = encodeURIComponent(currentEstimate.estimateID);
  const idx = getChargeIdx(charge);

  // Try to read existing
  const existing = await supabaseFetch(
    `/rest/v1/charge_adjustments?estimate_id=eq.${estId}&charge_idx=eq.${idx}&select=*`,
    { method: 'GET' }
  );

  const existingRow = (existing && existing.length) ? existing[0] : null;

  // Merge
  const row = {
    franchise_id: currentUser.franchiseInternalID,
    estimate_id: currentEstimate.estimateID,
    charge_idx: idx,
    ai_volume: charge._aiVolume,
    ai_area: charge._aiArea,
    ai_room: charge._aiRoom,
    ai_description: charge._aiDescription,
    final_volume: charge.volume,
    direction: charge.volume > charge._aiVolume ? 'up' : 'down',
    photo_count: charge._photoCount,
    had_voice_transcript: charge._hadVoiceTranscript,
    user_email: currentUser.email,
    user_role: currentUser.role,
    adjustment_reason: reason === undefined ? (existingRow?.adjustment_reason ?? null) : reason,
    adjustment_note:   reason === undefined ? (existingRow?.adjustment_note ?? null) : (note ?? null),
  };

  if (existingRow) {
    return supabaseFetch(
      `/rest/v1/charge_adjustments?estimate_id=eq.${estId}&charge_idx=eq.${idx}`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(row),
      }
    );
  } else {
    return supabaseFetch(
      `/rest/v1/charge_adjustments`,
      {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(row),
      }
    );
  }
}
```

The implementer should pick the approach that empirically preserves existing `adjustment_reason` correctly. The read-merge-write fallback is safer but adds latency.

### 9.7 Wiring Points

To complete the integration:

1. **Locate the AI response handler** that applies the AI result to a charge. Call `snapshotAIPrediction(charge, aiResult)` immediately after the charge.volume/area/room are set.
2. **Locate the volume dropdown event handler.** Replace the body with `onChargeVolumeChange(charge, newVolume)`.
3. **Locate `renderCharges()`.** Add conditional rendering of the reason picker when `charge._reasonPickerCharge === true`. Use the DOM template in §9.5.
4. **Add the reason picker event listeners** (click on `.adj-reason-btn`, click on `.adj-reason-skip`, input on `.adj-reason-other-input` followed by Enter or blur).
5. **Confirm `getChargeIdx(charge)` returns the correct index** — if `currentEstimate.payload.charges` undergoes reordering, this may need a stable per-charge ID instead.

---

## 10. Documentation Changes

### 10.1 CLAUDE.md

Add new section under **Backend (Supabase) → Tables**:

```markdown
### charge_adjustments

Captures estimator overrides of AI-predicted volumes. Each row represents one
current disagreement between the AI and the estimator for a specific charge
(uniquely identified by `estimate_id` + `charge_idx`). Direction-aware reason
codes record WHY the override happened. Returning the volume to AI's value
DELETES the row.

Used for AI prompt improvement on a 90-day evaluation cycle (see BRD CL-BRD-001).

Key fields: `ai_volume`, `final_volume`, `direction`, `adjustment_reason`,
`adjustment_note`, plus context (`ai_area`, `ai_room`, `photo_count`, etc).

Writes happen via `supabaseFetch` against `/rest/v1/charge_adjustments` using
ON CONFLICT upsert on `(estimate_id, charge_idx)`. Failures are silent
(logged only).
```

### 10.2 reports/charge_adjustments.sql

Create a new file in the repo at `reports/charge_adjustments.sql` containing the four queries from §11.

---

## 11. Reporting Queries

Save as `reports/charge_adjustments.sql`. Run via Supabase SQL Editor or psql.

```sql
-- ============================================================================
-- charge_adjustments reporting queries
-- BRD CL-BRD-001 — AI Volume Estimate Feedback Loop
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Query 1: Adjustments by reason and direction, last 90 days
-- ----------------------------------------------------------------------------
-- Tells you the top reasons estimators are overriding the AI.
-- Use to identify which prompt refinements have the highest leverage.
SELECT
  direction,
  COALESCE(adjustment_reason, '(skipped)') AS reason,
  COUNT(*) AS count,
  ROUND(AVG(ABS(final_volume - ai_volume))::numeric, 3) AS avg_delta_trucks,
  ROUND(SUM(ABS(final_volume - ai_volume))::numeric, 2) AS total_delta_trucks
FROM public.charge_adjustments
WHERE created_at > now() - interval '90 days'
  AND franchise_id = (SELECT id FROM public.franchises WHERE external_id = '90')
GROUP BY direction, adjustment_reason
ORDER BY direction, count DESC;

-- ----------------------------------------------------------------------------
-- Query 2: AI accuracy by area
-- ----------------------------------------------------------------------------
-- Where does the AI struggle most? Signed delta tells direction; abs tells magnitude.
SELECT
  ai_area,
  COUNT(*) AS adjustments,
  ROUND(AVG(final_volume - ai_volume)::numeric, 3) AS avg_signed_delta,
  ROUND(AVG(ABS(final_volume - ai_volume))::numeric, 3) AS avg_abs_delta
FROM public.charge_adjustments
WHERE created_at > now() - interval '90 days'
  AND franchise_id = (SELECT id FROM public.franchises WHERE external_id = '90')
  AND ai_area IS NOT NULL
GROUP BY ai_area
ORDER BY adjustments DESC;

-- ----------------------------------------------------------------------------
-- Query 3: Engagement rate (reasons vs skips)
-- ----------------------------------------------------------------------------
-- Are estimators actually engaging with the reason picker?
-- Target per BRD §7: ≥40% by day 30.
SELECT
  COUNT(*) AS total_adjustments,
  COUNT(*) FILTER (WHERE adjustment_reason IS NOT NULL) AS with_reason,
  COUNT(*) FILTER (WHERE adjustment_reason IS NULL) AS skipped,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE adjustment_reason IS NOT NULL) /
    NULLIF(COUNT(*), 0),
    1
  ) AS engagement_pct
FROM public.charge_adjustments
WHERE created_at > now() - interval '90 days'
  AND franchise_id = (SELECT id FROM public.franchises WHERE external_id = '90');

-- ----------------------------------------------------------------------------
-- Query 4: Adjustment magnitude distribution
-- ----------------------------------------------------------------------------
-- How big are the typical adjustments? Helps understand whether the AI is
-- usually slightly off or wildly off.
SELECT
  direction,
  CASE
    WHEN ABS(final_volume - ai_volume) <= 0.125 THEN '01: 0–1/8'
    WHEN ABS(final_volume - ai_volume) <= 0.25  THEN '02: 1/8–1/4'
    WHEN ABS(final_volume - ai_volume) <= 0.5   THEN '03: 1/4–1/2'
    WHEN ABS(final_volume - ai_volume) <= 1.0   THEN '04: 1/2–1'
    ELSE                                              '05: >1'
  END AS magnitude_bucket,
  COUNT(*) AS count
FROM public.charge_adjustments
WHERE created_at > now() - interval '90 days'
  AND franchise_id = (SELECT id FROM public.franchises WHERE external_id = '90')
GROUP BY direction, magnitude_bucket
ORDER BY direction, magnitude_bucket;
```

---

## 12. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PostgREST upsert overwrites instead of merging adjustment_reason | Medium | Medium | Test during implementation; fall back to read-merge-write pattern (§9.6) |
| Volume comparison fails due to floating-point precision | Low | Medium | Normalize via `roundVolume()` to 3 decimal places before all comparisons |
| `getChargeIdx` fails if charges are reordered | Low | Medium | Confirm charges array is stable; if not, add a stable per-charge ID before this work |
| Failed writes to `charge_adjustments` disrupt estimating | Low | High | Wrap all writes in try/catch; failures are silent (§FR-11, NFR-4) |
| Reason picker causes UI lag on slow devices | Low | Low | UI renders client-side only; no network call until user picks; should be <100ms |
| Estimator engagement is very low (<10% pick reasons) | Medium | Medium | Acceptable for v1 — even skipped rows have value. Revisit after 30 days. |
| Insufficient data after 90 days to inform improvements | Low | Medium | Estimating volume is steady (~hundreds of charges/month per franchise); should produce ≥100 rows easily |

---

## 13. Build Sequence

Recommended execution order for the implementer:

1. **Apply SQL migration** (`migrations/009_charge_adjustments.sql`). Verify table, indexes, RLS, trigger via `\d charge_adjustments` or Supabase Table Editor.
2. **Add snapshot capture** (`snapshotAIPrediction`) and call it from the AI response handler. Verify by inspecting a charge object in DevTools after AI returns — `_aiVolume`, `_aiArea`, etc. should be present.
3. **Add `onChargeVolumeChange` logic** and wire it to the volume dropdown. Verify state transitions log correctly to console.
4. **Add `upsertAdjustment` and `deleteAdjustment` helpers.** Verify writes via Supabase Table Editor after manually changing volume on a test estimate.
5. **Add reason picker UI** (DOM template, CSS, render logic in `renderCharges`).
6. **Wire picker event handlers** (button clicks, Skip, free-text input).
7. **Test the full flow:** new estimate → AI returns volume → change volume up → picker fires → pick reason → row written. Then change back to AI value → row deleted.
8. **Test override-to-override change:** change volume 1/4 → 1/2 (pick reason A) → change to 3/8 → verify reason A is preserved, `final_volume` updated.
9. **Update CLAUDE.md** per §10.1.
10. **Create `reports/charge_adjustments.sql`** per §11.
11. **Bump version** to next minor (e.g., v5.10.0 — feature change warrants minor bump rather than patch).
12. **Commit and push** with message: `Add AI volume estimate feedback loop (BRD CL-BRD-001)`.

Estimated total: **5 hours** of focused work for a developer familiar with the CrewLogicAI codebase, including testing.

---

## 14. Post-Deploy Activities

After deployment:

- **Day 1–7:** Monitor for any user-facing errors or write failures. Verify rows are being created.
- **Day 30:** Run Query 3 (engagement). Adjust UI if engagement is unexpectedly low (e.g., increase picker prominence).
- **Day 90:** Run all four queries. Identify top 3 reason codes by frequency × magnitude. Map each to a specific prompt refinement.
- **Day 90–120:** Refine the `crewlogic-ai` prompt based on findings. Ship new version. Continue capturing data; compare next 90-day cycle to first.

---

## 15. Future Enhancements (Out of Current Scope)

- **Owner reporting UI:** dashboard surfaced in Settings → showing the four reporting queries
- **Cross-franchise benchmarking** (multi-tenant): how does franchise A's AI accuracy compare to franchise B's?
- **Surcharge feedback loop:** parallel mechanism for mattress count, TV count, packing fees
- **Real-time AI adjustment:** feed recent adjustment patterns into next AI prompt automatically
- **Per-estimator accuracy tracking:** which estimators agree with AI most often?
- **Override predictions:** train a small model on adjustment patterns to suggest pre-corrected volumes

---

## 16. Document Control

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 1.0 | May 24, 2026 | Charles Dennis + Claude | Initial draft and approval |

---

*End of BRD CL-BRD-001*
