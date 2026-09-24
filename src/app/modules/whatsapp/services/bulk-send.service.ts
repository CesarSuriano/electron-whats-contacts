import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';

import { WhatsappContact } from '../../../models/whatsapp.model';
import { renderBulkTemplate } from '../helpers/bulk-message.helper';
import { WhatsappStateService } from './whatsapp-state.service';
import { TelemetryData, telemetry } from '../../../telemetry/telemetry';

export type BulkItemStatus = 'pending' | 'current' | 'done' | 'skipped' | 'error';

export interface BulkItem {
  jid: string;
  name: string;
  status: BulkItemStatus;
  errorMessage?: string;
}

export interface BulkQueue {
  template: string;
  imageDataUrls?: string[];
  // Compatibilidade com filas persistidas antes do suporte a múltiplas imagens.
  imageDataUrl?: string;
  scheduleId?: string;
  items: BulkItem[];
  isPaused: boolean;
  createdAt: string;
}

export interface BulkStartOptions {
  scheduleId?: string;
}

export interface BulkScheduleLifecycleEvent {
  scheduleId: string;
  outcome: 'completed' | 'cancelled';
}

export interface BulkInterruptedEvent {
  queue: BulkQueue;
  remainingItems: BulkItem[];
  processedCount: number;
}

const STORAGE_KEY = 'uniq-system.whatsapp.bulk-queue';
// Imagens ficam em chave própria e só são regravadas quando mudam: a fila é
// persistida a cada contato e serializar o base64 junto travava a interface.
const IMAGES_STORAGE_KEY = 'uniq-system.whatsapp.bulk-queue-images';
const QUEUE_PERSIST_DEBOUNCE_MS = 120;
const POST_SEND_DELAY_MS = 500;

const IMAGES_NOT_PERSISTED = Symbol('images-not-persisted');

// Números de uma execução do envio em massa, para a telemetria.
interface BulkRunStats {
  startedAt: number;
  sent: number;
  skipped: number;
  errors: number;
  contactMsTotal: number;
  sendMsTotal: number;
  sendSamples: number;
}

type PersistedBulkQueue = Omit<BulkQueue, 'imageDataUrls' | 'imageDataUrl'> & { imageCount: number };

@Injectable({ providedIn: 'root' })
export class BulkSendService implements OnDestroy {
  private readonly queueSubject = new BehaviorSubject<BulkQueue | null>(null);
  private readonly destroy$ = new Subject<void>();
  private readonly scheduleLifecycleSubject = new Subject<BulkScheduleLifecycleEvent>();
  private readonly interruptedSubject = new Subject<BulkInterruptedEvent>();
  private sentSubscription: Subscription | null = null;
  private persistTimerId: number | null = null;
  private pendingPersistQueue: BulkQueue | null = null;
  private readonly draftStateJids = new Set<string>();
  private postSendDelayTimerId: number | null = null;
  private trackedSend: { jid: string; remainingMessages: number } | null = null;
  // Referência da lista de imagens já gravada, para não regravar a cada passo.
  private persistedImagesSource: unknown = IMAGES_NOT_PERSISTED;
  // Arquivos já decodificados das imagens da fila, reaproveitados entre contatos.
  private cachedImageFiles: { source: string[]; files: File[] } | null = null;
  private runStats: BulkRunStats | null = null;
  private currentOpenedAt = 0;
  private currentSendStartedAt = 0;

  queue$: Observable<BulkQueue | null> = this.queueSubject.asObservable();
  scheduleLifecycle$: Observable<BulkScheduleLifecycleEvent> = this.scheduleLifecycleSubject.asObservable();
  // Emitido quando uma nova fila substitui outra que ainda tinha contatos pendentes.
  interrupted$: Observable<BulkInterruptedEvent> = this.interruptedSubject.asObservable();

  constructor(private state: WhatsappStateService) {
    this.restoreQueue();
    this.listenMessageSent();
  }

  ngOnDestroy(): void {
    this.clearPostSendDelay();
    this.flushPendingPersist();
    this.destroy$.next();
    this.destroy$.complete();
    this.sentSubscription?.unsubscribe();
  }

