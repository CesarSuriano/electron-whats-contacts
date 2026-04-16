import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { WhatsappContact, WhatsappEvent, WhatsappInstance, WhatsappLabel } from '../models/whatsapp.model';

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

interface LabelsResponse {
  instanceName: string;
  labels: WhatsappLabel[];
}

interface LabelActionResponse {
  instanceName: string;
  jid: string;
  labelId: string;
}

@Injectable({
  providedIn: 'root'
})
export class WhatsappGatewayService {
  private readonly baseUrl = 'http://localhost:3333/api/whatsapp';

  constructor(private http: HttpClient) {}

  loadInstances(): Observable<WhatsappInstance[]> {
    return this.http.get<InstancesResponse>(`${this.baseUrl}/instances`).pipe(
      map(response => response.instances)
    );
  }

  loadContacts(instanceName: string): Observable<WhatsappContact[]> {
    const params = new HttpParams().set('instanceName', instanceName);
    return this.http.get<ContactsResponse>(`${this.baseUrl}/contacts`, { params }).pipe(
      map(response => response.contacts)
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

  sendMessage(instanceName: string, to: string, text: string): Observable<unknown> {
    return this.http.post<SendResponse>(`${this.baseUrl}/messages`, {
      instanceName,
      to,
      text
    }).pipe(map(response => response.result));
  }

  loadLabels(instanceName: string): Observable<WhatsappLabel[]> {
    const params = new HttpParams().set('instanceName', instanceName);
    return this.http.get<LabelsResponse>(`${this.baseUrl}/labels`, { params }).pipe(
      map(response => response.labels)
    );
  }

  createLabel(instanceName: string, name: string): Observable<WhatsappLabel[]> {
    return this.http.post<LabelsResponse>(`${this.baseUrl}/labels`, { instanceName, name }).pipe(
      map(response => response.labels)
    );
  }

  applyLabel(instanceName: string, jid: string, labelId: string): Observable<void> {
    return this.http.post<LabelActionResponse>(`${this.baseUrl}/labels/apply`, {
      instanceName,
      jid,
      labelId
    }).pipe(map(() => undefined));
  }

  removeLabel(instanceName: string, jid: string, labelId: string): Observable<void> {
    return this.http.post<LabelActionResponse>(`${this.baseUrl}/labels/remove`, {
      instanceName,
      jid,
      labelId
    }).pipe(map(() => undefined));
  }
}
