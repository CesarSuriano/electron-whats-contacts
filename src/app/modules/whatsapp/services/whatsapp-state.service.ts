import { Injectable, OnDestroy } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, combineLatest, distinctUntilChanged, map, of, switchMap, timer } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { WhatsappContact, WhatsappEvent, WhatsappInstance, WhatsappMessage } from '../../../models/whatsapp.model';
import { WhatsappWebjsGatewayService } from '../../../services/whatsapp-webjs-gateway.service';
import { WhatsappWsService } from '../../../services/whatsapp-ws.service';

const LOCAL_MESSAGE_TTL_MS = 30000;
const PHOTO_BATCH_SIZE = 6;
const PHOTO_NULL_RETRY_MS = 30 * 60 * 1000;
const CHAT_HISTORY_LIMIT = 180;
const MAX_MESSAGES_PER_CHAT = 260;
const CONVERSATION_CONTEXT_CONCURRENCY = 6;
const INITIAL_PRIORITY_CONVERSATIONS = 25;
const NON_CONVERSATION_LAST_MESSAGE_TYPES = new Set([
  'e2e_notification',
  'notification_template',
  'gp2',
  'biz_content_placeholder'
]);
const SYNCING_HIDE_DELAY_MS = 150;
const INITIAL_SYNC_TOTAL_STEPS = 2;
const INITIAL_SYNC_CONTACTS_STEP = 1;
const INITIAL_SYNC_CONVERSATIONS_STEP = 2;
const INITIAL_SYNC_CONTACTS_START_PERCENT = 8;
const INITIAL_SYNC_CONTACTS_MAX_PERCENT = 42;

export interface WhatsappSyncStatus {
  active: boolean;
  mode: 'idle' | 'initial';
  message: string;
  detail: string;
  currentStep: number;
  totalSteps: number;
  progressPercent: number;
}

const IDLE_SYNC_STATUS: WhatsappSyncStatus = {
  active: false,
  mode: 'idle',
  message: '',
  detail: '',
  currentStep: 0,
  totalSteps: 0,
  progressPercent: 0
};

@Injectable({ providedIn: 'root' })
export class WhatsappStateService implements OnDestroy {
  private readonly instancesSubject = new BehaviorSubject<WhatsappInstance[]>([]);
  private readonly contactsSubject = new BehaviorSubject<WhatsappContact[]>([]);
  private readonly messagesSubject = new BehaviorSubject<WhatsappMessage[]>([]);
  private readonly selectedInstanceSubject = new BehaviorSubject<string>('');
  private readonly selectedContactJidSubject = new BehaviorSubject<string>('');
  private readonly errorMessageSubject = new BehaviorSubject<string>('');
  private readonly loadingStateSubject = new BehaviorSubject<{
    instances: boolean;
    contacts: boolean;
    messages: boolean;
    sending: boolean;
  }>({ instances: false, contacts: false, messages: false, sending: false });
  private readonly selectionModeSubject = new BehaviorSubject<boolean>(false);
  private readonly selectedJidsSubject = new BehaviorSubject<Set<string>>(new Set());
  private readonly draftTextSubject = new BehaviorSubject<string>('');
  private readonly draftImageDataUrlSubject = new BehaviorSubject<string | null>(null);
  private readonly messageSentSubject = new BehaviorSubject<{ jid: string; at: number } | null>(null);

  private eventsInFlight = false;
  private initialSyncDone = false;
  private instancesLoadStarted = false;
  private conversationContextRunId = 0;
  private readonly syncingSubject = new BehaviorSubject<boolean>(false);
  private readonly syncStatusSubject = new BehaviorSubject<WhatsappSyncStatus>(IDLE_SYNC_STATUS);
  private readonly contactHistoryInFlight = new Set<string>();
  private readonly loadedHistoryJids = new Set<string>();
  private readonly destroy$ = new Subject<void>();
  private initialSyncProgressTimer: number | null = null;
  private pendingPhotoJids = new Set<string>();
  private photoRetryUntil = new Map<string, number>();
  private photoRequestTimer: number | null = null;

  instances$: Observable<WhatsappInstance[]> = this.instancesSubject.asObservable();
  contacts$: Observable<WhatsappContact[]> = this.contactsSubject.asObservable();
  messages$: Observable<WhatsappMessage[]> = this.messagesSubject.asObservable();
  selectedInstance$: Observable<string> = this.selectedInstanceSubject.asObservable();
  selectedContactJid$: Observable<string> = this.selectedContactJidSubject.asObservable();
  errorMessage$: Observable<string> = this.errorMessageSubject.asObservable();
  loadingState$ = this.loadingStateSubject.asObservable();
  selectionMode$: Observable<boolean> = this.selectionModeSubject.asObservable();
  selectedJids$: Observable<Set<string>> = this.selectedJidsSubject.asObservable();
  draftText$: Observable<string> = this.draftTextSubject.asObservable();
  draftImageDataUrl$: Observable<string | null> = this.draftImageDataUrlSubject.asObservable();
  messageSent$: Observable<{ jid: string; at: number } | null> = this.messageSentSubject.asObservable();
  syncStatus$: Observable<WhatsappSyncStatus> = this.syncStatusSubject.asObservable();
  syncing$: Observable<boolean> = this.syncingSubject.pipe(
    distinctUntilChanged(),
    switchMap(syncing => syncing
      ? of(true)
      : timer(SYNCING_HIDE_DELAY_MS).pipe(map(() => false))
    )
  );

  selectedMessages$: Observable<WhatsappMessage[]> = combineLatest([
    this.selectedContactJidSubject,
    this.messagesSubject
  ]).pipe(
    map(([jid]) => this.getMessagesFor(jid)),
    distinctUntilChanged((prev, curr) =>
      prev.length === curr.length && prev.every((message, index) => message.id === curr[index].id && message.ack === curr[index].ack)
    )
  );