  get currentItem(): BulkItem | null {
    const queue = this.queueSubject.value;
    return queue?.items.find(item => item.status === 'current') || null;
  }

  get hasActiveQueue(): boolean {
    return Boolean(this.queueSubject.value);
  }

  get isSendingCurrent(): boolean {
    return this.state.isSending || this.postSendDelayTimerId !== null || this.trackedSend !== null;
  }

  get canSendCurrent(): boolean {
    const queue = this.queueSubject.value;
    const current = this.currentItem;
    if (!queue || queue.isPaused || !current || this.isSendingCurrent) {
      return false;
    }

    const currentJid = this.resolveQueueItemJid(current.jid);

    return !!this.state.getDraftTextForJid(currentJid).trim() || this.resolveCurrentImageDataUrls(currentJid, queue).length > 0;
  }

  start(contacts: WhatsappContact[], template: string, imageData?: string | string[], options: BulkStartOptions = {}): void {
    if (!contacts.length) {
      return;
    }
    // Aceita iniciar sem template: nesse caso o painel exibe um draft em
    // branco para cada contato e o usuário compõe a mensagem manualmente.
    // Continua aceitando template vazio quando há ao menos uma imagem.

    const imageDataUrls = this.normalizeImageDataUrls(imageData);
    const previousQueue = this.queueSubject.value;

    this.clearPostSendDelay();
    this.trackedSend = null;
    this.clearDraftStateForJids(Array.from(this.draftStateJids));

    const queue: BulkQueue = {
      template,
      imageDataUrls: imageDataUrls.length ? imageDataUrls : undefined,
      scheduleId: options.scheduleId,
      items: contacts.map((contact, index) => ({
        jid: contact.jid,
        name: contact.name || contact.phone,
        status: index === 0 ? 'current' : 'pending'
      })),
      isPaused: false,
      createdAt: new Date().toISOString()
    };

    if (previousQueue) {
      this.emitInterrupted(previousQueue);
    }

    this.setQueue(queue);
    this.runStats = this.createRunStats();
    telemetry.track('bulk.start', {
      total: queue.items.length,
      images: imageDataUrls.length,
      templateChars: template.length,
      fromSchedule: Boolean(options.scheduleId),
      replacedQueue: Boolean(previousQueue)
    });
    this.openCurrent();
  }

  pause(): void {
    const queue = this.queueSubject.value;
    if (!queue || queue.isPaused) {
      return;
    }
    telemetry.track('bulk.pause', this.buildRunSummary(queue));
    this.setQueue({ ...queue, isPaused: true });
  }

  resume(): void {
    const queue = this.queueSubject.value;
    if (!queue || !queue.isPaused) {
      return;
    }
    telemetry.track('bulk.resume', this.buildRunSummary(queue));
    this.runStats ??= this.createRunStats();
    this.setQueue({ ...queue, isPaused: false });

    if (!this.currentItem) {
      this.advanceToNext();
    } else {
      this.openCurrent();
    }
  }

  updateTemplate(template: string, imageData?: string | string[]): void {
    const queue = this.queueSubject.value;
    if (!queue || this.isSendingCurrent) {
      return;
    }

    const imageDataUrls = this.normalizeImageDataUrls(imageData);
    this.setQueue({
      ...queue,
      template,
      imageDataUrls: imageDataUrls.length ? imageDataUrls : undefined,
      imageDataUrl: imageDataUrls[0]
    });
    this.openCurrent();
  }

  trackCurrentSend(jid: string, messageCount: number): void {
    const current = this.currentItem;
    const currentJid = current ? this.resolveQueueItemJid(current.jid) : '';

    if (!current || currentJid !== jid || messageCount <= 0) {
      return;
    }

    this.trackedSend = { jid, remainingMessages: messageCount };
    this.currentSendStartedAt = Date.now();
  }

  clearTrackedCurrentSend(jid: string): void {
    if (this.trackedSend?.jid === jid) {
      this.trackedSend = null;
    }
  }

