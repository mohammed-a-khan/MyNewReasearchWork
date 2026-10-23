/**
 * JavaScript dialogs (alert, confirm, prompt, beforeunload).
 *
 * Every dialog on every page of the journey is recorded (text masked) and
 * handled; nothing ever hangs waiting for a click. A journey arms the
 * handling of the next dialog declaratively ("Accept the next dialog",
 * "Answer the next prompt with ..."); a dialog nobody armed for is handled by
 * the default policy (dismiss; beforeunload is accepted so navigation can go
 * on) and reported as a warning.
 */
import type { Dialog, Page } from '../browser/index.js';
import { nowIso, type Logger } from '../core/index.js';

export type DialogKind = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface DialogRecord {
  kind: DialogKind;
  /** Masked dialog text. */
  message: string;
  defaultValue?: string;
  url: string;
  at: string;
  handledAs: 'accepted' | 'dismissed';
  /** Answer typed into a prompt (masked). */
  answer?: string;
  /** True when no armed plan handled it (the default policy did). */
  unexpected: boolean;
  /** Consumed by a "dialog seen" expectation. */
  checked?: boolean;
}

export interface DialogPlan {
  op: 'accept' | 'dismiss' | 'answer';
  answer?: string;
  /** Only handle a dialog of this kind (others fall through to the default policy). */
  kind?: DialogKind;
  onHandled?: (rec: DialogRecord) => void;
}

export interface DialogPolicy {
  /** What happens to an alert/confirm/prompt nobody armed for. Default "dismiss". */
  default?: 'accept' | 'dismiss';
  /** What happens to a beforeunload nobody armed for. Default "accept" (leave the page). */
  beforeunload?: 'accept' | 'dismiss';
}

export class DialogManager {
  readonly records: DialogRecord[] = [];
  private plans: DialogPlan[] = [];

  constructor(
    private readonly policy: DialogPolicy,
    private readonly mask: (s: string) => string,
    private readonly logger: Logger,
    private readonly warn: (msg: string) => void,
  ) {}

  /** Arm handling of the next dialog (FIFO). */
  arm(plan: DialogPlan): void {
    this.plans.push(plan);
  }

  /** Plans armed but not used yet. */
  get pending(): number {
    return this.plans.length;
  }

  attach(page: Page): void {
    page.on('dialog', (d) => {
      void this.handle(d, page);
    });
  }

  private async handle(d: Dialog, page: Page): Promise<void> {
    const kind = d.type() as DialogKind;
    const idx = this.plans.findIndex((p) => !p.kind || p.kind === kind);
    const plan = idx >= 0 ? this.plans.splice(idx, 1)[0] : undefined;
    const rec: DialogRecord = {
      kind, message: this.mask(d.message()), url: page.url(), at: nowIso(), handledAs: 'dismissed', unexpected: !plan,
      ...(kind === 'prompt' ? { defaultValue: this.mask(d.defaultValue()) } : {}),
    };
    try {
      if (plan) {
        if (plan.op === 'dismiss') await d.dismiss();
        else {
          const answer = plan.op === 'answer' ? (plan.answer ?? '') : undefined;
          await d.accept(answer);
          rec.handledAs = 'accepted';
          if (answer !== undefined) rec.answer = this.mask(answer);
        }
      } else {
        const policy = kind === 'beforeunload' ? (this.policy.beforeunload ?? 'accept') : (this.policy.default ?? 'dismiss');
        if (policy === 'accept') {
          await d.accept();
          rec.handledAs = 'accepted';
        } else await d.dismiss();
        this.warn(`unexpected ${kind} dialog "${rec.message}" was ${rec.handledAs} (default dialog policy)`);
      }
    } catch (e) {
      this.logger.warn('dialog handling failed', { message: (e as Error).message });
    }
    this.records.push(rec);
    plan?.onHandled?.(rec);
  }
}
