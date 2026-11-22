/**
 * 脚本信任记录（T2.7）。
 *
 * 浏览器无法得知一个本地文件是「用户自己写的」还是「下载来的」，所以打开器对所有文件一视同仁：
 * 含脚本的文件第一次打开时脚本**不执行**，顶部询问「此文件包含脚本，是否运行？」。
 * 用户选择「始终运行」后，记下该页面全部可运行代码的指纹（{@link scriptFingerprint}），
 * 以后打开指纹相同的文件直接运行；脚本被改动（指纹变化）会重新询问。
 *
 * 记录保存在 `localStorage`（只在本浏览器、本站点有效）；存储不可用（隐私模式、被禁用）时退化为仅本次会话有效。
 *
 * @module
 */

const KEY = 'edithtml:trusted-scripts';
const MAX = 500;

/** 受信任脚本指纹的集合。 */
export class TrustStore {
  #mem = new Set<string>();

  /** @param storage 持久化位置；传 `null` 只在内存中记录。 */
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeLocalStorage()) {
    try {
      const raw = storage?.getItem(KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) for (const x of list) if (typeof x === 'string') this.#mem.add(x);
    } catch {
      // 损坏的记录当作空
    }
  }

  /** 指纹是否已被信任。 */
  has(fingerprint: string): boolean {
    return this.#mem.has(fingerprint);
  }

  /** 信任一个指纹（最多保留最近 {@link MAX} 个）。 */
  add(fingerprint: string): void {
    this.#mem.delete(fingerprint);
    this.#mem.add(fingerprint);
    while (this.#mem.size > MAX) {
      const oldest = this.#mem.values().next().value;
      if (oldest === undefined) break;
      this.#mem.delete(oldest);
    }
    try {
      this.storage?.setItem(KEY, JSON.stringify([...this.#mem]));
    } catch {
      // 配额满或被禁用：仅本次会话有效
    }
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
