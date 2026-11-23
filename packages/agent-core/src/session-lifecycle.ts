export class SessionConflictError extends Error {}

type ReleaseSessionOperation = () => void;

export class SessionLifecycle {
  private readonly running = new Map<string, number>();
  private readonly deleting = new Set<string>();

  acquireRun(sessionId: string): ReleaseSessionOperation {
    if (this.deleting.has(sessionId)) {
      throw new SessionConflictError('会话正在删除，请稍后重试');
    }
    this.running.set(sessionId, (this.running.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.running.get(sessionId) ?? 0;
      if (count <= 1) this.running.delete(sessionId);
      else this.running.set(sessionId, count - 1);
    };
  }

  acquireDeletion(sessionId: string): ReleaseSessionOperation {
    if (this.running.has(sessionId)) {
      throw new SessionConflictError('会话正在运行，请先停止生成后再删除');
    }
    if (this.deleting.has(sessionId)) {
      throw new SessionConflictError('会话正在删除，请稍后重试');
    }
    this.deleting.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.deleting.delete(sessionId);
    };
  }
}
