# n8n workflow exports (local-only drop folder)

Drop n8n workflow JSON exports here for the n8n→Edge Function migration analysis
(see `CL-BRD-002` and the n8n touchpoint assessment).

## ⚠️ These are gitignored on purpose

`*.json` in this folder is ignored by git (`.gitignore`) because n8n exports can contain
**plaintext secrets** — API keys, basic-auth, bearer tokens, and Vonigo OAuth client id/secret
embedded in HTTP Request nodes. They must **never** be committed.

## How to use

1. Export the workflow(s) from n8n (the ones to assess first: `crewlogic-route`,
   `crewlogic-submit-quote`, and `crewlogic-estimate` with `searchClients`/`delete`).
2. Save the `.json` file(s) in this folder.
3. Claude reads them from disk, extracts the migration-relevant findings (esp. **how each node
   authenticates to Vonigo — MD5 token vs OAuth**), and writes the conclusions into the BRD.
4. The raw exports stay local; only the (secret-free) conclusions are committed.

If you ever do want an export tracked in git, **scrub all secrets first** and add it explicitly.
