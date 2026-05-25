// Supabase Edge Function: crewlogic-photo-sweep (v1.0)
// Permanently deletes soft-deleted estimate photos whose deletedAt is >30 days old,
// and prunes the corresponding entries from estimates.payload.charges[*].deletedPhotos.
// Migrated from the n8n "CrewLogic Soft-Delete Photo Sweep" daily cron.
//
// Orchestrates two SQL helper functions (the complex JSONB walking stays in the DB):
//   sweep_find_expired_photos()                       -> rows {estimate_id, franchise_id, expired_paths}
//   sweep_prune_expired_photos(p_estimate_id, p_paths) -> prunes the JSONB entries
// ...and deletes the files from the `estimate-photos` Storage bucket in between.
//
// Invoked daily by pg_cron via pg_net (see the SQL migration). Safe to call manually
// (idempotent — only ever touches entries already expired >30 days).
//
// Deploy: supabase functions deploy crewlogic-photo-sweep

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BUCKET = "estimate-photos";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

interface ExpiredRow { estimate_id: number; franchise_id: string; expired_paths: string[]; }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // 1) Find expired soft-deleted photos (grouped per estimate).
    const { data: rows, error: findErr } = await supabase.rpc("sweep_find_expired_photos");
    if (findErr) {
      console.error("[photo-sweep] find failed:", findErr.message);
      return jsonResponse({ success: false, error: findErr.message }, 500);
    }
    const expired = (rows || []) as ExpiredRow[];
    if (expired.length === 0) {
      return jsonResponse({ success: true, estimatesPruned: 0, filesDeleted: 0, note: "nothing to sweep" });
    }

    let filesDeleted = 0;
    let estimatesPruned = 0;
    const errors: string[] = [];

    for (const row of expired) {
      const paths = Array.isArray(row.expired_paths) ? row.expired_paths.filter(Boolean) : [];
      if (paths.length === 0) continue;

      // 2) Delete the files from Storage (batch). Storage remove is idempotent —
      //    a missing object doesn't error — so this is safe to re-run.
      const { error: delErr } = await supabase.storage.from(BUCKET).remove(paths);
      if (delErr) {
        // Don't prune if the delete failed — leave the entries so we retry next run.
        console.warn(`[photo-sweep] storage delete failed for estimate ${row.estimate_id}: ${delErr.message}`);
        errors.push(`estimate ${row.estimate_id}: ${delErr.message}`);
        continue;
      }
      filesDeleted += paths.length;

      // 3) Prune the now-deleted entries from the estimate's JSONB.
      const { error: pruneErr } = await supabase.rpc("sweep_prune_expired_photos", {
        p_estimate_id: row.estimate_id,
        p_expired_paths: paths,
      });
      if (pruneErr) {
        console.warn(`[photo-sweep] prune failed for estimate ${row.estimate_id}: ${pruneErr.message}`);
        errors.push(`prune ${row.estimate_id}: ${pruneErr.message}`);
        continue;
      }
      estimatesPruned++;
    }

    return jsonResponse({ success: true, estimatesPruned, filesDeleted, estimatesFound: expired.length, errors });
  } catch (e) {
    const err = e as Error;
    console.error("[photo-sweep] error:", err?.message || err);
    return jsonResponse({ success: false, error: err.message || "Internal error" }, 500);
  }
});