  skipCurrent(): void {
    if (this.isSendingCurrent) {
      return;
    }

    const current = this.currentItem;
    const currentJid = current ? this.resolveQueueItemJid(current.jid) : '';

    this.clearTrackedCurrentSend(currentJid);
    if (this.runStats) {
      this.runStats.skipped += 1;
    }
    telemetry.track('bulk.item_skipped', { index: this.currentIndex() });
    this.updateCurrent('skipped');
    this.clearDraftStateForJids(currentJid ? [currentJid] : []);
    this.advanceToNext();
  }

  sendCurrent(): void {
    const queue = this.queueSubject.value;
    const current = this.currentItem;
    if (!queue || queue.isPaused || !current || this.isSendingCurrent) {
      return;
    }

    const currentJid = this.resolveQueueItemJid(current.jid);
    const caption = this.state.getDraftTextForJid(currentJid).trim();
    const imageDataUrls = this.resolveCurrentImageDataUrls(currentJid, queue);

    if (imageDataUrls.length) {
      const files = this.resolveImageFiles(imageDataUrls);
      if (!files) {
        return;
      }

      this.trackCurrentSend(currentJid, files.length);
      this.sendMediaBatch(currentJid, files, caption);
      return;
    }

    if (!caption) {
      return;
    }

    this.trackCurrentSend(currentJid, 1);
    this.state.sendText(currentJid, caption).subscribe({
      next: () => {},
      error: () => {
        this.recordItemError('text');
        this.clearTrackedCurrentSend(currentJid);
      }
    });
  }

  cancel(): void {
    const queue = this.queueSubject.value;
    if (this.isSendingCurrent) {
      return;
    }

    if (!queue) {
      return;
    }

    telemetry.track('bulk.cancel', this.buildRunSummary(queue));
    this.runStats = null;
    this.trackedSend = null;
    this.clearQueueDraftState();
    this.setQueue(null);

    if (queue.scheduleId) {
      this.scheduleLifecycleSubject.next({ scheduleId: queue.scheduleId, outcome: 'cancelled' });
    }
  }

  private createRunStats(): BulkRunStats {
    return { startedAt: Date.now(), sent: 0, skipped: 0, errors: 0, contactMsTotal: 0, sendMsTotal: 0, sendSamples: 0 };
  }

  private currentIndex(): number {
    const queue = this.queueSubject.value;
    return queue ? queue.items.findIndex(item => item.status === 'current') + 1 : 0;
  }

  private recordItemError(kind: 'text' | 'media'): void {
    if (this.runStats) {
      this.runStats.errors += 1;
    }
    telemetry.track('bulk.item_error', { kind, index: this.currentIndex() });
  }

  // Resumo da execução atual (sem nomes nem números).
  private buildRunSummary(queue: BulkQueue): TelemetryData {
    const stats = this.runStats;
    const count = (status: BulkItemStatus) => queue.items.filter(item => item.status === status).length;
    return {
      total: queue.items.length,
      done: count('done'),
      skipped: count('skipped'),
      remaining: count('pending') + count('current'),
      errors: stats?.errors ?? 0,
      images: this.resolveQueueImageDataUrls(queue).length,
      fromSchedule: Boolean(queue.scheduleId),
      durationMs: stats ? Date.now() - stats.startedAt : null,
      avgContactMs: stats && stats.sent ? Math.round(stats.contactMsTotal / stats.sent) : null,
      avgSendMs: stats && stats.sendSamples ? Math.round(stats.sendMsTotal / stats.sendSamples) : null
    };
  }

  private emitInterrupted(queue: BulkQueue): void {
    const remainingItems = queue.items.filter(item => item.status === 'pending' || item.status === 'current');
    if (!remainingItems.length) {
      return;
    }

    telemetry.track('bulk.interrupted', { ...this.buildRunSummary(queue), remaining: remainingItems.length });
    this.interruptedSubject.next({
      queue,
      remainingItems,
      processedCount: queue.items.length - remainingItems.length
    });
  }

