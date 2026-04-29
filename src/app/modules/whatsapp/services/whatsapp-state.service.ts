import { Injectable, OnDestroy } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, combineLatest, distinctUntilChanged, map, of, switchMap, timer } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { WhatsappContact, WhatsappEvent, WhatsappInstance, WhatsappMessage } from '../../../models/whatsapp.model';
import { extractDigits } from '../helpers/phone-format.helper';
import { WhatsappWebjsGatewayService } from '../../../services/whatsapp-webjs-gateway.service';
import { WhatsappWsService } from '../../../services/whatsapp-ws.service';

export interface SelectContactOptions {
  loadHistory?: boolean;
  markAsRead?: boolean;
}

const LOCAL_MESSAGE_TTL_MS = 30000;
const PHOTO_BATCH_SIZE = 6;
const PHOTO_NULL_RETRY_MS = 30 * 60 * 1000;
const CHAT_HISTORY_LIMIT = 180;
const CONVERSATION_CONTEXT_MESSAGES_PER_CHAT = 10;
const MAX_MESSAGES_PER_CHAT = 260;
const CONVERSATION_CONTEXT_CONCURRENCY = 6;
const INITIAL_PRIORITY_CONVERSATIONS = 50;
const BACKGROUND_PRIORITY_CONVERSATIONS = 50;
const CONVERSATION_CONTEXT_BATCH_DELAY_MS = 150;
const NON_CONVERSATION_LAST_MESSAGE_TYPES = new Set([
  'e2e_notification',
  'notification_template',
  'gp2',
  'biz_content_placeholder'
]);
const SYNCING_HIDE_DELAY_MS = 150;
const BOOTSTRAP_CONTACTS_RETRY_DELAY_MS = 2000;
const BOOTSTRAP_CONTACTS_MAX_RETRIES = 5;
const INITIAL_SYNC_TOTAL_STEPS = 2;
const INITIAL_SYNC_CONTACTS_STEP = 1;
const INITIAL_SYNC_CONVERSATIONS_STEP = 2;
const INITIAL_SYNC_CONTACTS_START_PERCENT = 8;
const INITIAL_SYNC_CONTACTS_MAX_PERCENT = 42;

const CONTACT_SCORE_CANONICAL_JID = 40;
const CONTACT_SCORE_LINKED_ID = 5;
const CONTACT_SCORE_FOUND = 20;
const CONTACT_SCORE_FROM_GET_CHATS = 10;
const CONTACT_SCORE_PHONE_MATCH = 6;
const CONTACT_SCORE_JID_EXACT = 8;
const CONTACT_SCORE_SYNTHETIC_ALIAS_PENALTY = -50;
const CONTACT_SCORE_BR_PHONE_BONUS = 30;
const CONTACT_SCORE_BR_PHONE_9TH_DIGIT_BONUS = 10;
const CONTACT_SCORE_VALID_PHONE_BONUS = 20;
const CONTACT_SCORE_EXTENDED_PHONE_BONUS = 10;

export interface WhatsappSyncStatus {
  active: boolean;
  mode: 'idle' | 'initial';
  message: string;
  detail: string;
  currentStep: number;
  totalSteps: number;
  progressPercent: number;
}

interface ConversationContextRequest {
  jid: string;
  limit?: number;
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
  private contactIndexByKey = new Map<string, WhatsappContact[]>();
  private contactIndexDirty = true;
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
  private readonly draftTextByJidSubject = new BehaviorSubject<Record<string, string>>({});
  private readonly draftImageDataUrlByJidSubject = new BehaviorSubject<Record<string, string | null>>({});
  private readonly messageSentSubject = new BehaviorSubject<{ jid: string; at: number } | null>(null);

  private eventsInFlight = false;
  private initialSyncDone = false;
  private instancesLoadStarted = false;
  private conversationContextRunId = 0;
  private bootstrapRetryCount = 0;
  private readonly syncingSubject = new BehaviorSubject<boolean>(false);
  private readonly syncStatusSubject = new BehaviorSubject<WhatsappSyncStatus>(IDLE_SYNC_STATUS);
  private readonly contactHistoryInFlight = new Set<string>();
  private readonly loadedHistoryJids = new Set<string>();
  private readonly warmedConversationContextLimitByJid = new Map<string, number>();
  private readonly destroy$ = new Subject<void>();
  private initialSyncProgressTimer: number | null = null;
  private pendingPhotoJids = new Set<string>();
  private photoRetryUntil = new Map<string, number>();
  private photoRequestTimer: number | null = null;
  private pendingConversationContextJids = new Set<string>();
  private conversationContextRequestTimer: number | null = null;