  selectedContact$: Observable<WhatsappContact | null> = combineLatest([
    this.selectedContactJidSubject,
    this.contactsSubject
  ]).pipe(
    map(([jid, contacts]) => contacts.find(contact => contact.jid === jid) || null),
    distinctUntilChanged((a, b) =>
      a?.jid === b?.jid && a?.name === b?.name && a?.photoUrl === b?.photoUrl
    )
  );

  constructor(private gateway: WhatsappWebjsGatewayService, private ws: WhatsappWsService) {
    this.setupWebSocket();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.ws.disconnect();
    if (this.photoRequestTimer !== null) {
      window.clearTimeout(this.photoRequestTimer);
    }
    this.clearInitialSyncProgressTimer();
  }

  private setupWebSocket(): void {
    this.ws.connect();

    this.ws.on<WhatsappEvent>('new_message').pipe(takeUntil(this.destroy$)).subscribe(event => {
      if (!event || !event.chatJid) {
        return;
      }

      this.ensureContactForEvent(event);

      const messages = this.mapEventsToMessages([event]);
      const merged = this.mergeServerMessages(messages);
      const withLocal = this.mergeWithLocal(merged);
      const pruned = this.pruneMessages(withLocal);
      this.messagesSubject.next(pruned);
      this.resortContactsByLatestMessage(pruned);

      if (this.initialSyncDone && !this.isSyntheticSeedSource(event.source)) {
        const inbound = messages.filter(message => !message.isFromMe);
        if (inbound.length > 0) {
          this.incrementUnreadCounts(inbound);
        }
      }
    });

    this.ws.on<{ messageId: string; ack: number }>('message_ack').pipe(takeUntil(this.destroy$)).subscribe(({ messageId, ack }) => {
      if (!messageId) {
        return;
      }

      const current = this.messagesSubject.value;
      let changed = false;
      const updated = current.map(message => {
        if (message.id === messageId && message.ack !== ack) {
          changed = true;
          return { ...message, ack };
        }
        return message;
      });

      if (changed) {
        this.messagesSubject.next(updated);
        this.resortContactsByLatestMessage(updated);
      }
    });
  }

  get selectedInstance(): string {
    return this.selectedInstanceSubject.value;
  }

  get selectedContactJid(): string {
    return this.selectedContactJidSubject.value;
  }

  get contacts(): WhatsappContact[] {
    return this.contactsSubject.value;
  }

  getContact(jid: string): WhatsappContact | null {
    return this.contactsSubject.value.find(contact => contact.jid === jid) || null;
  }

