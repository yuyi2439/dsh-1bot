// 进程级单例锁：两个 dsh 进程桥接同样的聊天会各自独立计数 seq，写坏同一批
// 持久化会话。第二个实例拒绝启动。
import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 尝试获取独占锁文件（内容为本进程 pid）。
 * @param lockPath - 锁文件路径。
 * @returns 删除锁的 disposer；另一个存活进程持锁时返回 `null`（pid 已消失的
 *   过期锁会被接管）。
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
				// 已经不在了
			}
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		try {
			const pid = Number((await readFile(lockPath, "utf8")).trim());
			process.kill(pid, 0);
			// 没抛错 = 进程存活。
			return null;
		} catch (err2) {
			// EPERM = 存活，但信号不归我们发。
			if ((err2 as NodeJS.ErrnoException).code === "EPERM") return null;
			// ESRCH / 读不出来 → 过期锁，接管它。
			try {
				await unlink(lockPath);
			} catch {
				// 忽略
			}
			return acquireSingletonLock(lockPath);
		}
	}
}
