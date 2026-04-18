import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { WhatsappContact, WhatsappEvent, WhatsappInstance } from '../models/whatsapp.model';

interface InstancesResponse {
  instances: WhatsappInstance[];
}

interface ContactsResponse {
  instanceName: string;
  contacts: WhatsappContact[];
}

interface EventsResponse {
  instanceName: string;
  events: WhatsappEvent[];
}

interface SendResponse {
  instanceName: string;
  result: unknown;
}

interface PhotoResponse {
  jid: string;
  photoUrl: string | null;
}

interface SeenResponse {
  jid: string;
  ok: boolean;
}

export interface WhatsappSessionStatus {
  instanceName: string;
  status: string;
  hasQr: boolean;
  qr: string | null;
  lastError: string;
}

@Injectable({
  providedIn: 'root'
})
export class WhatsappWebjsGatewayService {
  private readonly baseUrl = 'http://localhost:3344/api/whatsapp';

  constructor(private http: HttpClient) {}

  loadSessionStatus(): Observable<WhatsappSessionStatus> {
    return this.http.get<WhatsappSessionStatus>(`${this.baseUrl}/session`);
  }

  connectSession(): Observable<WhatsappSessionStatus> {
    return this.http.post<WhatsappSessionStatus>(`${this.baseUrl}/session/connect`, {});
  }

  disconnectSession(): Observable<WhatsappSessionStatus> {
    return this.http.post<WhatsappSessionStatus>(`${this.baseUrl}/session/disconnect`, {});
  }

  loadInstances(): Observable<WhatsappInstance[]> {
    return this.http.get<InstancesResponse>(`${this.baseUrl}/instances`).pipe(
      map(response => response.instances)
    );
  }

  loadContacts(instanceName: string, options: { waitForRefresh?: boolean } = {}): Observable<WhatsappContact[]> {
    let params = new HttpParams().set('instanceName', instanceName);
    if (options.waitForRefresh) {
      params = params.set('waitForRefresh', '1');
    }

    return this.http.get<ContactsResponse>(`${this.baseUrl}/contacts`, { params }).pipe(
      map(response => response.contacts)
    );
  }

  loadContactPhoto(jid: string): Observable<string | null> {
    const encoded = encodeURIComponent(jid);
    return this.http.get<PhotoResponse>(`${this.baseUrl}/contacts/${encoded}/photo`).pipe(
      map(response => response.photoUrl)
    );
  }

  loadEvents(instanceName: string): Observable<WhatsappEvent[]> {
    const params = new HttpParams()
      .set('instanceName', instanceName)
      .set('limit', '120');

    return this.http.get<EventsResponse>(`${this.baseUrl}/events`, { params }).pipe(
      map(response => response.events)
    );
  }

  loadChatMessages(instanceName: string, jid: string, limit = 160, deep = false): Observable<WhatsappEvent[]> {
    let params = new HttpParams()
      .set('instanceName', instanceName)
      .set('limit', String(limit));

    if (deep) {
      params = params.set('deep', '1');
    }

    const encoded = encodeURIComponent(jid);
    return this.http.get<EventsResponse>(`${this.baseUrl}/chats/${encoded}/messages`, { params }).pipe(
      map(response => response.events)
    );
  }

  sendMessage(instanceName: string, to: string, text: string): Observable<unknown> {
    return this.http.post<SendResponse>(`${this.baseUrl}/messages`, {
      instanceName,
      to,
      text
    }).pipe(map(response => response.result));
  }

  markChatSeen(jid: string): Observable<void> {
    const encoded = encodeURIComponent(jid);
    return this.http.post<SeenResponse>(`${this.baseUrl}/chats/${encoded}/seen`, {}).pipe(
      map(() => undefined)
    );
  }

  sendMedia(instanceName: string, to: string, file: File, caption = ''): Observable<unknown> {
    const form = new FormData();
    form.append('instanceName', instanceName);
    form.append('to', to);
    if (caption) {
      form.append('caption', caption);
    }
    form.append('file', file, file.name);

    return this.http.post<SendResponse>(`${this.baseUrl}/messages/media`, form).pipe(
      map(response => response.result)
    );
  }
}
