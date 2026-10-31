// A Tinylytics that keeps its kudos and hits in memory, for tests. Nothing reaches the network.

import { TinylyticsUnavailable, type Hit, type Kudo, type Tinylytics } from '../../src/tinylytics.ts';

export class FakeTinylytics implements Tinylytics {
  kudosKept: Kudo[] = [];
  hits: Hit[][] = [];
  reads = 0;
  calls: string[] = [];
  /** `off` acts as a missing key; `down` as Tinylytics failing; a set fails only those calls. */
  state: 'up' | 'off' | 'down' = 'up';
  failing = new Set<string>();
  /** When set, addKudo waits for it, so a test can act while a heart is half made. */
  pause?: Promise<void>;

  private check(op: string, record = true): void {
    if (record) this.calls.push(op);
    if (this.state === 'off') throw new TinylyticsUnavailable('There is no Tinylytics key', true);
    if (this.state === 'down' || this.failing.has(op)) throw new TinylyticsUnavailable('Tinylytics answered 500');
  }

  async addKudo(path: string, uid: string): Promise<void> {
    this.calls.push('addKudo');
    if (this.pause) await this.pause;
    this.check('addKudo', false);
    this.kudosKept.push({ path, uid });
  }

  async removeKudo(uid: string): Promise<void> {
    this.check('removeKudo');
    this.kudosKept = this.kudosKept.filter((k) => k.uid !== uid);
  }

  async kudos(path?: string): Promise<Kudo[]> {
    this.check('kudos');
    this.reads++;
    return this.kudosKept.filter((k) => !path || k.path === path).map((k) => ({ ...k }));
  }

  async addHits(hits: Hit[]): Promise<void> {
    this.check('addHits');
    this.hits.push(hits);
  }
}