  private openCurrent(): void {
    const current = this.currentItem;
    if (!current) {
      return;
    }

    const queue = this.queueSubject.value;
    if (!queue) {
      return;
    }

    const currentJid = this.resolveQueueItemJid(current.jid);

    if (this.state.selectedContactJid !== currentJid) {
      void this.state.selectContact(currentJid, { loadHistory: false, markAsRead: false });
    }

    this.state.setDraftTextForJid(currentJid, renderBulkTemplate(queue.template, current.name));
    this.state.setDraftImageDataUrlsForJid(currentJid, this.resolveQueueImageDataUrls(queue));
    this.draftStateJids.add(currentJid);
    this.currentOpenedAt = Date.now();
    this.currentSendStartedAt = 0;
  }

  private resolveCurrentImageDataUrls(jid: string, queue: BulkQueue): string[] {
    const queueImageDataUrls = this.resolveQueueImageDataUrls(queue);
    return queueImageDataUrls.length ? queueImageDataUrls : this.state.getDraftImageDataUrlsForJid(jid);
  }

  private resolveQueueImageDataUrls(queue: BulkQueue): string[] {
    return this.normalizeImageDataUrls(queue.imageDataUrls?.length ? queue.imageDataUrls : queue.imageDataUrl);
  }

  private resolveQueueItemJid(jid: string): string {
    return this.state.resolveConversationJid(jid);
  }

  private sendMediaBatch(jid: string, files: File[], caption: string, index = 0): void {
    this.state.sendMedia(jid, files[index], index === 0 ? caption : '').subscribe({
      next: () => {
        if (index < files.length - 1) {
          this.sendMediaBatch(jid, files, caption, index + 1);
        }
      },
      error: () => {
        this.recordItemError('media');
        this.clearTrackedCurrentSend(jid);
      }
    });
  }

  // As mesmas imagens vão para todos os contatos: decodifica o base64 uma vez
  // e reaproveita os arquivos enquanto as imagens não mudarem.
  private resolveImageFiles(imageDataUrls: string[]): File[] | null {
    const cached = this.cachedImageFiles;
    if (
      cached
      && cached.source.length === imageDataUrls.length
      && cached.source.every((dataUrl, index) => dataUrl === imageDataUrls[index])
    ) {
      return cached.files;
    }

    const files = imageDataUrls.map((imageDataUrl, index) =>
      this.dataUrlToFile(
        imageDataUrl,
        imageDataUrls.length === 1 ? 'bulk-template' : `bulk-template-${index + 1}`
      )
    );

    if (files.some(file => !file)) {
      return null;
    }

    this.cachedImageFiles = { source: [...imageDataUrls], files: files as File[] };
    return this.cachedImageFiles.files;
  }

  private dataUrlToFile(dataUrl: string, filenameBase = 'bulk-template'): File | null {
    try {
      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex === -1) {
        return null;
      }

      const header = dataUrl.slice(0, commaIndex);
      const base64Data = dataUrl.slice(commaIndex + 1);
      const mimeMatch = header.match(/:(.*?);/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const byteString = atob(base64Data);
      const bytes = new Uint8Array(byteString.length);

      for (let index = 0; index < byteString.length; index += 1) {
        bytes[index] = byteString.charCodeAt(index);
      }

      const extension = this.detectExtensionFromMime(mime);
      return new File([bytes], `${filenameBase}.${extension}`, { type: mime });
    } catch {
      return null;
    }
  }

  private normalizeImageDataUrls(imageData?: string | string[]): string[] {
    if (Array.isArray(imageData)) {
      return imageData.filter((dataUrl): dataUrl is string => Boolean(dataUrl));
    }

    return imageData ? [imageData] : [];
  }

  private detectExtensionFromMime(mime: string): string {
    const subtype = mime.split('/')[1] || 'bin';
    const normalized = subtype.split(';')[0].toLowerCase();
    if (normalized === 'jpeg') {
      return 'jpg';
    }
    return normalized.includes('+') ? normalized.split('+')[0] : normalized;
  }

