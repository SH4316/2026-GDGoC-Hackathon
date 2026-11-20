import { openDB, type DBSchema } from 'idb';
import type { DebugBatch } from './debugSession';

export type DebugLog = { id: string; startedAtMs: number; total: number; sent: number };
export type UploadView = { logs: DebugLog[]; notice: string };
interface DebugStore extends DBSchema {
  logs: { key: string; value: DebugLog };
  pending: { key: [string, number]; value: DebugBatch };
}

function openStore() {
  return openDB<DebugStore>('station-ar-debug', 1, { upgrade(db) {
    db.createObjectStore('logs', { keyPath: 'id' });
    db.createObjectStore('pending', { keyPath: ['id', 'seq'] });
  } });
}

const endpoint = (id: string) => import.meta.env.BASE_URL + 'api/recordings/' + id + '/debug';
export const debugCsvUrl = (id: string) => endpoint(id) + '.csv';

export class DebugUploads {
  private database?: ReturnType<typeof openStore>;
  private get db() {
    return this.database ??= openStore().catch(error => { this.database = undefined; throw error; });
  }
  private waiting: DebugBatch[] = [];
  private writing = false;
  private sending = false;
  private retryAt = 0;
  private timer?: number;
  private listener?: (view: UploadView) => void;
  private logs: DebugLog[] = [];
  private storageError = '';
  private networkError = '';

  listen(listener: (view: UploadView) => void) {
    this.listener = listener;
    this.wake();
    this.timer = window.setInterval(this.tick, 2500);
    window.addEventListener('online', this.wake);
    window.addEventListener('focus', this.wake);
    return () => {
      this.listener = undefined;
      clearInterval(this.timer);
      window.removeEventListener('online', this.wake);
      window.removeEventListener('focus', this.wake);
    };
  }

  enqueue = (batch: DebugBatch) => {
    this.waiting.push(batch);
    void this.stage();
  };

  private tick = () => {
    void this.stage();
    if (this.logs.some(log => log.sent < log.total)) void this.send();
  };
  private wake = () => { this.retryAt = 0; void this.refresh().then(this.tick); };
  private show() { this.listener?.({ logs: this.logs, notice: this.storageError || this.networkError }); }
  private async refresh() {
    try { this.logs = (await (await this.db).getAll('logs')).sort((a, b) => b.startedAtMs - a.startedAtMs); }
    catch { this.storageError = '기기 임시 저장소를 확인해 주세요.'; }
    this.show();
  }

  private async stage() {
    if (this.writing || !this.waiting.length) return;
    this.writing = true;
    try {
      const db = await this.db;
      while (this.waiting.length) {
        const batch = this.waiting[0];
        const tx = db.transaction(['pending', 'logs'], 'readwrite');
        const logs = tx.objectStore('logs');
        const log = await logs.get(batch.id) ?? { id: batch.id, startedAtMs: batch.startedAtMs, total: 0, sent: 0 };
        await Promise.all([tx.objectStore('pending').put(batch),
          logs.put({ ...log, total: log.total + batch.rows.length }), tx.done]);
        this.waiting.shift();
      }
      this.storageError = '';
      void this.send();
    } catch { this.storageError = '기기 임시 저장 실패 · 탭을 열어 두거나 CSV를 받아 주세요.'; }
    finally { this.writing = false; void this.refresh(); }
  }

  private async send() {
    if (this.sending || Date.now() < this.retryAt) return;
    this.sending = true;
    try {
      const db = await this.db;
      const rejected = new Set<string>();
      let rejection = '';
      for (const key of await db.getAllKeys('pending')) {
        if (rejected.has(key[0])) continue;
        const batch = await db.get('pending', key);
        if (!batch) continue;
        const { id, seq, startedAtMs, rows } = batch;
        const response = await fetch(endpoint(id) + '/' + seq, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startedAtMs, rows }), signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          rejected.add(id);
          rejection = '서버 응답 ' + response.status + ' · 자동 재시도';
          continue;
        }
        const ack = await response.json();
        if (ack.id !== id || ack.offset !== seq || ack.rows !== rows.length) throw new Error('서버 저장 확인 실패');
        const tx = db.transaction(['pending', 'logs'], 'readwrite');
        const pending = tx.objectStore('pending'), logs = tx.objectStore('logs');
        // Another tab may already have received the same acknowledgement.
        if (await pending.getKey(key)) {
          const log = (await logs.get(id))!;
          await Promise.all([logs.put({ ...log, sent: log.sent + rows.length }), pending.delete(key), tx.done]);
        } else await tx.done;
        await this.refresh();
      }
      this.networkError = rejection;
      if (rejection) this.retryAt = Date.now() + 3000;
      if (this.logs.some(log => log.sent < log.total)) await this.refresh();
    } catch (error) {
      this.retryAt = Date.now() + 3000;
      const reason = error instanceof Error && error.message.startsWith('서버') ? error.message : '서버 연결 대기';
      this.networkError = reason + ' · 자동 재시도';
    } finally { this.sending = false; this.show(); }
  }
}