  instances$: Observable<WhatsappInstance[]> = this.instancesSubject.asObservable();
  contacts$: Observable<WhatsappContact[]> = this.contactsSubject.asObservable();
  messages$: Observable<WhatsappMessage[]> = this.messagesSubject.asObservable();
  selectedInstance$: Observable<string> = this.selectedInstanceSubject.asObservable();
  selectedContactJid$: Observable<string> = this.selectedContactJidSubject.asObservable();
  errorMessage$: Observable<string> = this.errorMessageSubject.asObservable();
  loadingState$ = this.loadingStateSubject.asObservable();
  selectionMode$: Observable<boolean> = this.selectionModeSubject.asObservable();
  selectedJids$: Observable<Set<string>> = this.selectedJidsSubject.asObservable();
  draftText$: Observable<string> = combineLatest([
    this.selectedContactJidSubject,
    this.draftTextByJidSubject
  ]).pipe(
    map(([jid, drafts]) => jid ? drafts[jid] || '' : ''),
    distinctUntilChanged()
  );
  draftImageDataUrl$: Observable<string | null> = combineLatest([
    this.selectedContactJidSubject,
    this.draftImageDataUrlByJidSubject
  ]).pipe(
    map(([jid, drafts]) => jid ? drafts[jid] ?? null : null),
    distinctUntilChanged()
  );
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
    map(([jid, contacts]) => {
      const existing = this.findEquivalentContact(jid, contacts);
      if (existing || !jid) {
        return existing;
      }

      return this.buildSyntheticSelectedContact(jid);
    }),
    distinctUntilChanged((a, b) =>
      a?.jid === b?.jid && a?.name === b?.name && a?.photoUrl === b?.photoUrl && a?.phone === b?.phone
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
    this.clearConversationContextBatchTimer();
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

  get isSending(): boolean {
    return this.loadingStateSubject.value.sending;
  }

  get contacts(): WhatsappContact[] {
    return this.contactsSubject.value;
  }

  getContact(jid: string): WhatsappContact | null {
    return this.findEquivalentContact(jid);
  }

  resolveConversationJid(jid: string): string {
    return this.findEquivalentContact(jid)?.jid || jid;
  }

  getDraftTextForJid(jid: string): string {
    return jid ? this.draftTextByJidSubject.value[jid] || '' : '';
  }

  getDraftImageDataUrlForJid(jid: string): string | null {
    return jid ? this.draftImageDataUrlByJidSubject.value[jid] ?? null : null;
  }

  getMessagesFor(jid: string): WhatsappMessage[] {
    if (!jid) {
      return [];
    }

    return this.messagesSubject.value
      .filter(message => message.contactJid === jid)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  clearErrorMessage(): void {
    this.setError('');
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
    this.warmedConversationContextLimitByJid.clear();
    this.pendingConversationContextJids.clear();
    this.clearConversationContextBatchTimer();
    this.initialSyncDone = false;
    this.bootstrapRetryCount = 0;
    this.beginInitialSync();
    this.syncingSubject.next(true);
    this.selectedInstanceSubject.next(name);
    this.selectedContactJidSubject.next('');
    this.messagesSubject.next([]);
    this.draftTextByJidSubject.next({});
    this.draftImageDataUrlByJidSubject.next({});
    this.setLoading({ contacts: true, messages: true });

    void this.loadContacts({ bootstrap: true });
  }

  selectContact(jid: string, options: SelectContactOptions = {}): Promise<void> {
    const shouldMarkAsRead = options.markAsRead ?? true;
    const shouldLoadHistory = options.loadHistory ?? true;
    const resolvedJid = this.resolveConversationJid(jid);

    this.selectedContactJidSubject.next(resolvedJid);
    if (shouldMarkAsRead) {
      this.markContactAsRead(resolvedJid);
    }

    if (shouldLoadHistory && this.shouldForceHistoryLoad(resolvedJid)) {
      return this.loadHistorySilentlyForContact(resolvedJid);
    }

    return Promise.resolve();
  }

  private markContactAsRead(jid: string): void {
    const resolvedJid = this.resolveConversationJid(jid);
    if (!resolvedJid) return;

    const contacts = this.contactsSubject.value;
    const contact = contacts.find(c => c.jid === resolvedJid);
    if (contact && (contact.unreadCount || 0) > 0) {
      this.setContacts(contacts.map(c => c.jid === resolvedJid ? { ...c, unreadCount: 0 } : c));
    }

    this.gateway.markChatSeen(resolvedJid).subscribe({
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
    contactRequests?: ConversationContextRequest[];
    contactJids?: string[];
    concurrency?: number;
    force?: boolean;
    ensureContacts?: boolean;
    limit?: number;
    deep?: boolean;
    markAsLoaded?: boolean;
    markAsWarmed?: boolean;
    runId?: number;
    onItemFinished?: (result: { completed: number; total: number; jid: string }) => void;
  } = {}): Promise<void> {
    if (!this.selectedInstance) {
      return;
    }

    const ensureContacts = options.ensureContacts ?? true;
    const force = options.force ?? false;
    const concurrency = Math.max(1, options.concurrency ?? CONVERSATION_CONTEXT_CONCURRENCY);
    const limit = Math.max(1, Math.min(CHAT_HISTORY_LIMIT, Number(options.limit || CHAT_HISTORY_LIMIT)));
    const deep = options.deep ?? true;
    const markAsLoaded = options.markAsLoaded ?? true;
    const markAsWarmed = options.markAsWarmed ?? false;
    const runId = options.runId;
    const onItemFinished = options.onItemFinished;

    if (ensureContacts && this.contactsSubject.value.length === 0) {
      await this.loadContacts();
    }

    const contactRequests: ConversationContextRequest[] = options.contactRequests
      ?? (options.contactJids ?? this.contactsSubject.value.map(contact => contact.jid))
        .filter(jid => Boolean(jid))
        .map(jid => ({ jid }));
    const queue: ConversationContextRequest[] = Array.from(
      new Map<string, ConversationContextRequest>(
        contactRequests
          .filter(request => Boolean(request?.jid))
          .map((request): [string, ConversationContextRequest] => [request.jid, request])
      ).values()
    );

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
        const request = queue[currentIndex];
        const jid = request.jid;
        const requestedLimit = this.resolveConversationContextLimit(jid, request.limit ?? limit);
        const loadedCount = await this.loadMessagesForContact(jid, {
          limit: requestedLimit,
          markAsLoaded,
          force,
          deep
        });

        if (markAsWarmed && loadedCount > 0) {
          this.warmedConversationContextLimitByJid.set(
            jid,
            Math.max(this.warmedConversationContextLimitByJid.get(jid) || 0, requestedLimit)
          );
        }

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

  private buildBootstrapConversationQueues(): { priorityRequests: ConversationContextRequest[]; remainingRequests: ConversationContextRequest[] } {
    const contacts = this.contactsSubject.value;
    const conversationCandidates = contacts
      .filter(contact => contact.jid && this.isRealConversationForBootstrap(contact))
      .map(contact => ({
        jid: contact.jid,
        ts: this.resolveBootstrapSortTimestampMs(contact),
        unreadCount: this.resolveUnreadCount(contact),
        limit: this.resolveConversationContextLimitForContact(contact)
      }))
      .sort((a, b) => {
        const aHasUnread = a.unreadCount > 0 ? 1 : 0;
        const bHasUnread = b.unreadCount > 0 ? 1 : 0;
        if (aHasUnread !== bHasUnread) {
          return bHasUnread - aHasUnread;
        }

        if (a.unreadCount !== b.unreadCount) {
          return b.unreadCount - a.unreadCount;
        }

        if (a.ts !== b.ts) {
          return b.ts - a.ts;
        }
        return a.jid.localeCompare(b.jid, 'pt-BR');
      })
      .map(item => ({ jid: item.jid, limit: item.limit }));

    if (!conversationCandidates.length) {
      return { priorityRequests: [], remainingRequests: [] };
    }

    const priorityRequests = conversationCandidates.slice(0, INITIAL_PRIORITY_CONVERSATIONS);
    const remainingRequests = conversationCandidates.slice(
      priorityRequests.length,
      priorityRequests.length + BACKGROUND_PRIORITY_CONVERSATIONS
    );

    return {
      priorityRequests,
      remainingRequests
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
    const { priorityRequests, remainingRequests } = this.buildBootstrapConversationQueues();
    const priorityTotal = priorityRequests.length;
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
      contactRequests: priorityRequests,
      concurrency: CONVERSATION_CONTEXT_CONCURRENCY,
      force: true,
      ensureContacts: false,
      limit: CONVERSATION_CONTEXT_MESSAGES_PER_CHAT,
      deep: false,
      markAsLoaded: false,
      markAsWarmed: true,
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

      if (runId !== this.conversationContextRunId || !remainingRequests.length) {
        return;
      }

      await this.loadConversationContextForContacts({
        contactRequests: remainingRequests,
        concurrency: CONVERSATION_CONTEXT_CONCURRENCY,
        force: true,
        ensureContacts: false,
        limit: CONVERSATION_CONTEXT_MESSAGES_PER_CHAT,
        deep: false,
        markAsLoaded: false,
        markAsWarmed: true,
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
    const resolvedJid = this.resolveConversationJid(jid);
    return new Observable(observer => {
      this.gateway.sendMessage(instance, resolvedJid, text).subscribe({
        next: result => {
          const serverId = (result as Record<string, unknown>)?.['id'] as string;
          this.appendOutgoingMessage(resolvedJid, text, 'send-api', serverId);
          this.setLoading({ sending: false });
          this.notifyMessageSent(resolvedJid);
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
    const resolvedJid = this.resolveConversationJid(jid);
    return new Observable(observer => {
      this.gateway.sendMedia(instance, resolvedJid, file, caption).subscribe({
        next: result => {
          const serverId = (result as Record<string, unknown>)?.['id'] as string;
          this.appendOutgoingMessage(resolvedJid, caption, 'send-media-api', serverId, {
            hasMedia: true,
            mediaFilename: file.name,
            mediaMimetype: file.type || 'application/octet-stream'
          });
          this.setLoading({ sending: false });
          this.notifyMessageSent(resolvedJid);
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
    const contactJid = this.resolveConversationJid(jid);

    // If we have a server ID, check if the WS broadcast already delivered it
    if (serverId && this.messagesSubject.value.some(m => m.id === serverId)) {
      return;
    }

    const message: WhatsappMessage = {
      id: serverId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      contactJid,
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
    const jid = this.selectedContactJid;
    this.setDraftTextForJid(jid, text);
  }

  setDraftTextForJid(jid: string, text: string): void {
    if (!jid) {
      return;
    }

    const current = this.draftTextByJidSubject.value;
    const nextText = text || '';

    if (!nextText.trim()) {
      if (!(jid in current)) {
        return;
      }

      const { [jid]: _discarded, ...rest } = current;
      this.draftTextByJidSubject.next(rest);
      return;
    }

    if (current[jid] === nextText) {
      return;
    }

    this.draftTextByJidSubject.next({
      ...current,
      [jid]: nextText
    });
  }

  clearDraftTextsForJids(jids: string[]): void {
    const next = this.removeDraftEntries(this.draftTextByJidSubject.value, jids);

    if (next !== this.draftTextByJidSubject.value) {
      this.draftTextByJidSubject.next(next);
    }
  }

  setDraftImageDataUrl(dataUrl: string | null): void {
    const jid = this.selectedContactJid;
    this.setDraftImageDataUrlForJid(jid, dataUrl);
  }

  setDraftImageDataUrlForJid(jid: string, dataUrl: string | null): void {
    if (!jid) {
      return;
    }

    const current = this.draftImageDataUrlByJidSubject.value;

    if (!dataUrl) {
      if (!(jid in current)) {
        return;
      }

      const { [jid]: _discarded, ...rest } = current;
      this.draftImageDataUrlByJidSubject.next(rest);
      return;
    }

    if (current[jid] === dataUrl) {
      return;
    }

    this.draftImageDataUrlByJidSubject.next({
      ...current,
      [jid]: dataUrl
    });
  }

  clearDraftImageDataUrlsForJids(jids: string[]): void {
    const next = this.removeDraftEntries(this.draftImageDataUrlByJidSubject.value, jids);

    if (next !== this.draftImageDataUrlByJidSubject.value) {
      this.draftImageDataUrlByJidSubject.next(next);
    }
  }

  private removeDraftEntries<T>(current: Record<string, T>, jids: string[]): Record<string, T> {
    if (!jids.length) {
      return current;
    }

    let next: Record<string, T> | null = null;

    for (const jid of new Set(jids.filter(Boolean))) {
      const source = next ?? current;
      if (!(jid in source)) {
        continue;
      }

      if (!next) {
        next = { ...current };
      }

      delete next[jid];
    }

    return next ?? current;
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

  requestConversationContext(jid: string): void {
    const resolvedJid = this.resolveConversationJid(jid);
    if (
      !resolvedJid
      || !this.selectedInstance
      || this.pendingConversationContextJids.has(resolvedJid)
      || this.contactHistoryInFlight.has(resolvedJid)
      || this.loadedHistoryJids.has(resolvedJid)
    ) {
      return;
    }

    const targetLimit = this.resolveConversationContextLimit(resolvedJid);
    const existingServerMessages = this.messagesSubject.value.filter(
      message => message.contactJid === resolvedJid && !message.id.startsWith('local-')
    );
    const warmedLimit = this.warmedConversationContextLimitByJid.get(resolvedJid) || 0;

    if (existingServerMessages.length >= targetLimit || warmedLimit >= targetLimit) {
      return;
    }

    this.pendingConversationContextJids.add(resolvedJid);
    this.scheduleConversationContextBatch();
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

  private scheduleConversationContextBatch(): void {
    if (this.conversationContextRequestTimer !== null) {
      return;
    }

    this.conversationContextRequestTimer = window.setTimeout(() => {
      this.conversationContextRequestTimer = null;
      this.processConversationContextBatch();
    }, CONVERSATION_CONTEXT_BATCH_DELAY_MS);
  }

  private processConversationContextBatch(): void {
    const batch = Array.from(this.pendingConversationContextJids).slice(0, CONVERSATION_CONTEXT_CONCURRENCY);
    batch.forEach(jid => this.pendingConversationContextJids.delete(jid));

    if (!batch.length) {
      return;
    }

    void this.loadConversationContextForContacts({
      contactJids: batch,
      concurrency: CONVERSATION_CONTEXT_CONCURRENCY,
      force: true,
      ensureContacts: false,
      limit: CONVERSATION_CONTEXT_MESSAGES_PER_CHAT,
      deep: false,
      markAsLoaded: false,
      markAsWarmed: true
    }).finally(() => {
      if (this.pendingConversationContextJids.size > 0) {
        this.scheduleConversationContextBatch();
      }
    });
  }

  private clearConversationContextBatchTimer(): void {
    if (this.conversationContextRequestTimer !== null) {
      window.clearTimeout(this.conversationContextRequestTimer);
      this.conversationContextRequestTimer = null;
    }
  }

  private resolveConversationContextLimit(jid: string, baseLimit = CONVERSATION_CONTEXT_MESSAGES_PER_CHAT): number {
    return this.resolveConversationContextLimitForContact(this.getContact(jid), baseLimit);
  }

  private resolveConversationContextLimitForContact(
    contact: WhatsappContact | null | undefined,
    baseLimit = CONVERSATION_CONTEXT_MESSAGES_PER_CHAT
  ): number {
    const normalizedBaseLimit = Math.max(1, Math.min(CHAT_HISTORY_LIMIT, Number(baseLimit || CONVERSATION_CONTEXT_MESSAGES_PER_CHAT)));
    const unreadCount = this.resolveUnreadCount(contact);

    return Math.max(normalizedBaseLimit, Math.min(CHAT_HISTORY_LIMIT, unreadCount));
  }

  private resolveUnreadCount(contact: WhatsappContact | null | undefined): number {
    const unreadCount = Number(contact?.unreadCount || 0);
    if (!Number.isFinite(unreadCount) || unreadCount <= 0) {
      return 0;
    }

    return Math.round(unreadCount);
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
    this.setContacts(contacts);
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
            }));
          const collapsed = this.collapseEquivalentContacts(enriched)
            .sort((a, b) => {
              const aTs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
              const bTs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
              if (aTs !== bTs) {
                return bTs - aTs;
              }
              return (a.name || '').localeCompare(b.name || '', 'pt-BR');
            });
          this.setContacts(collapsed);
          if (this.messagesSubject.value.length > 0) {
            this.resortContactsByLatestMessage(this.messagesSubject.value);
          }

          const currentSelection = this.selectedContactJid;
          const preservedSelection = currentSelection
            ? (this.findEquivalentContact(currentSelection, collapsed)?.jid || '')
            : '';
          const bootstrapPrioritySelection = bootstrap
            ? (this.buildBootstrapConversationQueues().priorityRequests[0]?.jid || '')
            : '';
          const fallbackSelection = bootstrapPrioritySelection || collapsed[0]?.jid || '';
          const selectedJid = preservedSelection || fallbackSelection;

          if (selectedJid && selectedJid !== currentSelection) {
            this.selectedContactJidSubject.next(selectedJid);
            if (!bootstrap) {
              this.markContactAsRead(selectedJid);
            }
          }

          this.setLoading({ contacts: false });

          if (bootstrap) {
            if (collapsed.length === 0 && this.bootstrapRetryCount < BOOTSTRAP_CONTACTS_MAX_RETRIES) {
              this.bootstrapRetryCount++;
              const retryRunId = this.conversationContextRunId;
              window.setTimeout(() => {
                if (this.conversationContextRunId === retryRunId) {
                  void this.loadContacts({ bootstrap: true });
                }
              }, BOOTSTRAP_CONTACTS_RETRY_DELAY_MS);
              resolve();
              return;
            }

            this.bootstrapRetryCount = 0;
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
            && (!currentSelection || selectedJid === currentSelection || selectedJid === preservedSelection)
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
    const resolvedJid = this.resolveConversationJid(jid);
    const limit = Math.max(1, Math.min(CHAT_HISTORY_LIMIT, Number(options.limit || CHAT_HISTORY_LIMIT)));
    const markAsLoaded = options.markAsLoaded ?? true;
    const force = options.force ?? false;
    const deep = options.deep ?? markAsLoaded;

    if (!resolvedJid || !this.selectedInstance || this.contactHistoryInFlight.has(resolvedJid)) {
      return Promise.resolve(0);
    }

    if (markAsLoaded && !force && this.loadedHistoryJids.has(resolvedJid)) {
      return Promise.resolve(0);
    }

    this.contactHistoryInFlight.add(resolvedJid);

    return new Promise(resolve => {
      this.gateway.loadChatMessages(this.selectedInstance, resolvedJid, limit, deep).subscribe({
        next: events => {
          const history = this.mapEventsToMessages(events).filter(message => message.contactJid === resolvedJid);

          if (markAsLoaded) {
            if (history.length > 1) {
              this.loadedHistoryJids.add(resolvedJid);
            } else {
              this.loadedHistoryJids.delete(resolvedJid);
            }
          }

          this.applyHistoryForContact(resolvedJid, history);

          this.contactHistoryInFlight.delete(resolvedJid);

          resolve(history.length);
        },
        error: () => {
          this.contactHistoryInFlight.delete(resolvedJid);

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
    if (this.findEquivalentContact(jid, current)) {
      return;
    }

    const phone = this.resolveSyntheticPhoneFromEvent(event);
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

    this.setContacts([synthesized, ...current]);
    this.requestPhoto(jid);
  }

  private resolveSyntheticPhoneFromEvent(event: WhatsappEvent): string {
    const jid = typeof event.chatJid === 'string' ? event.chatJid.trim() : '';
    const eventPhone = typeof event.phone === 'string' ? event.phone.trim() : '';
    const jidDigits = this.resolveSyntheticPhoneFromJid(jid);
    const eventPhoneDigits = eventPhone.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') || '';

    if (jid.endsWith('@c.us')) {
      return jidDigits || eventPhoneDigits;
    }

    if (jid.endsWith('@lid')) {
      // Never show internal linked-id as if it were a real phone number.
      return '';
    }

    return eventPhoneDigits || jidDigits;
  }

  private buildSyntheticSelectedContact(jid: string): WhatsappContact | null {
    if (!jid.endsWith('@c.us')) {
      return null;
    }

    const phone = this.resolveSyntheticPhoneFromJid(jid);

    return {
      jid,
      phone,
      name: phone || jid,
      found: false,
      photoUrl: null,
      lastMessageAt: null,
      lastMessagePreview: '',
      lastMessageFromMe: false,
      lastMessageAck: null,
      lastMessageType: '',
      lastMessageHasMedia: false,
      lastMessageMediaMimetype: '',
      unreadCount: 0,
      labels: [],
      isGroup: false,
      fromGetChats: false,
      getChatsTimestampMs: 0
    };
  }

  private resolveSyntheticPhoneFromJid(jid: string): string {
    return jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') || '';
  }

  private collapseEquivalentContacts(contacts: WhatsappContact[]): WhatsappContact[] {
    const collapsed: WhatsappContact[] = [];

    for (const contact of contacts) {
      const reference = contact.jid || contact.phone;
      const existing = this.findEquivalentContact(reference, collapsed);
      if (!existing) {
        collapsed.push(contact);
        continue;
      }

      const merged = this.mergeEquivalentContacts(existing, contact);
      const existingIndex = collapsed.indexOf(existing);
      if (existingIndex >= 0) {
        collapsed.splice(existingIndex, 1, merged);
      }
    }

    return collapsed;
  }

  private mergeEquivalentContacts(left: WhatsappContact, right: WhatsappContact): WhatsappContact {
    const preferred = this.pickPreferredEquivalentContact(left, right);
    const duplicate = preferred === left ? right : left;
    const preferredTs = this.parseContactTimestampMs(preferred.lastMessageAt);
    const duplicateTs = this.parseContactTimestampMs(duplicate.lastMessageAt);
    const newest = duplicateTs > preferredTs ? duplicate : preferred;

    return {
      ...duplicate,
      ...preferred,
      phone: preferred.phone || duplicate.phone,
      name: preferred.name || duplicate.name,
      found: preferred.found || duplicate.found,
      photoUrl: preferred.photoUrl ?? duplicate.photoUrl ?? null,
      lastMessageAt: newest.lastMessageAt ?? preferred.lastMessageAt ?? duplicate.lastMessageAt ?? null,
      lastMessagePreview: newest.lastMessagePreview || preferred.lastMessagePreview || duplicate.lastMessagePreview || '',
      lastMessageFromMe: newest.lastMessageFromMe ?? preferred.lastMessageFromMe ?? duplicate.lastMessageFromMe ?? false,
      lastMessageAck: newest.lastMessageAck ?? preferred.lastMessageAck ?? duplicate.lastMessageAck ?? null,
      lastMessageType: newest.lastMessageType || preferred.lastMessageType || duplicate.lastMessageType || '',
      lastMessageHasMedia: newest.lastMessageHasMedia ?? preferred.lastMessageHasMedia ?? duplicate.lastMessageHasMedia ?? false,
      lastMessageMediaMimetype: newest.lastMessageMediaMimetype || preferred.lastMessageMediaMimetype || duplicate.lastMessageMediaMimetype || '',
      unreadCount: Math.max(preferred.unreadCount || 0, duplicate.unreadCount || 0),
      labels: Array.from(new Set([...(preferred.labels || []), ...(duplicate.labels || [])])),
      isGroup: preferred.isGroup || duplicate.isGroup || false,
      fromGetChats: preferred.fromGetChats || duplicate.fromGetChats || false,
      getChatsTimestampMs: Math.max(preferred.getChatsTimestampMs || 0, duplicate.getChatsTimestampMs || 0)
    };
  }

  private pickPreferredEquivalentContact(left: WhatsappContact, right: WhatsappContact): WhatsappContact {
    const references = Array.from(new Set([
      left.jid,
      left.phone,
      right.jid,
      right.phone
    ].filter(Boolean)));
    const leftScore = Math.max(...references.map(reference => this.scoreEquivalentContact(reference, left)));
    const rightScore = Math.max(...references.map(reference => this.scoreEquivalentContact(reference, right)));

    if (leftScore !== rightScore) {
      return leftScore > rightScore ? left : right;
    }

    const leftTs = this.parseContactTimestampMs(left.lastMessageAt);
    const rightTs = this.parseContactTimestampMs(right.lastMessageAt);
    if (leftTs !== rightTs) {
      return leftTs > rightTs ? left : right;
    }

    return (left.name || '').length >= (right.name || '').length ? left : right;
  }

  private parseContactTimestampMs(value: string | null | undefined): number {
    if (!value) {
      return 0;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private setContacts(contacts: WhatsappContact[]): void {
    this.contactIndexDirty = true;
    this.contactsSubject.next(contacts);
  }

  private ensureContactIndex(): void {
    if (!this.contactIndexDirty) {
      return;
    }

    this.contactIndexByKey.clear();
    for (const contact of this.contactsSubject.value) {
      const indexKeys = new Set<string>();
      for (const source of [contact.jid, contact.phone]) {
        if (source) {
          for (const key of this.buildConversationKeys(source)) {
            indexKeys.add(key);
          }
        }
      }
      for (const key of indexKeys) {
        const bucket = this.contactIndexByKey.get(key);
        if (bucket) {
          bucket.push(contact);
        } else {
          this.contactIndexByKey.set(key, [contact]);
        }
      }
    }

    this.contactIndexDirty = false;
  }

  private findEquivalentContactInIndex(reference: string): WhatsappContact | null {
    this.ensureContactIndex();

    const referenceKeys = this.buildConversationKeys(reference);
    if (!referenceKeys.size) {
      return null;
    }

    const candidateSet = new Set<WhatsappContact>();
    for (const key of referenceKeys) {
      const bucket = this.contactIndexByKey.get(key);
      if (bucket) {
        for (const contact of bucket) {
          candidateSet.add(contact);
        }
      }
    }

    if (!candidateSet.size) {
      return null;
    }

    const candidates = Array.from(candidateSet);
    if (candidates.length === 1) {
      return candidates[0];
    }

    return candidates.sort((a, b) =>
      this.scoreEquivalentContact(reference, b) - this.scoreEquivalentContact(reference, a)
    )[0] || null;
  }

  private findEquivalentContact(reference: string, contacts?: WhatsappContact[]): WhatsappContact | null {
    if (!reference) {
      return null;
    }

    if (!contacts) {
      return this.findEquivalentContactInIndex(reference);
    }

    const matches = contacts.filter(contact =>
      contact.jid === reference
      || this.isSameConversationTarget(reference, contact.jid)
      || this.isSameConversationTarget(reference, contact.phone)
    );

    if (!matches.length) {
      return null;
    }

    return [...matches].sort((a, b) => this.scoreEquivalentContact(reference, b) - this.scoreEquivalentContact(reference, a))[0] || null;
  }

  private scoreEquivalentContact(reference: string, contact: WhatsappContact): number {
    const jid = typeof contact.jid === 'string' ? contact.jid.trim() : '';
    const phone = typeof contact.phone === 'string' ? contact.phone.trim() : '';
    const jidDigits = extractDigits(jid);
    const phoneDigits = extractDigits(phone);
    const identityDigits = phoneDigits || jidDigits;

    let score = 0;

    if (jid.endsWith('@c.us')) {
      score += CONTACT_SCORE_CANONICAL_JID;
    } else if (jid.endsWith('@lid')) {
      score += CONTACT_SCORE_LINKED_ID;
    }

    if (contact.found) {
      score += CONTACT_SCORE_FOUND;
    }

    if (contact.fromGetChats) {
      score += CONTACT_SCORE_FROM_GET_CHATS;
    }

    if (this.isSameConversationTarget(reference, phone)) {
      score += CONTACT_SCORE_PHONE_MATCH;
    }

    if (jid === reference) {
      score += CONTACT_SCORE_JID_EXACT;
    }

    score += this.scoreConversationIdentity(identityDigits);

    if (this.isSyntheticCanonicalAlias(jid, identityDigits)) {
      score += CONTACT_SCORE_SYNTHETIC_ALIAS_PENALTY;
    }

    return score;
  }

  private scoreConversationIdentity(digits: string): number {
    if (!digits) {
      return 0;
    }

    let score = Math.min(digits.length, 20);

    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
      score += CONTACT_SCORE_BR_PHONE_BONUS;
      if (digits.length === 13) {
        score += CONTACT_SCORE_BR_PHONE_9TH_DIGIT_BONUS;
      }
      return score;
    }

    if (digits.length >= 10 && digits.length <= 13) {
      score += CONTACT_SCORE_VALID_PHONE_BONUS;
      return score;
    }

    if (digits.length >= 10 && digits.length <= 15) {
      score += CONTACT_SCORE_EXTENDED_PHONE_BONUS;
    }

    return score;
  }

  private isSyntheticCanonicalAlias(jid: string, digits: string): boolean {
    return jid.endsWith('@c.us') && digits.length > 13 && !digits.startsWith('55');
  }

  private isSameConversationTarget(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) {
      return false;
    }

    if (a === b) {
      return true;
    }

    const keysA = this.buildConversationKeys(a);
    const keysB = this.buildConversationKeys(b);

    for (const key of keysA) {
      if (keysB.has(key)) {
        return true;
      }
    }

    return false;
  }

  private buildConversationKeys(raw: string): Set<string> {
    const digits = extractDigits(raw);
    const keys = new Set<string>();

    if (!digits) {
      return keys;
    }

    keys.add(`exact:${digits}`);

    if (digits.startsWith('55') && digits.length > 11) {
      keys.add(`exact:${digits.slice(2)}`);
    }

    this.addBrazilianConversationKeys(digits, keys);

    return keys;
  }

  private addBrazilianConversationKeys(digits: string, keys: Set<string>): void {
    const localDigits = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
    if (localDigits.length !== 10 && localDigits.length !== 11) {
      return;
    }

    const ddd = localDigits.slice(0, 2);
    const local = localDigits.slice(2);
    const withoutNinth = local.length === 9 && local.startsWith('9') ? local.slice(1) : local;
    if (withoutNinth.length !== 8) {
      return;
    }

    const withNinth = `${ddd}9${withoutNinth}`;
    const withoutNinthFull = `${ddd}${withoutNinth}`;

    keys.add(`br:${ddd}:${withoutNinth}`);
    keys.add(`exact:${withNinth}`);
    keys.add(`exact:${withoutNinthFull}`);
    keys.add(`exact:55${withNinth}`);
    keys.add(`exact:55${withoutNinthFull}`);
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
      this.setContacts(updated);
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
      this.setContacts(sorted);
    }
  }

  private mapEventsToMessages(events: WhatsappEvent[]): WhatsappMessage[] {
    return events
      .filter(event => Boolean(event.chatJid))
      .map(event => {
        const contactJid = this.resolveConversationJid(event.chatJid);
        const payload = this.normalizeEventPayload(event.payload, event.text);

        return {
          id: event.id,
          contactJid,
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

    return this.resolveNonTextPreviewLabel(message.payload) || fallback;
  }

  private resolveNonTextPreviewLabel(payload?: Record<string, unknown>): string {
    const mediaMimetype = typeof payload?.['mediaMimetype'] === 'string' ? payload['mediaMimetype'] : '';
    const mediaType = typeof payload?.['type'] === 'string'
      ? payload['type'].trim().toLowerCase()
      : '';

    if (this.isMediaPayload(payload)) {
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

    if (mediaType === 'sticker') {
      return 'Figurinha';
    }

    switch (mediaType) {
      case 'revoked':
        return 'Mensagem apagada';
      case 'location':
        return 'Localização';
      case 'vcard':
      case 'multi_vcard':
      case 'contact_card':
        return 'Contato';
      case 'reaction':
        return 'Reação';
      case 'poll_creation':
        return 'Enquete';
      case 'event_creation':
        return 'Evento';
      case 'order':
        return 'Pedido';
      case 'payment':
        return 'Pagamento';
      default:
        return mediaType ? 'Mensagem' : '';
    }
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
