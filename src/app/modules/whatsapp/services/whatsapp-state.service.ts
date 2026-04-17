import { Injectable, OnDestroy } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, combineLatest, debounceTime, distinctUntilChanged, map } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { WhatsappContact, WhatsappEvent, WhatsappInstance, WhatsappMessage } from '../../../models/whatsapp.model';
import { WhatsappWebjsGatewayService } from '../../../services/whatsapp-webjs-gateway.service';
import { WhatsappWsService } from '../../../services/whatsapp-ws.service';

const INITIAL_LOAD_DELAY_MS = 4000;
const LOCAL_MESSAGE_TTL_MS = 30000;
const PHOTO_BATCH_SIZE = 6;
const PHOTO_NULL_RETRY_MS = 30 * 60 * 1000;
const CHAT_HISTORY_LIMIT = 180;
const MAX_MESSAGES_PER_CHAT = 260;
const PRELOAD_HISTORY_CONCURRENCY = 4;
const PRELOAD_HISTORY_LIMIT = 60;
const PRELOAD_REQUEST_DELAY_MS = 50;
const SPARSE_HISTORY_RETRY_MS = 250;
const SPARSE_HISTORY_MAX_RETRIES = 2;

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
  private readonly syncingSubject = new BehaviorSubject<boolean>(false);
  private readonly contactHistoryInFlight = new Set<string>();
  private readonly loadedHistoryJids = new Set<string>();
  private readonly preloadedHistoryJids = new Set<string>();
  private preloadToken = 0;
  private isPreloading = false;
  private readonly destroy$ = new Subject<void>();
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
  // Só emite `true` se a sincronização demorar > 600ms (evita piscar em cada poll rápido)
  syncing$: Observable<boolean> = this.syncingSubject.pipe(
    debounceTime(600),
    distinctUntilChanged()
  );

  /** Emite só quando as mensagens do contato selecionado realmente mudam. */
  selectedMessages$: Observable<WhatsappMessage[]> = combineLatest([
    this.selectedContactJidSubject,
    this.messagesSubject
  ]).pipe(
    map(([jid]) => this.getMessagesFor(jid)),
    distinctUntilChanged((prev, curr) =>
      prev.length === curr.length && prev.every((m, i) => m.id === curr[i].id && m.ack === curr[i].ack)
    )
  );

  /** Emite o contato selecionado só quando o JID ou a lista de contatos muda. */
  selectedContact$: Observable<WhatsappContact | null> = combineLatest([
    this.selectedContactJidSubject,
    this.contactsSubject
  ]).pipe(
    map(([jid, contacts]) => contacts.find(c => c.jid === jid) || null),
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
  }

  private setupWebSocket(): void {
    this.ws.connect();

    // Real-time new messages
    this.ws.on<WhatsappEvent>('new_message').pipe(takeUntil(this.destroy$)).subscribe(event => {
      if (!event || !event.chatJid) {
        return;
      }
      const messages = this.mapEventsToMessages([event]);
      const merged = this.mergeServerMessages(messages);
      const withLocal = this.mergeWithLocal(merged);
      const pruned = this.pruneMessages(withLocal);
      this.messagesSubject.next(pruned);
      this.resortContactsByLatestMessage(pruned);

      // Increment unread for inbound messages not in the active chat
      if (this.initialSyncDone) {
        const inbound = messages.filter(m => !m.isFromMe);
        if (inbound.length > 0) {
          this.incrementUnreadCounts(inbound);
        }
      }
    });

    // Real-time ack updates (check marks)
    this.ws.on<{ messageId: string; ack: number }>('message_ack').pipe(takeUntil(this.destroy$)).subscribe(({ messageId, ack }) => {
      if (!messageId) {
        return;
      }
      const current = this.messagesSubject.value;
      let changed = false;
      const updated = current.map(msg => {
        if (msg.id === messageId && msg.ack !== ack) {
          changed = true;
          return { ...msg, ack };
        }
        return msg;
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
    this.preloadToken += 1;
    this.loadedHistoryJids.clear();
    this.preloadedHistoryJids.clear();
    this.initialSyncDone = false;
    this.syncingSubject.next(true);
    this.selectedInstanceSubject.next(name);
    this.selectedContactJidSubject.next('');
    this.messagesSubject.next([]);
    this.setLoading({ contacts: true, messages: false });

    window.setTimeout(() => {
      this.loadContacts();
      this.refreshEvents(true, false);
    }, INITIAL_LOAD_DELAY_MS);
  }

  selectContact(jid: string): void {
    this.selectedContactJidSubject.next(jid);
    this.markContactAsRead(jid);
    if (this.shouldForceHistoryLoad(jid)) {
      void this.loadMessagesForContact(jid, {
        retryOnSparse: true,
        limit: CHAT_HISTORY_LIMIT,
        markAsLoaded: true
      });
    }
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
    this.loadContacts();
    this.refreshEvents();
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

  private loadContacts(): void {
    if (!this.selectedInstance) {
      return;
    }

    this.setLoading({ contacts: true });

    this.gateway.loadContacts(this.selectedInstance).subscribe({
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
        this.setLoading({ contacts: false });

        const currentSelection = this.selectedContactJid;
        if (!currentSelection && enriched.length) {
          this.selectContact(enriched[0].jid);
        } else if (
          currentSelection
          && enriched.some(contact => contact.jid === currentSelection)
          && this.shouldForceHistoryLoad(currentSelection)
        ) {
          void this.loadMessagesForContact(currentSelection, {
            retryOnSparse: true,
            limit: CHAT_HISTORY_LIMIT,
            markAsLoaded: true
          });
        }

        void this.preloadHistories(enriched);
      },
      error: () => {
        this.setError('Não foi possível carregar os contatos.');
        this.setLoading({ contacts: false });
        this.onInitialSyncComplete();
      }
    });
  }

  private refreshEvents(silentError = false, showLoading = true): void {
    if (!this.selectedInstance || this.eventsInFlight) {
      return;
    }

    this.eventsInFlight = true;
    if (showLoading) {
      this.setLoading({ messages: true });
    }

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
      },
      error: () => {
        if (!silentError) {
          this.setError('Falha ao buscar eventos da conversa.');
        }
        this.eventsInFlight = false;
        if (showLoading) {
          this.setLoading({ messages: false });
        }
      }
    });
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
      retryOnSparse?: boolean;
      sparseAttempt?: number;
      limit?: number;
      markAsLoaded?: boolean;
      deep?: boolean;
    } = {}
  ): Promise<void> {
    const retryOnSparse = options.retryOnSparse ?? false;
    const sparseAttempt = options.sparseAttempt ?? 0;
    const limit = Math.max(1, Math.min(CHAT_HISTORY_LIMIT, Number(options.limit || CHAT_HISTORY_LIMIT)));
    const markAsLoaded = options.markAsLoaded ?? true;
    const deep = options.deep ?? markAsLoaded;

    if (!jid || !this.selectedInstance || this.contactHistoryInFlight.has(jid)) {
      return Promise.resolve();
    }

    this.contactHistoryInFlight.add(jid);

    return new Promise(resolve => {
      this.gateway.loadChatMessages(this.selectedInstance, jid, limit, deep).subscribe({
        next: events => {
          const history = this.mapEventsToMessages(events).filter(message => message.contactJid === jid);
          this.applyHistoryForContact(jid, history);

          if (markAsLoaded && history.length > 1) {
            this.loadedHistoryJids.add(jid);
          } else if (markAsLoaded && history.length <= 1) {
            this.loadedHistoryJids.delete(jid);
          }

          this.contactHistoryInFlight.delete(jid);

          if (retryOnSparse && history.length <= 1 && sparseAttempt < SPARSE_HISTORY_MAX_RETRIES) {
            window.setTimeout(() => {
              void this.loadMessagesForContact(jid, {
                retryOnSparse: true,
                sparseAttempt: sparseAttempt + 1,
                limit,
                markAsLoaded,
                deep
              }).finally(resolve);
            }, SPARSE_HISTORY_RETRY_MS);
            return;
          }

          if (!markAsLoaded && this.selectedContactJid === jid && !this.loadedHistoryJids.has(jid)) {
            window.setTimeout(() => {
              void this.loadMessagesForContact(jid, {
                retryOnSparse: true,
                limit: CHAT_HISTORY_LIMIT,
                markAsLoaded: true,
                deep: true
              });
            }, 0);
          }

          resolve();
        },
        error: () => {
          this.contactHistoryInFlight.delete(jid);

          if (!markAsLoaded && this.selectedContactJid === jid && !this.loadedHistoryJids.has(jid)) {
            window.setTimeout(() => {
              void this.loadMessagesForContact(jid, {
                retryOnSparse: true,
                limit: CHAT_HISTORY_LIMIT,
                markAsLoaded: true,
                deep: true
              });
            }, 0);
          }

          resolve();
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

    // During preload, accumulate silently to avoid per-contact re-renders.
    // The single emission happens at the end of preloadHistories().
    if (!this.isPreloading) {
      this.messagesSubject.next(pruned);
      this.resortContactsByLatestMessage(pruned);
    } else {
      // Still store the merged state internally for next accumulation
      this.messagesSubject.next(pruned);
    }
  }

  private async preloadHistories(contacts: WhatsappContact[]): Promise<void> {
    if (!this.selectedInstance) {
      this.onInitialSyncComplete();
      return;
    }

    const token = ++this.preloadToken;
    const queue = contacts
      .filter(contact => this.isPreloadEligibleContact(contact))
      .map(contact => contact.jid)
      .filter(Boolean)
      .filter(jid => !this.loadedHistoryJids.has(jid) && !this.preloadedHistoryJids.has(jid));

    if (!queue.length) {
      this.onInitialSyncComplete();
      return;
    }

    this.isPreloading = true;

    const workerCount = Math.max(1, Math.min(PRELOAD_HISTORY_CONCURRENCY, queue.length));
    const worker = async () => {
      while (token === this.preloadToken && queue.length > 0) {
        const nextJid = queue.shift();
        if (!nextJid) {
          continue;
        }
        await this.loadMessagesForContact(nextJid, {
          retryOnSparse: false,
          limit: PRELOAD_HISTORY_LIMIT,
          markAsLoaded: false,
          deep: false
        });
        this.preloadedHistoryJids.add(nextJid);
        await this.delay(PRELOAD_REQUEST_DELAY_MS);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Single emission + sort after all preloads complete
    this.isPreloading = false;
    this.resortContactsByLatestMessage(this.messagesSubject.value);
    this.onInitialSyncComplete();
  }

  private onInitialSyncComplete(): void {
    if (this.initialSyncDone) {
      return;
    }
    this.initialSyncDone = true;
    this.syncingSubject.next(false);
  }

  private isPreloadEligibleContact(contact: WhatsappContact): boolean {
    if (!contact?.jid) {
      return false;
    }

    if (contact.isGroup) {
      return false;
    }

    return contact.jid.endsWith('@c.us') || contact.jid.endsWith('@lid');
  }

  private shouldForceHistoryLoad(jid: string): boolean {
    if (!this.loadedHistoryJids.has(jid)) {
      return true;
    }

    const serverMessagesForChat = this.messagesSubject.value.filter(
      message => message.contactJid === jid && !message.id.startsWith('local-')
    );

    return serverMessagesForChat.length <= 1;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      window.setTimeout(resolve, ms);
    });
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
    const latestByJid = new Map<string, { ts: number; msg: WhatsappMessage }>();
    for (const msg of messages) {
      if (!msg.contactJid) {
        continue;
      }
      const ts = Date.parse(msg.sentAt);
      if (!Number.isFinite(ts)) {
        continue;
      }
      const prev = latestByJid.get(msg.contactJid);
      if (!prev || ts > prev.ts) {
        latestByJid.set(msg.contactJid, { ts, msg });
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
      if (derived.ts >= existing) {
        const preview = derived.msg.text?.trim() || contact.lastMessagePreview || '';
        const lastMessageAck = derived.msg.isFromMe ? (derived.msg.ack ?? null) : null;
        const next = {
          ...contact,
          lastMessageAt: new Date(derived.ts).toISOString(),
          lastMessagePreview: preview,
          lastMessageFromMe: derived.msg.isFromMe,
          lastMessageAck
        };
        if (
          next.lastMessageAt !== contact.lastMessageAt ||
          next.lastMessagePreview !== contact.lastMessagePreview ||
          next.lastMessageFromMe !== contact.lastMessageFromMe ||
          next.lastMessageAck !== contact.lastMessageAck
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
      .map(event => ({
        id: event.id,
        contactJid: event.chatJid,
        text: event.text,
        sentAt: event.receivedAt,
        isFromMe: this.normalizeIsFromMe((event as unknown as { isFromMe?: unknown }).isFromMe, event.id),
        source: event.source,
        ack: typeof event.ack === 'number' ? event.ack : (
          typeof (event.payload as Record<string, unknown>)?.['ack'] === 'number'
            ? (event.payload as Record<string, unknown>)['ack'] as number
            : null
        ),
        payload: (event.payload && typeof event.payload === 'object')
          ? (event.payload as Record<string, unknown>)
          : undefined
      }));
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
