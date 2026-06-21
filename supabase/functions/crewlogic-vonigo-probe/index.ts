// DEV-ONLY harvest: scrape cancel-reason optionIDs (Job 974 category / 975 reason) from jobs that
// were ALREADY cancelled. A cancelled job's /data/Jobs/ read (objectID + isCompleteObject) carries
// the optionIDs the operator picked. READ-ONLY (no writes). Deleted after use.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const TENANT_ID = '946a4535-aa61-45b6-a6fb-9190ff546d41';
const VONIGO_BASE = 'https://junkluggers.vonigo.com/api/v1';
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const franchiseID = String(body.franchiseID || '90');
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: fr } = await supabase.from('franchises').select('id').eq('external_id', franchiseID).eq('tenant_id', TENANT_ID).single();
    if (!fr) return json({ error: 'no franchise' }, 404);
    let creds: any = null;
    const { data: cr } = await supabase.rpc('get_vonigo_credential', { franchise_id_param: fr.id });
    if (cr && cr.length) creds = cr[0];
    if (!creds) { for (const p of ['p_franchise_id', 'franchise_id', 'franchiseid', 'fid']) { const a: Record<string, string> = {}; a[p] = fr.id; const rr = await supabase.rpc('get_vonigo_credential', a); if (!rr.error && rr.data && rr.data.length) { creds = rr.data[0]; break; } } }
    if (!creds) { const { data: d } = await supabase.from('vonigo_credentials').select('vonigo_username, vonigo_md5').eq('franchise_id', fr.id).limit(1); if (d && d.length) creds = d[0]; }
    if (!creds) return json({ error: 'no creds' }, 404);
    const au = new URL(VONIGO_BASE + '/security/login/');
    au.searchParams.set('company', 'Vonigo'); au.searchParams.set('userName', creds.vonigo_username); au.searchParams.set('password', creds.vonigo_md5);
    const auth = await (await fetch(au.toString())).json();
    if (auth.errNo !== 0) return json({ error: 'auth failed' }, 502);
    const tok = auth.securityToken;
    const post = async (path: string, payload: any) => { const res = await fetch(VONIGO_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ securityToken: tok, ...payload }) }); const txt = await res.text(); try { return JSON.parse(txt); } catch { return { _nonjson: true, _len: txt.length }; } };
    const gf = (f: any[], id: number) => (f.find((x: any) => (x.fieldID ?? x.fieldId) === id) || {});

    // FOCUSED single-job test: read one job several ways to find the path that returns 974/975.
    if (body.testJob) {
      const j = String(body.testJob);
      const variants = [
        ['method1+complete', { method: '1', objectID: j, isCompleteObject: 'true' }],
        ['method1', { method: '1', objectID: j }],
        ['objectID+complete', { objectID: j, isCompleteObject: 'true' }],
        ['objectID', { objectID: j }],
      ];
      const out: any[] = [];
      for (const [label, payload] of variants as any) {
        const d = await post('/data/Jobs/', payload);
        const f = (d.Job && d.Job[0] && d.Job[0].Fields) || (d.Jobs && d.Jobs[0] && d.Jobs[0].Fields) || d.Fields || (d.Job && d.Job.Fields) || [];
        out.push({ label, errNo: d.errNo, errMsg: d.errMsg, topKeys: Object.keys(d).filter((k) => k !== 'securityToken'), fieldCount: f.length, jobKeys: d.Job ? Object.keys(d.Job) : null, jobSample: d.Job ? JSON.stringify(d.Job).slice(0, 1600) : null, f974: gf(f, 974), f975: gf(f, 975), f973: gf(f, 973) });
      }
      return json({ testJob: j, variants: out });
    }

    // 1) Sweep WorkOrders over a wide past window; bucket by status; collect cancelled jobIDs.
    const now = Math.floor(Date.now() / 1000);
    const dayWindow = Number(body.days || 180);
    const ds = now - dayWindow * 86400, de = now + 7 * 86400;
    const statusBuckets: Record<string, number> = {};
    const candidateJobIDs = new Set<string>();
    let woTotal = 0;
    let woCancelSample: any = null; // first cancelled WO's own fieldIDs — does it carry 974/975 directly?
    const categories: Record<string, string> = {};
    const reasons: Record<string, { label: string; cat: string }> = {};
    for (let page = 1; page <= 6; page++) {
      const r = await post('/data/WorkOrders/', { franchiseID, pageNo: String(page), pageSize: '400', isCompleteObject: 'true', dateMode: '3', dateStart: String(ds), dateEnd: String(de) });
      const wos = r.WorkOrders || [];
      if (!wos.length) break;
      woTotal += wos.length;
      for (const w of wos) {
        const f = w.Fields || [], rel = w.Relations || [];
        const st = String(gf(f, 181).fieldValue || '').trim() || '(blank)';
        statusBuckets[st] = (statusBuckets[st] || 0) + 1;
        if (/cancel/i.test(st)) {
          const jr = rel.find((x: any) => x.relationType === 'job'); if (jr) candidateJobIDs.add(String(jr.objectID));
          // does the WorkOrder itself echo the cancel reason fields?
          const w974 = gf(f, 974), w975 = gf(f, 975);
          if ((w974.optionID ?? 0) || (w975.optionID ?? 0)) {
            if (w974.optionID) categories[String(w974.optionID)] = String(w974.fieldValue || '');
            if (w975.optionID) reasons[String(w975.optionID)] = { label: String(w975.fieldValue || ''), cat: String(w974.fieldValue || '') };
          }
          if (!woCancelSample) woCancelSample = { woID: String(w.objectID), fieldIDs: f.map((x: any) => x.fieldID ?? x.fieldId) };
        }
      }
      if (wos.length < 400) break;
    }

    // 2) Also seed the known cancelled job + any caller-supplied IDs.
    for (const id of [String(body.knownJobID || '854161'), ...(Array.isArray(body.jobIDs) ? body.jobIDs.map(String) : [])]) candidateJobIDs.add(id);

    // 3) Read each candidate cancelled job; extract 974/975/973 (value + optionID).
    const ids = Array.from(candidateJobIDs).slice(0, Number(body.maxJobs || 140));
    const perJob: any[] = [];
    let readErrors = 0; let firstReadSample: any = null;
    for (const jobID of ids) {
      const d = await post('/data/Jobs/', { objectID: jobID, isCompleteObject: 'true' });
      const f = (d.Job && d.Job[0] && d.Job[0].Fields) || (d.Jobs && d.Jobs[0] && d.Jobs[0].Fields) || d.Fields || [];
      if (!firstReadSample) firstReadSample = { jobID, errNo: d.errNo, topKeys: Object.keys(d).filter((k) => k !== 'securityToken'), fieldCount: f.length };
      if (!f.length) { readErrors++; continue; }
      const c974 = gf(f, 974), c975 = gf(f, 975), c973 = gf(f, 973);
      const catLabel = String(c974.fieldValue || ''), catID = c974.optionID ?? 0;
      const rLabel = String(c975.fieldValue || ''), rID = c975.optionID ?? 0;
      if (catID) categories[String(catID)] = catLabel;
      if (rID) reasons[String(rID)] = { label: rLabel, cat: catLabel };
      perJob.push({ jobID, category: catLabel, categoryOptionID: catID, reason: rLabel, reasonOptionID: rID, comments: String(c973.fieldValue || '') });
    }

    return json({
      note: 'harvested cancel-reason optionIDs from already-cancelled jobs',
      window_days: dayWindow, workOrdersScanned: woTotal, statusBuckets,
      cancelledJobsFound: candidateJobIDs.size, jobsRead: ids.length, readErrors,
      woCancelSample, firstReadSample,
      categories, reasons, perJob,
    });
  } catch (e) { return json({ error: (e as Error).message }, 500); }
});
