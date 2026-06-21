// DEV-ONLY: find cancel-reason picklist (Job fields 974 category / 975 reason options). READ-ONLY. Deleted after use.
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
    const post = async (path: string, payload: any) => { try { const res = await fetch(VONIGO_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ securityToken: tok, ...payload }) }); const txt = await res.text(); try { return JSON.parse(txt); } catch { return { _nonjson: true, _len: txt.length }; } } catch (e) { return { _err: (e as Error).message }; } };

    // STEP 1: list all objects (names + IDs) so we find the Jobs object
    const objList = await post('/system/objects/', {});
    const objs: any[] = objList.Objects || objList.objects || [];
    const objIndex = objs.map((o: any) => ({ name: o.name || o.objectName, objectID: o.objectID ?? o.objectTypeID, fieldCount: (o.Fields || o.fields || []).length }));

    // STEP 2: pull the Jobs object COMPLETE (fields + options). Try by name match.
    const jobsObj = objs.find((o: any) => /^jobs?$/i.test(o.name || o.objectName || ''));
    const jobsObjectID = jobsObj ? (jobsObj.objectID ?? jobsObj.objectTypeID) : null;

    const fetchComplete = async (oid: any) => {
      const d = await post('/system/objects/', { objectID: String(oid), isCompleteObject: 'true' });
      const o = (d.Objects || d.objects || [])[0] || d.Object || null;
      const flds = (o?.Fields || o?.fields || []);
      // find cancel category/reason fields by id OR by name
      const pick = flds.filter((f: any) => {
        const id = f.fieldID ?? f.fieldId;
        const nm = (f.name || f.fieldName || '').toLowerCase();
        return [974, 975, 973].includes(id) || /cancel|reason|category/.test(nm);
      });
      return { errNo: d.errNo, fieldTotal: flds.length, pick: pick.map((f: any) => ({ fieldID: f.fieldID ?? f.fieldId, name: f.name || f.fieldName, options: (f.Options || f.options || []).map((op: any) => ({ id: op.optionID ?? op.id, label: op.name || op.label || op.value })) })) };
    };

    // STEP 3: dump RAW shape of complete Job object so we see where fields/options actually live
    const rawComplete = await post('/system/objects/', { objectID: '10', isCompleteObject: 'true' });
    const rawObj = (rawComplete.Objects || rawComplete.objects || [])[0] || null;
    const rawShape = { topKeys: Object.keys(rawComplete), objKeys: rawObj ? Object.keys(rawObj) : null, objSample: JSON.stringify(rawObj).slice(0, 1200) };

    // STEP 4: read a LIVE (non-cancelled) job — its Fields[] often carries each field's full Options list.
    const jobID = String(body.jobID || '855649'); // bogus test job (not cancelled → no -2012)
    const read = await post('/data/Jobs/', { method: '1', objectID: jobID });
    const flds = (read.Fields || read.fields || []);
    const target = flds.filter((f: any) => [974, 975, 973].includes(f.fieldID ?? f.fieldId));
    const dump = target.map((f: any) => ({
      fieldID: f.fieldID ?? f.fieldId,
      name: f.name || f.fieldName,
      value: f.value ?? f.optionID,
      options: (f.Options || f.options || []).map((op: any) => ({ id: op.optionID ?? op.id, label: op.name || op.label || op.value })),
    }));
    return json({ note: 'read live job → fields 974/975/973 + option lists', jobID, errNo: read.errNo, errMsg: read.errMsg, fieldTotal: flds.length, dump, allFieldIDs: flds.map((f: any) => f.fieldID ?? f.fieldId) });
  } catch (e) { return json({ error: (e as Error).message }, 500); }
});