  getMessagesFor(jid: string): WhatsappMessage[] {
    if (!jid) {
      return [];
    }

    return this.messagesSubject.value
      .filter(message => message.contactJid === jid)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  loadInstances(): void {
    if (this.instancesLoadStarted) {
      return;
    }
    this.instancesLoadStarted = true;
    this.setLoading({ instances: true });
    this.setError('');

    this.gateway.loadInstances().subscribe({
      next: instances => {
        this.instancesSubject.next(instances);
        const preferred = instances.find(i => i.connected) || instances[0];
        this.setLoading({ instances: false });

        if (preferred && preferred.name !== this.selectedInstance) {
          this.selectInstance(preferred.name);
        }
      },
      error: () => {
        this.instancesLoadStarted = false;
        this.setError('Não foi possível carregar as instâncias da bridge WhatsApp.');
        this.setLoading({ instances: false });
      }
    });
  }

  selectInstance(name: string): void {
    this.conversationContextRunId += 1;
    this.loadedHistoryJids.clear();
    this.initialSyncDone = false;
    this.beginInitialSync();
    this.syncingSubject.next(true);
    this.selectedInstanceSubject.next(name);
    this.selectedContactJidSubject.next('');
    this.messagesSubject.next([]);
    this.setLoading({ contacts: true, messages: true });

    void this.loadContacts({ bootstrap: true });
  }

  selectContact(jid: string): Promise<void> {
    this.selectedContactJidSubject.next(jid);
    this.markContactAsRead(jid);

    if (this.shouldForceHistoryLoad(jid)) {
      return this.loadHistorySilentlyForContact(jid);
    }

    return Promise.resolve();
  }

  private markContactAsRead(jid: string): void {
    if (!jid) return;

    const contacts = this.contactsSubject.value;
    const contact = contacts.find(c => c.jid === jid);
    if (contact && (contact.unreadCount || 0) > 0) {
      this.contactsSubject.next(
        contacts.map(c => c.jid === jid ? { ...c, unreadCount: 0 } : c)
      );
    }

    this.gateway.markChatSeen(jid).subscribe({
      error: () => { /* silent - best effort */ }
    });
  }

  refresh(): void {
    void this.loadContacts();

    const currentSelection = this.selectedContactJid;
    void this.runVisibleMessageLoad(async () => {
      await this.loadRecentMessagesSnapshot({ silentError: false, showLoading: false });

      if (!currentSelection) {
        return;
      }

      this.loadedHistoryJids.delete(currentSelection);
      await this.loadMessagesForContact(currentSelection, {
        limit: CHAT_HISTORY_LIMIT,
        markAsLoaded: true,
        force: true
      });
    });
  }

  private async loadConversationContextForContacts(options: {
    contactJids?: string[];
    concurrency?: number;
    force?: boolean;
    ensureContacts?: boolean;
    runId?: number;
    onItemFinished?: (result: { completed: number; total: number; jid: string }) => void;
  } = {}): Promise<void> {
    if (!this.selectedInstance) {
      return;
    }

    const ensureContacts = options.ensureContacts ?? true;
    const force = options.force ?? false;
    const concurrency = Math.max(1, options.concurrency ?? CONVERSATION_CONTEXT_CONCURRENCY);
    const runId = options.runId;
    const onItemFinished = options.onItemFinished;

    if (ensureContacts && this.contactsSubject.value.length === 0) {
      await this.loadContacts();
    }

    const contactJids = (options.contactJids ?? this.contactsSubject.value.map(contact => contact.jid))
      .filter(jid => Boolean(jid));
    const queue = Array.from(new Set(contactJids));

    if (!queue.length) {
      return;
    }

    let cursor = 0;
    let completed = 0;

    const runWorker = async (): Promise<void> => {
      while (true) {
        if (runId !== undefined && runId !== this.conversationContextRunId) {
          return;
        }

        if (cursor >= queue.length) {
          return;
        }

        const currentIndex = cursor;
        cursor += 1;
        const jid = queue[currentIndex];
        await this.loadMessagesForContact(jid, {
          limit: CHAT_HISTORY_LIMIT,
          markAsLoaded: true,
          force
        });

        completed += 1;
        onItemFinished?.({
          completed,
          total: queue.length,
          jid
        });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, () => runWorker())
    );
  }

  private buildBootstrapConversationQueues(): { priorityJids: string[]; remainingJids: string[] } {
    const contacts = this.contactsSubject.value;
    const conversationCandidates = contacts
      .filter(contact => contact.jid && this.isRealConversationForBootstrap(contact))
      .map(contact => ({
        jid: contact.jid,
        ts: this.resolveBootstrapSortTimestampMs(contact)
      }))
      .sort((a, b) => {
        if (a.ts !== b.ts) {
          return b.ts - a.ts;
        }
        return a.jid.localeCompare(b.jid, 'pt-BR');
      })
      .map(item => item.jid);

    if (!conversationCandidates.length) {
      return { priorityJids: [], remainingJids: [] };
    }

    const priorityJids = conversationCandidates.slice(0, INITIAL_PRIORITY_CONVERSATIONS);
    const remainingJids = conversationCandidates.slice(priorityJids.length);

    return {
      priorityJids,
      remainingJids
    };
  }

  private resolveGetChatsTimestampMs(contact: WhatsappContact): number {
    const timestampMs = Number(contact.getChatsTimestampMs || 0);
    if (Number.isFinite(timestampMs) && timestampMs > 0) {
      return timestampMs;
    }

    return 0;
  }

  private resolveBootstrapSortTimestampMs(contact: WhatsappContact): number {
    return this.resolveGetChatsTimestampMs(contact);
  }

  private isRealConversationForBootstrap(contact: WhatsappContact): boolean {
    const timestampMs = this.resolveBootstrapSortTimestampMs(contact);
    if (timestampMs <= 0) {
      return false;
    }

    const lastMessageType = (contact.lastMessageType || '').trim().toLowerCase();
    if (NON_CONVERSATION_LAST_MESSAGE_TYPES.has(lastMessageType)) {
      return false;
    }

    return true;
  }

  private bootstrapConversationContextLoad(): void {
    const runId = this.conversationContextRunId;
    const { priorityJids, remainingJids } = this.buildBootstrapConversationQueues();
    const priorityTotal = priorityJids.length;
    let initialScreenReleased = false;

    const releaseInitialLoading = (): void => {
      if (initialScreenReleased || runId !== this.conversationContextRunId) {
        return;
      }

      initialScreenReleased = true;
      this.setLoading({ messages: false });
      this.finishInitialSync();
      this.onInitialSyncComplete();
    };

    this.beginInitialConversationPhase();

    if (!priorityTotal) {
      this.updateInitialSyncStatus({ progressPercent: 100 });
      releaseInitialLoading();
      this.syncingSubject.next(false);
      return;
    }

    void this.loadConversationContextForContacts({
      contactJids: priorityJids,
      concurrency: CONVERSATION_CONTEXT_CONCURRENCY,
      force: true,
      ensureContacts: false,
      runId,
      onItemFinished: ({ completed, total }) => {
        if (runId !== this.conversationContextRunId) {
          return;
        }

        this.updateInitialSyncStatus({
          progressPercent: 50 + Math.round((completed / Math.max(1, total)) * 50)
        });
      }
    }).then(async () => {
      if (runId === this.conversationContextRunId) {
        this.updateInitialSyncStatus({ progressPercent: 100 });
      }

      releaseInitialLoading();

      if (runId !== this.conversationContextRunId || !remainingJids.length) {
        return;
      }

      await this.loadConversationContextForContacts({
        contactJids: remainingJids,
        concurrency: CONVERSATION_CONTEXT_CONCURRENCY,
        force: true,
        ensureContacts: false,
        runId
      });
    }).finally(() => {
      if (runId === this.conversationContextRunId) {
        releaseInitialLoading();
        this.syncingSubject.next(false);
      }
    });
  }

  sendText(jid: string, text: string): Observable<unknown> {
    this.setLoading({ sending: true });
    this.setError('');

    const instance = this.selectedInstance;
    return new Observable(observer => {
      this.gateway.sendMessage(instance, jid, text).subscribe({
        next: result => {
          const serverId = (result as Record<string, unknown>)?.['id'] as string;
          this.appendOutgoingMessage(jid, text, 'send-api', serverId);
          this.setLoading({ sending: false });
          this.notifyMessageSent(jid);
          observer.next(result);
          observer.complete();
        },
        error: err => {
          this.setError(this.resolveSendErrorMessage(err, 'Não foi possível enviar a mensagem.'));
          this.setLoading({ sending: false });
          observer.error(err);
        }
      });
    });
  }

  sendMedia(jid: string, file: File, caption = ''): Observable<unknown> {
    this.setLoading({ sending: true });
    this.setError('');

    const instance = this.selectedInstance;
    return new Observable(observer => {
      this.gateway.sendMedia(instance, jid, file, caption).subscribe({
        next: result => {
          const serverId = (result as Record<string, unknown>)?.['id'] as string;
          this.appendOutgoingMessage(jid, caption, 'send-media-api', serverId, {
            hasMedia: true,
            mediaFilename: file.name,
            mediaMimetype: file.type || 'application/octet-stream'
          });
          this.setLoading({ sending: false });
          this.notifyMessageSent(jid);
          observer.next(result);
          observer.complete();
        },
        error: err => {
          this.setError(this.resolveSendErrorMessage(err, 'Não foi possível enviar o arquivo.'));
          this.setLoading({ sending: false });
          observer.error(err);
        }
      });
    });
  }

  private appendOutgoingMessage(jid: string, text: string, source: string, serverId?: string, payload?: Record<string, unknown>): void {
    // If we have a server ID, check if the WS broadcast already delivered it
    if (serverId && this.messagesSubject.value.some(m => m.id === serverId)) {
      return;
    }

    const message: WhatsappMessage = {
      id: serverId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      contactJid: jid,
      text,
      sentAt: new Date().toISOString(),
      isFromMe: true,
      source,
      payload
    };
    this.messagesSubject.next([...this.messagesSubject.value, message]);
  }

  enterSelectionMode(): void {
    this.selectionModeSubject.next(true);
  }

  exitSelectionMode(): void {
    this.selectionModeSubject.next(false);
    this.selectedJidsSubject.next(new Set());
  }

  toggleContactSelection(jid: string): void {
    const current = new Set(this.selectedJidsSubject.value);
    if (current.has(jid)) {
      current.delete(jid);
    } else {
      current.add(jid);
    }
    this.selectedJidsSubject.next(current);
  }

  selectAll(jids: string[]): void {
    this.selectedJidsSubject.next(new Set(jids));
  }

  isSelected(jid: string): boolean {
    return this.selectedJidsSubject.value.has(jid);
  }

  get selectedJids(): string[] {
    return Array.from(this.selectedJidsSubject.value);
  }

  get isSelectionMode(): boolean {
    return this.selectionModeSubject.value;
  }

  setDraftText(text: string): void {
    this.draftTextSubject.next(text);
  }

  setDraftImageDataUrl(dataUrl: string | null): void {
    this.draftImageDataUrlSubject.next(dataUrl);
  }

  private notifyMessageSent(jid: string): void {
    this.messageSentSubject.next({ jid, at: Date.now() });
  }

  requestPhoto(jid: string): void {
    if (!jid || this.pendingPhotoJids.has(jid)) {
      return;
    }

    const retryUntil = this.photoRetryUntil.get(jid) || 0;
    if (retryUntil > Date.now()) {
      return;
    }
    if (retryUntil > 0 && retryUntil <= Date.now()) {
      this.photoRetryUntil.delete(jid);
    }

    const existing = this.getContact(jid);
    if (existing && typeof existing.photoUrl === 'string' && existing.photoUrl.length > 0) {
      return;
    }

    this.pendingPhotoJids.add(jid);
    this.schedulePhotoBatch();
  }

  private schedulePhotoBatch(): void {
    if (this.photoRequestTimer !== null) {
      return;
    }

    this.photoRequestTimer = window.setTimeout(() => {
      this.photoRequestTimer = null;
      this.processPhotoBatch();
    }, 150);
  }

  private processPhotoBatch(): void {
    const batch = Array.from(this.pendingPhotoJids).slice(0, PHOTO_BATCH_SIZE);
    batch.forEach(jid => this.pendingPhotoJids.delete(jid));

    batch.forEach(jid => {
      this.gateway.loadContactPhoto(jid).subscribe({
        next: url => this.setContactPhoto(jid, url),
        error: () => this.setContactPhoto(jid, null)
      });
    });

    if (this.pendingPhotoJids.size > 0) {
      this.schedulePhotoBatch();
    }
  }

  private setContactPhoto(jid: string, url: string | null): void {
    if (url === null) {
      this.photoRetryUntil.set(jid, Date.now() + PHOTO_NULL_RETRY_MS);
    } else {
      this.photoRetryUntil.delete(jid);
    }

    const contacts = this.contactsSubject.value.map(contact =>
      contact.jid === jid ? { ...contact, photoUrl: url } : contact
    );
    this.contactsSubject.next(contacts);
  }

  private loadContacts(options: { bootstrap?: boolean } = {}): Promise<void> {
    if (!this.selectedInstance) {
      return Promise.resolve();
    }

    const bootstrap = options.bootstrap ?? false;
    this.setLoading({ contacts: true });

    return new Promise(resolve => {
      this.gateway.loadContacts(this.selectedInstance, { waitForRefresh: bootstrap }).subscribe({
        next: contacts => {
          const current = this.contactsSubject.value;
          const preservedByJid = new Map(current.map(c => [c.jid, c.photoUrl]));
          const preservedByPhone = new Map(
            current
              .filter(c => Boolean(c.phone))
              .map(c => [c.phone, c.photoUrl])
          );
          const enriched = contacts
            .map(contact => ({
              ...contact,
              photoUrl: preservedByJid.has(contact.jid)
                ? preservedByJid.get(contact.jid)
                : (contact.phone && preservedByPhone.has(contact.phone)
                  ? preservedByPhone.get(contact.phone)
                  : contact.photoUrl)
            }))
            .sort((a, b) => {
              const aTs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
              const bTs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
              if (aTs !== bTs) {
                return bTs - aTs;
              }
              return (a.name || '').localeCompare(b.name || '', 'pt-BR');
            });
          this.contactsSubject.next(enriched);
          if (this.messagesSubject.value.length > 0) {
            this.resortContactsByLatestMessage(this.messagesSubject.value);
          }

          const currentSelection = this.selectedContactJid;
          const bootstrapPrioritySelection = bootstrap
            ? (this.buildBootstrapConversationQueues().priorityJids[0] || '')
            : '';
          const fallbackSelection = bootstrapPrioritySelection || enriched[0]?.jid || '';
          const selectedJid = currentSelection && enriched.some(contact => contact.jid === currentSelection)
            ? currentSelection
            : fallbackSelection;

          if (selectedJid && selectedJid !== currentSelection) {
            this.selectedContactJidSubject.next(selectedJid);
            this.markContactAsRead(selectedJid);
          }

          this.setLoading({ contacts: false });

          if (bootstrap) {
            this.bootstrapConversationContextLoad();
            resolve();
            return;
          }

          if (!currentSelection && selectedJid) {
            void this.selectContact(selectedJid);
            resolve();
            return;
          }

          if (
            selectedJid
            && selectedJid === currentSelection
            && this.shouldForceHistoryLoad(selectedJid)
          ) {
            void this.loadHistorySilentlyForContact(selectedJid);
          }

          resolve();
        },
        error: () => {
          this.setError('Não foi possível carregar os contatos.');
          this.setLoading({ contacts: false, messages: false });
          if (options.bootstrap) {
            this.finishInitialSync();
            this.syncingSubject.next(false);
            this.onInitialSyncComplete();
          }
          resolve();
        }
      });
    });
  }

  private loadRecentMessagesSnapshot(
    options: {
      silentError?: boolean;
      showLoading?: boolean;
    } = {}
  ): Promise<void> {
    const silentError = options.silentError ?? false;
    const showLoading = options.showLoading ?? true;

    if (!this.selectedInstance || this.eventsInFlight) {
      return Promise.resolve();
    }

    this.eventsInFlight = true;
    if (showLoading) {
      this.setLoading({ messages: true });
    }

    return new Promise(resolve => {
      this.gateway.loadEvents(this.selectedInstance).subscribe({
        next: events => {
          const incoming = this.mapEventsToMessages(events);
          const mergedServer = this.mergeServerMessages(incoming);
          const merged = this.mergeWithLocal(mergedServer);
          const pruned = this.pruneMessages(merged);
          this.messagesSubject.next(pruned);
          this.resortContactsByLatestMessage(pruned);
          this.eventsInFlight = false;
          if (showLoading) {
            this.setLoading({ messages: false });
          }
          resolve();
        },
        error: () => {
          if (!silentError) {
            this.setError('Falha ao buscar eventos da conversa.');
          }
          this.eventsInFlight = false;
          if (showLoading) {
            this.setLoading({ messages: false });
          }
          resolve();
        }
      });
    });
  }

  private runVisibleMessageLoad(task: () => Promise<void>): Promise<void> {
    this.setLoading({ messages: true });
    return task().finally(() => {
      this.setLoading({ messages: false });
    });
  }

  private loadHistorySilentlyForContact(jid: string): Promise<void> {
    if (!jid) {
      return Promise.resolve();
    }

    return this.loadMessagesForContact(jid, {
      limit: CHAT_HISTORY_LIMIT,
      markAsLoaded: true
    }).then(() => undefined);
  }

  private mergeWithLocal(serverMessages: WhatsappMessage[]): WhatsappMessage[] {
    const cutoff = Date.now() - LOCAL_MESSAGE_TTL_MS;
    const serverKeys = new Set(
      serverMessages.map(m => `${m.contactJid}|${(m.text || '').trim()}|${m.isFromMe ? '1' : '0'}`)
    );

    const localKeepers = this.messagesSubject.value.filter(msg => {
      if (!msg.id.startsWith('local-')) {
        return false;
      }
      const sentAtMs = Date.parse(msg.sentAt);
      if (Number.isFinite(sentAtMs) && sentAtMs < cutoff) {
        return false;
      }
      const key = `${msg.contactJid}|${(msg.text || '').trim()}|${msg.isFromMe ? '1' : '0'}`;
      return !serverKeys.has(key);
    });

    return [...serverMessages, ...localKeepers];
  }

  private mergeServerMessages(incoming: WhatsappMessage[]): WhatsappMessage[] {
    const existingServer = this.messagesSubject.value.filter(msg => !msg.id.startsWith('local-'));
    const map = new Map<string, WhatsappMessage>();

    existingServer.forEach(msg => {
      map.set(msg.id, msg);
    });

    incoming.forEach(msg => {
      const prev = map.get(msg.id);
      map.set(msg.id, prev ? { ...prev, ...msg } : msg);
    });

    return Array.from(map.values());
  }

  private pruneMessages(messages: WhatsappMessage[]): WhatsappMessage[] {
    const grouped = new Map<string, WhatsappMessage[]>();
    for (const message of messages) {
      const key = message.contactJid || '__unknown__';
      const arr = grouped.get(key) || [];
      arr.push(message);
      grouped.set(key, arr);
    }

    const result: WhatsappMessage[] = [];
    grouped.forEach(arr => {
      arr.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
      const keep = arr.slice(-MAX_MESSAGES_PER_CHAT);
      result.push(...keep);
    });

    return result;
  }

  private loadMessagesForContact(
    jid: string,
    options: {
      limit?: number;
      markAsLoaded?: boolean;
      deep?: boolean;
      force?: boolean;
    } = {}
  ): Promise<number> {
    const limit = Math.max(1, Math.min(CHAT_HISTORY_LIMIT, Number(options.limit || CHAT_HISTORY_LIMIT)));
    const markAsLoaded = options.markAsLoaded ?? true;
    const force = options.force ?? false;
    const deep = options.deep ?? markAsLoaded;

    if (!jid || !this.selectedInstance || this.contactHistoryInFlight.has(jid)) {
      return Promise.resolve(0);
    }

    if (markAsLoaded && !force && this.loadedHistoryJids.has(jid)) {
      return Promise.resolve(0);
    }

    this.contactHistoryInFlight.add(jid);

    return new Promise(resolve => {
      this.gateway.loadChatMessages(this.selectedInstance, jid, limit, deep).subscribe({
        next: events => {
          const history = this.mapEventsToMessages(events).filter(message => message.contactJid === jid);

          if (markAsLoaded) {
            if (history.length > 1) {
              this.loadedHistoryJids.add(jid);
            } else {
              this.loadedHistoryJids.delete(jid);
            }
          }

          this.applyHistoryForContact(jid, history);

          this.contactHistoryInFlight.delete(jid);

          resolve(history.length);
        },
        error: () => {
          this.contactHistoryInFlight.delete(jid);

          resolve(0);
        }
      });
    });
  }

  private applyHistoryForContact(jid: string, history: WhatsappMessage[]): void {
    const current = this.messagesSubject.value;
    const serverOthers = current.filter(message => message.contactJid !== jid && !message.id.startsWith('local-'));
    const existingServerChat = current.filter(message => message.contactJid === jid && !message.id.startsWith('local-'));

    const mergedServerChatById = new Map<string, WhatsappMessage>();
    existingServerChat.forEach(message => {
      mergedServerChatById.set(message.id, message);
    });
    history.forEach(message => {
      const prev = mergedServerChatById.get(message.id);
      mergedServerChatById.set(message.id, prev ? { ...prev, ...message } : message);
    });

    const mergedServer = [...serverOthers, ...Array.from(mergedServerChatById.values())];
    const mergedWithLocal = this.mergeWithLocal(mergedServer);
    const pruned = this.pruneMessages(mergedWithLocal);

    this.messagesSubject.next(pruned);
    this.resortContactsByLatestMessage(this.messagesSubject.value);
  }

  private onInitialSyncComplete(): void {
    if (this.initialSyncDone) {
      return;
    }
    this.initialSyncDone = true;
  }

  private beginInitialSync(): void {
    this.clearInitialSyncProgressTimer();
    this.syncStatusSubject.next({
      active: true,
      mode: 'initial',
      message: 'Carregando contatos',
      detail: '',
      currentStep: INITIAL_SYNC_CONTACTS_STEP,
      totalSteps: INITIAL_SYNC_TOTAL_STEPS,
      progressPercent: INITIAL_SYNC_CONTACTS_START_PERCENT
    });

    this.startInitialSyncProgressTimer(INITIAL_SYNC_CONTACTS_MAX_PERCENT);
  }

  private updateInitialSyncStatus(patch: Partial<WhatsappSyncStatus>): void {
    const current = this.syncStatusSubject.value;
    if (!current.active || current.mode !== 'initial') {
      return;
    }

    this.syncStatusSubject.next({
      ...current,
      ...patch
    });
  }

  private finishInitialSync(): void {
    this.clearInitialSyncProgressTimer();
    this.syncStatusSubject.next(IDLE_SYNC_STATUS);
  }

  private beginInitialConversationPhase(): void {
    this.clearInitialSyncProgressTimer();
    this.updateInitialSyncStatus({
      message: 'Carregando as conversas',
      detail: '',
      currentStep: INITIAL_SYNC_CONVERSATIONS_STEP,
      totalSteps: INITIAL_SYNC_TOTAL_STEPS,
      progressPercent: 50
    });
  }

  private startInitialSyncProgressTimer(targetPercent: number): void {
    this.clearInitialSyncProgressTimer();

    const cappedTarget = Math.max(0, Math.min(100, Math.round(targetPercent)));
    this.initialSyncProgressTimer = window.setInterval(() => {
      const current = this.syncStatusSubject.value;
      if (!current.active || current.mode !== 'initial') {
        this.clearInitialSyncProgressTimer();
        return;
      }

      const nextPercent = Math.min(cappedTarget, Math.round(current.progressPercent || 0) + 1);
      if (nextPercent <= current.progressPercent) {
        this.clearInitialSyncProgressTimer();
        return;
      }

      this.updateInitialSyncStatus({ progressPercent: nextPercent });
    }, 140);
  }

  private clearInitialSyncProgressTimer(): void {
    if (this.initialSyncProgressTimer !== null) {
      window.clearInterval(this.initialSyncProgressTimer);
      this.initialSyncProgressTimer = null;
    }
  }

  private shouldForceHistoryLoad(jid: string): boolean {
    const serverMessagesForChat = this.messagesSubject.value.filter(
      message => message.contactJid === jid && !message.id.startsWith('local-')
    );

    if (serverMessagesForChat.length > 1) {
      return false;
    }

    return !this.loadedHistoryJids.has(jid);
  }

  private isSyntheticSeedSource(source: string): boolean {
    return source === 'webjs-seed' || source === 'webjs-seed-chat';
  }

  private isHistorySource(source: string): boolean {
    return source === 'webjs-chat-history' || source === 'webjs-history';
  }

  private resolveMessageTimestampMs(message: WhatsappMessage): number {
    const payloadTimestamp = Number(message.payload?.['timestamp']);
    if (Number.isFinite(payloadTimestamp) && payloadTimestamp > 0) {
      return payloadTimestamp * 1000;
    }

    if (this.isHistorySource(message.source) || this.isSyntheticSeedSource(message.source)) {
      return Number.NaN;
    }

    const sentAtMs = Date.parse(message.sentAt);
    return Number.isFinite(sentAtMs) ? sentAtMs : Number.NaN;
  }

  private ensureContactForEvent(event: WhatsappEvent): void {
    const jid = event.chatJid;
    if (!jid) {
      return;
    }

    const current = this.contactsSubject.value;
    if (current.some(contact => contact.jid === jid)) {
      return;
    }

    const phone = (event.phone || jid.split('@')[0] || '').trim();
    const synthesized: WhatsappContact = {
      jid,
      phone,
      name: phone || jid,
      found: true,
      photoUrl: null,
      lastMessageAt: event.receivedAt || new Date().toISOString(),
      lastMessagePreview: typeof event.text === 'string' ? event.text : '',
      lastMessageFromMe: !!event.isFromMe,
      lastMessageAck: typeof event.ack === 'number' ? event.ack : null,
      lastMessageType: '',
      lastMessageHasMedia: false,
      lastMessageMediaMimetype: '',
      unreadCount: 0,
      labels: [],
      isGroup: jid.endsWith('@g.us'),
      fromGetChats: false,
      getChatsTimestampMs: 0
    };

    this.contactsSubject.next([synthesized, ...current]);
    this.requestPhoto(jid);
  }

  private incrementUnreadCounts(newInbound: WhatsappMessage[]): void {
    const selectedJid = this.selectedContactJid;
    const countByJid = new Map<string, number>();
    for (const msg of newInbound) {
      if (msg.contactJid === selectedJid) continue;
      countByJid.set(msg.contactJid, (countByJid.get(msg.contactJid) || 0) + 1);
    }
    if (!countByJid.size) return;

    const contacts = this.contactsSubject.value;
    let changed = false;
    const updated = contacts.map(c => {
      const inc = countByJid.get(c.jid);
      if (inc) {
        changed = true;
        return { ...c, unreadCount: (c.unreadCount || 0) + inc };
      }
      return c;
    });
    if (changed) {
      this.contactsSubject.next(updated);
    }
  }

  private resortContactsByLatestMessage(messages: WhatsappMessage[]): void {
    const latestByJid = new Map<string, { ts: number; msg: WhatsappMessage; authoritative: boolean }>();
    for (const msg of messages) {
      if (!msg.contactJid) {
        continue;
      }

      if (this.isSyntheticSeedSource(msg.source)) {
        continue;
      }

      const ts = this.resolveMessageTimestampMs(msg);
      if (!Number.isFinite(ts) || ts <= 0) {
        continue;
      }

      const authoritative = this.loadedHistoryJids.has(msg.contactJid) && this.isHistorySource(msg.source);
      const prev = latestByJid.get(msg.contactJid);
      if (!prev || ts > prev.ts || (authoritative && !prev.authoritative)) {
        latestByJid.set(msg.contactJid, { ts, msg, authoritative });
      }
    }

    const current = this.contactsSubject.value;
    if (!current.length) {
      return;
    }

    let changed = false;
    const enriched = current.map(contact => {
      const derived = latestByJid.get(contact.jid);
      if (!derived) {
        return contact;
      }

      const existing = contact.lastMessageAt ? Date.parse(contact.lastMessageAt) : 0;
      if (derived.authoritative || derived.ts >= existing) {
        const preview = this.resolveContactPreviewFromMessage(derived.msg, contact.lastMessagePreview || '');
        const lastMessageAck = derived.msg.isFromMe ? (derived.msg.ack ?? null) : null;
        const lastMessagePayload = derived.msg.payload;
        const lastMessageType = typeof lastMessagePayload?.['type'] === 'string'
          ? lastMessagePayload['type']
          : '';
        const lastMessageMediaMimetype = typeof lastMessagePayload?.['mediaMimetype'] === 'string'
          ? lastMessagePayload['mediaMimetype']
          : '';
        const lastMessageHasMedia = this.isMediaPayload(lastMessagePayload);
        const next = {
          ...contact,
          lastMessageAt: new Date(derived.ts).toISOString(),
          lastMessagePreview: preview,
          lastMessageFromMe: derived.msg.isFromMe,
          lastMessageAck,
          lastMessageType,
          lastMessageHasMedia,
          lastMessageMediaMimetype
        };
        if (
          next.lastMessageAt !== contact.lastMessageAt ||
          next.lastMessagePreview !== contact.lastMessagePreview ||
          next.lastMessageFromMe !== contact.lastMessageFromMe ||
          next.lastMessageAck !== contact.lastMessageAck ||
          next.lastMessageType !== contact.lastMessageType ||
          next.lastMessageHasMedia !== contact.lastMessageHasMedia ||
          next.lastMessageMediaMimetype !== contact.lastMessageMediaMimetype
        ) {
          changed = true;
          return next;
        }
      }
      return contact;
    });

    const sorted = [...enriched].sort((a, b) => {
      const aTs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const bTs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      if (aTs !== bTs) {
        return bTs - aTs;
      }
      return (a.name || '').localeCompare(b.name || '', 'pt-BR');
    });

    const orderChanged = sorted.some((contact, index) => contact.jid !== current[index]?.jid);
    if (changed || orderChanged) {
      this.contactsSubject.next(sorted);
    }
  }

  private mapEventsToMessages(events: WhatsappEvent[]): WhatsappMessage[] {
    return events
      .filter(event => Boolean(event.chatJid))
      .map(event => {
        const payload = this.normalizeEventPayload(event.payload, event.text);

        return {
          id: event.id,
          contactJid: event.chatJid,
          text: this.normalizeEventText(event.text),
          sentAt: event.receivedAt,
          isFromMe: this.normalizeIsFromMe((event as unknown as { isFromMe?: unknown }).isFromMe, event.id),
          source: event.source,
          ack: typeof event.ack === 'number' ? event.ack : (
            typeof payload?.['ack'] === 'number'
              ? payload['ack'] as number
              : null
          ),
          payload
        };
      });
  }

  private normalizeEventPayload(rawPayload: unknown, rawText: unknown): Record<string, unknown> | undefined {
    const payload = (rawPayload && typeof rawPayload === 'object')
      ? { ...(rawPayload as Record<string, unknown>) }
      : undefined;

    const text = typeof rawText === 'string' ? rawText.trim() : '';
    const dataUrlText = this.looksLikeDataUrl(text) ? text : '';
    const rawImageBase64 = this.looksLikeRawImageBase64(text) ? this.normalizeBase64(text) : '';

    if (!payload && !dataUrlText && !rawImageBase64) {
      return undefined;
    }

    const normalized = payload || {};
    const mediaMimetype = typeof normalized['mediaMimetype'] === 'string'
      ? normalized['mediaMimetype'].trim()
      : '';
    const mediaType = typeof normalized['type'] === 'string'
      ? normalized['type'].trim()
      : '';

    const inferredDataUrl = dataUrlText || (rawImageBase64
      ? this.toImageDataUrlFromRawBase64(rawImageBase64, mediaMimetype)
      : '');

    if (inferredDataUrl) {
      normalized['hasMedia'] = true;
      if (typeof normalized['mediaDataUrl'] !== 'string' || !normalized['mediaDataUrl']) {
        normalized['mediaDataUrl'] = inferredDataUrl;
      }

      if (!mediaMimetype) {
        const inferredMimetype = this.readDataUrlMimetype(inferredDataUrl) || 'image/jpeg';
        normalized['mediaMimetype'] = inferredMimetype;
      }

      if (!mediaType) {
        normalized['type'] = 'image';
      }
    }

    return normalized;
  }

  private normalizeEventText(rawText: unknown): string {
    if (typeof rawText !== 'string') {
      return '';
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
      return '';
    }

    if (this.looksLikeDataUrl(trimmed) || this.looksLikeRawImageBase64(trimmed)) {
      return '';
    }

    return rawText;
  }

  private resolveContactPreviewFromMessage(message: WhatsappMessage, fallback: string): string {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (text) {
      return text;
    }

    return this.resolveMediaPreviewLabel(message.payload) || fallback;
  }

  private resolveMediaPreviewLabel(payload?: Record<string, unknown>): string {
    if (!this.isMediaPayload(payload)) {
      return '';
    }

    const mediaMimetype = typeof payload?.['mediaMimetype'] === 'string' ? payload['mediaMimetype'] : '';
    const mediaType = typeof payload?.['type'] === 'string' ? payload['type'] : '';

    if (mediaMimetype.startsWith('image/') || mediaType === 'image') {
      return 'Foto';
    }

    if (mediaMimetype.startsWith('video/') || mediaType === 'video') {
      return 'Video';
    }

    if (mediaMimetype.startsWith('audio/') || mediaType === 'audio' || mediaType === 'ptt') {
      return 'Audio';
    }

    if (mediaType === 'sticker') {
      return 'Figurinha';
    }

    if (mediaType === 'document') {
      return 'Documento';
    }

    return 'Documento';
  }

  private isMediaPayload(payload?: Record<string, unknown>): boolean {
    if (!payload) {
      return false;
    }

    const mediaMimetype = typeof payload['mediaMimetype'] === 'string' ? payload['mediaMimetype'] : '';
    const mediaType = typeof payload['type'] === 'string' ? payload['type'] : '';

    return Boolean(payload['hasMedia'])
      || mediaMimetype.length > 0
      || (typeof payload['mediaDataUrl'] === 'string' && payload['mediaDataUrl'].length > 0)
      || mediaType === 'image'
      || mediaType === 'video'
      || mediaType === 'audio'
      || mediaType === 'ptt'
      || mediaType === 'document'
      || mediaType === 'sticker';
  }

  private looksLikeDataUrl(value: string): boolean {
    return /^data:[^,]+,/i.test(value);
  }

  private looksLikeRawImageBase64(value: string): boolean {
    const normalized = this.normalizeBase64(value);
    if (normalized.length < 256) {
      return false;
    }

    if (normalized.length % 4 === 1) {
      return false;
    }

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
      return false;
    }

    return /^(\/9j\/|iVBORw0KGgo|R0lGOD|UklGR)/.test(normalized);
  }