  private advanceToNext(): void {
    const queue = this.queueSubject.value;
    if (!queue) {
      return;
    }

    if (queue.isPaused) {
      return;
    }

    const nextIndex = queue.items.findIndex(item => item.status === 'pending');
    if (nextIndex === -1) {
      this.finishQueue();
      return;
    }

    const items = queue.items.map((item, index) =>
      index === nextIndex ? { ...item, status: 'current' as BulkItemStatus } : item
    );

    this.setQueue({ ...queue, items });
    this.openCurrent();
  }

  private finishQueue(): void {
    const queue = this.queueSubject.value;
    if (queue) {
      telemetry.track('bulk.finish', this.buildRunSummary(queue));
      this.clearQueueDraftState();
    }
    this.runStats = null;

    this.setQueue(null);

    if (queue?.scheduleId) {
      this.scheduleLifecycleSubject.next({ scheduleId: queue.scheduleId, outcome: 'completed' });
    }
  }

  private updateCurrent(status: BulkItemStatus, errorMessage?: string): void {
    const queue = this.queueSubject.value;
    if (!queue) {
      return;
    }

    const items = queue.items.map(item =>
      item.status === 'current' ? { ...item, status, errorMessage } : item
    );

    this.setQueue({ ...queue, items });
  }

  private listenMessageSent(): void {
    this.sentSubscription = this.state.messageSent$
      .pipe(
        takeUntil(this.destroy$),
        filter((event): event is { jid: string; at: number } => event !== null)
      )
      .subscribe(event => {
        const current = this.currentItem;
        const currentJid = current ? this.resolveQueueItemJid(current.jid) : '';
        if (!current || currentJid !== event.jid) {
          return;
        }

        if (this.trackedSend?.jid === event.jid) {
          if (this.trackedSend.remainingMessages > 1) {
            this.trackedSend = {
              jid: event.jid,
              remainingMessages: this.trackedSend.remainingMessages - 1
            };
            return;
          }

          this.trackedSend = null;
        }

        this.completeCurrentSend(currentJid);
      });
  }

  private completeCurrentSend(jid: string): void {
    const current = this.currentItem;
    const currentJid = current ? this.resolveQueueItemJid(current.jid) : '';

    if (!current || currentJid !== jid) {
      return;
    }

    const now = Date.now();
    const contactMs = this.currentOpenedAt ? now - this.currentOpenedAt : null;
    const sendMs = this.currentSendStartedAt ? now - this.currentSendStartedAt : null;
    if (this.runStats) {
      this.runStats.sent += 1;
      this.runStats.contactMsTotal += contactMs ?? 0;
      if (sendMs !== null) {
        this.runStats.sendMsTotal += sendMs;
        this.runStats.sendSamples += 1;
      }
    }
    telemetry.track('bulk.item_sent', { index: this.currentIndex(), total: this.queueSubject.value?.items.length ?? 0, contactMs, sendMs });

    this.updateCurrent('done');
    this.clearDraftStateForJids([currentJid]);
    this.startPostSendDelay();
  }

  private startPostSendDelay(): void {
    this.clearPostSendDelay();
    this.postSendDelayTimerId = window.setTimeout(() => {
      this.postSendDelayTimerId = null;
      this.advanceToNext();
    }, POST_SEND_DELAY_MS);
  }

  private clearPostSendDelay(): void {
    if (this.postSendDelayTimerId === null) {
      return;
    }

    window.clearTimeout(this.postSendDelayTimerId);
    this.postSendDelayTimerId = null;
  }

  private setQueue(queue: BulkQueue | null): void {
    if (!queue) {
      this.cachedImageFiles = null;
    }

    this.queueSubject.next(queue);
    this.schedulePersist(queue);
  }

  private clearQueueDraftState(): void {
    this.trackedSend = null;
    this.clearDraftStateForJids(Array.from(this.draftStateJids));
  }

  private clearDraftStateForJids(jids: string[]): void {
    if (!jids.length) {
      return;
    }

    this.state.clearDraftTextsForJids(jids);
    this.state.clearDraftImageDataUrlsForJids(jids);
    jids.forEach(jid => this.draftStateJids.delete(jid));
  }

