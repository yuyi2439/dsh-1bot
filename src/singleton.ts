// Process-level singleton lock for the OneBot bridge.
//
// Two dsh processes running the onebot plugin against the same profile both
// bridge the same QQ chats and append to the same persisted sessions; each
// process owns its own seq counter, so interleaved appends corrupt the logs
// (duplicate/missing seq). The lock makes a second instance refuse to start.
import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Try to take an exclusive lock file (containing this process's pid).
 * @param lockPath - the lock file path (e.g. `<workspace_root>/.onebot.lock`).
 * @returns a disposer that removes the lock, or `null` when another LIVE
 *   process holds it (a stale lock — pid gone — is taken over).
 */
export async function acquireSingletonLock(lockPath: string): Promise<(() => Promise<void>) | null> {
	await mkdir(dirname(lockPath), { recursive: true });
	try {
		const handle = await open(lockPath, "wx");
		await handle.writeFile(String(process.pid), "utf8");
		await handle.close();
		return async () => {
			try {
				await unlink(lockPath);
			} catch {
				// already gone — nothing to release
			}
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		try {
			const pid = Number((await readFile(lockPath, "utf8")).trim());
			process.kill(pid, 0);
			// EPERM above (exists, owned elsewhere) and "no throw" both mean live.
			return null;
		} catch (err2) {
			const code = (err2 as NodeJS.ErrnoException).code;
			if (code === "EPERM") return null; // alive but not ours to signal
			// ESRCH / unreadable → stale lock; take it over.
			try {
				await unlink(lockPath);
			} catch {
				// ignore
			}
			return acquireSingletonLock(lockPath);
		}
	}
}
