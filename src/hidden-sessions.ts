// The onebot sessions root and its explanatory README.
//
// Onebot sessions persist under `$DSH_HOME/sessions-hidden` — NOT the
// `$DSH_HOME/sessions` root the web profile scans. The web UI resumes any
// session it can see when you open it (agents.resume in dsh-host-apiproxy),
// turning it into a second live writer on the same log and corrupting it
// (duplicate/missing seq). A separate root keeps onebot sessions invisible to
// the web profile so it can never accidentally resume them. The backend,
// format, and defaults are identical to `sessions/` — only the root differs.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** `$DSH_HOME/sessions-hidden` (DSH_HOME falls back to `~/.dsh`). */
export function hiddenSessionsRoot(): string {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "sessions-hidden");
}

/** English explanation left at the root of the hidden sessions directory. */
export const SESSIONS_HIDDEN_README = `# sessions-hidden

This directory holds the durable session logs of the **dsh-onebot** profile
(OneBot / QQ as a dsh UI surface). It is intentionally NOT \`$DSH_HOME/sessions\`,
the root the web UI scans.

## Why the separation

The web UI resumes any session it can see the moment you open it
(\`agents.resume\` in \`dsh-host-apiproxy\`): the session becomes a live agent in
the web process, which then appends to the same log with its own seq counter.
Two processes writing one session log concurrently corrupts it (duplicate or
missing seq — the UI then reports "corrupt session log"). Keeping these
sessions under their own root makes them invisible to the web profile, so the
web UI can never accidentally resume them. This is a workaround for the web
UI resuming foreign sessions, not a storage-layout preference.

## Same backend, different root

The logs here use exactly the same JSONL persistence backend and defaults as
\`$DSH_HOME/sessions\` (zstd frames, packed chunk rows, project/session
directory layout) — only the root differs:

\`\`\`
<root>/--<normalized-cwd>--/<session-id>/session.jsonl.zstd
\`\`\`

Session ids look like \`onebot-private-<QQ>\` / \`onebot-group-<group>\`.

## Monitoring

There is no web view for these sessions by design. Watch the onebot process
console instead (\`[onebot info] message from …\` / \`send to …\`), or decode a
log file directly (each line is a JSON record; chunk runs are packed).
`;

/**
 * Create the hidden sessions root (if absent) and seed its README. The README
 * is written only when missing — an existing file is left untouched.
 */
export async function ensureHiddenSessionsDocs(root: string): Promise<void> {
	await mkdir(root, { recursive: true });
	try {
		await writeFile(join(root, "README.md"), SESSIONS_HIDDEN_README, { flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
}