  private normalizeBase64(value: string): string {
    return value.replace(/\s+/g, '');
  }

  private toImageDataUrlFromRawBase64(rawBase64: string, mimetypeHint: string): string {
    const mimetype = mimetypeHint && mimetypeHint.startsWith('image/')
      ? mimetypeHint
      : 'image/jpeg';
    return `data:${mimetype};base64,${this.normalizeBase64(rawBase64)}`;
  }

  private readDataUrlMimetype(dataUrl: string): string {
    const match = dataUrl.match(/^data:([^;,]+)/i);
    return match && typeof match[1] === 'string' ? match[1].toLowerCase() : '';
  }

  private normalizeIsFromMe(raw: unknown, id: string): boolean {
    if (typeof id === 'string') {
      if (id.startsWith('true_')) {
        return true;
      }
      if (id.startsWith('false_')) {
        return false;
      }
    }

    if (typeof raw === 'boolean') {
      return raw;
    }

    if (typeof raw === 'number') {
      return raw === 1;
    }

    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') {
        return true;
      }
      if (normalized === 'false' || normalized === '0') {
        return false;
      }
    }
    return false;
  }

  private setLoading(patch: Partial<{ instances: boolean; contacts: boolean; messages: boolean; sending: boolean }>): void {
    this.loadingStateSubject.next({ ...this.loadingStateSubject.value, ...patch });
  }

  private resolveSendErrorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof HttpErrorResponse)) {
      return fallback;
    }

    const backendError = error.error;
    const message = typeof backendError?.error === 'string' ? backendError.error : '';
    const details = typeof backendError?.details === 'string' ? backendError.details : '';
    const combined = `${message} ${details}`.toLowerCase();

    if (error.status === 400 && combined.includes('own') && combined.includes('numero')) {
      return 'Envio bloqueado: o destino corresponde ao seu próprio número de WhatsApp.';
    }

    if (error.status === 400 && combined.includes('destination matches')) {
      return 'Envio bloqueado: o destino corresponde ao seu próprio número de WhatsApp.';
    }

    return fallback;
  }

  private setError(message: string): void {
    this.errorMessageSubject.next(message);
  }
}