  private schedulePersist(queue: BulkQueue | null): void {
    this.pendingPersistQueue = queue;

    if (this.persistTimerId !== null) {
      window.clearTimeout(this.persistTimerId);
      this.persistTimerId = null;
    }

    if (!queue) {
      this.persistQueue(null);
      return;
    }

    this.persistTimerId = window.setTimeout(() => {
      const snapshot = this.pendingPersistQueue;
      this.persistTimerId = null;
      this.persistQueue(snapshot);
    }, QUEUE_PERSIST_DEBOUNCE_MS);
  }

  private flushPendingPersist(): void {
    if (this.persistTimerId === null) {
      return;
    }

    window.clearTimeout(this.persistTimerId);
    this.persistTimerId = null;
    this.persistQueue(this.pendingPersistQueue);
  }

  private persistQueue(queue: BulkQueue | null): void {
    if (!queue) {
      this.clearPersistedQueue();
      return;
    }

    const imagesSource = queue.imageDataUrls ?? queue.imageDataUrl;
    const imageDataUrls = this.resolveQueueImageDataUrls(queue);

    if (imagesSource !== this.persistedImagesSource) {
      this.persistedImagesSource = imagesSource;
      try {
        if (imageDataUrls.length) {
          localStorage.setItem(IMAGES_STORAGE_KEY, JSON.stringify(imageDataUrls));
        } else {
          localStorage.removeItem(IMAGES_STORAGE_KEY);
        }
      } catch {
        // Sem espaço para as imagens: a restauração descarta a fila em vez de
        // retomar um envio que perderia as imagens.
        this.removeStorageKey(IMAGES_STORAGE_KEY);
      }
    }

    try {
      const { imageDataUrls: _images, imageDataUrl: _legacyImage, ...rest } = queue;
      const persisted: PersistedBulkQueue = { ...rest, imageCount: imageDataUrls.length };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // ignore persistence errors
    }
  }

  private clearPersistedQueue(): void {
    this.persistedImagesSource = IMAGES_NOT_PERSISTED;
    this.removeStorageKey(STORAGE_KEY);
    this.removeStorageKey(IMAGES_STORAGE_KEY);
  }

  private removeStorageKey(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore persistence errors
    }
  }

  private readPersistedImages(): string[] | null {
    const raw = localStorage.getItem(IMAGES_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? this.normalizeImageDataUrls(parsed as string[]) : null;
  }

  private restoreQueue(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as BulkQueue & { imageCount?: number };
      if (!parsed || !Array.isArray(parsed.items) || typeof parsed.template !== 'string') {
        return;
      }

      const { imageCount, ...queueFields } = parsed;
      let imageDataUrls: string[];

      if (typeof imageCount === 'number') {
        const storedImages = this.readPersistedImages();
        if (!storedImages || storedImages.length !== imageCount) {
          this.clearPersistedQueue();
          return;
        }
        imageDataUrls = storedImages;
      } else {
        // Formato antigo: imagens gravadas junto com a fila.
        imageDataUrls = this.normalizeImageDataUrls(parsed.imageDataUrls?.length ? parsed.imageDataUrls : parsed.imageDataUrl);
      }

      const restored: BulkQueue = {
        ...queueFields,
        imageDataUrls: imageDataUrls.length ? imageDataUrls : undefined,
        imageDataUrl: undefined,
        isPaused: true,
        items: parsed.items.map(item =>
          item.status === 'current' ? { ...item, status: 'pending' } : item
        )
      };

      this.queueSubject.next(restored);
      telemetry.track('bulk.restored', {
        ...this.buildRunSummary(restored),
        savedHoursAgo: Math.round((Date.now() - Date.parse(restored.createdAt)) / 3_600_000) || 0
      });
      if (typeof imageCount === 'number') {
        this.persistedImagesSource = restored.imageDataUrls;
      }
    } catch {
      this.clearPersistedQueue();
    }
  }
}
