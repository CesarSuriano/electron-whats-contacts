import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { WhatsappWebjsGatewayService, WhatsappSessionStatus } from './whatsapp-webjs-gateway.service';
import { WhatsappContact, WhatsappEvent, WhatsappInstance } from '../models/whatsapp.model';

const BASE = 'http://localhost:3344/api/whatsapp';

const mockStatus: WhatsappSessionStatus = { instanceName: 'inst', status: 'ready', hasQr: false, qr: null, lastError: '' };
const mockInstance: WhatsappInstance = { name: 'inst', token: 't', connected: true, jid: 'jid', webhook: '' };
const mockContact: WhatsappContact = { jid: '5511@s.whatsapp.net', phone: '5511', name: 'Test', found: true };
const mockEvent: WhatsappEvent = { id: 'e1', source: 'src', receivedAt: '2024-01-01', isFromMe: false, chatJid: 'jid', phone: '11', text: 'hi', payload: {} };

describe('WhatsappWebjsGatewayService', () => {
  let service: WhatsappWebjsGatewayService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    service = TestBed.inject(WhatsappWebjsGatewayService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('loadSessionStatus – GET /session', () => {
    let result: WhatsappSessionStatus | undefined;
    service.loadSessionStatus().subscribe(r => (result = r));
    httpMock.expectOne(`${BASE}/session`).flush(mockStatus);
    expect(result).toEqual(mockStatus);
  });

  it('connectSession – POST /session/connect', () => {
    let result: WhatsappSessionStatus | undefined;
    service.connectSession().subscribe(r => (result = r));
    const req = httpMock.expectOne(`${BASE}/session/connect`);
    expect(req.request.method).toBe('POST');
    req.flush(mockStatus);
    expect(result).toEqual(mockStatus);
  });

  it('disconnectSession – POST /session/disconnect', () => {
    let result: WhatsappSessionStatus | undefined;
    service.disconnectSession().subscribe(r => (result = r));
    const req = httpMock.expectOne(`${BASE}/session/disconnect`);
    expect(req.request.method).toBe('POST');
    req.flush(mockStatus);
    expect(result).toEqual(mockStatus);
  });

  it('loadInstances – extracts instances array', () => {
    let result: WhatsappInstance[] | undefined;
    service.loadInstances().subscribe(r => (result = r));
    httpMock.expectOne(`${BASE}/instances`).flush({ instances: [mockInstance] });
    expect(result).toEqual([mockInstance]);
  });

  it('loadContacts – sends instanceName param', () => {
    let result: WhatsappContact[] | undefined;
    service.loadContacts('inst').subscribe(r => (result = r));
    const req = httpMock.expectOne(r => r.url === `${BASE}/contacts` && r.params.get('instanceName') === 'inst');
    req.flush({ instanceName: 'inst', contacts: [mockContact] });
    expect(result).toEqual([mockContact]);
  });

  it('loadContactPhoto – uses URL-encoded JID and extracts photoUrl', () => {
    const jid = '5511@s.whatsapp.net';
    let result: string | null | undefined;
    service.loadContactPhoto(jid).subscribe(r => (result = r));
    const encoded = encodeURIComponent(jid);
    httpMock.expectOne(`${BASE}/contacts/${encoded}/photo`).flush({ jid, photoUrl: 'http://photo.url' });
    expect(result).toBe('http://photo.url');
  });

  it('loadContactPhoto – returns null when photoUrl is null', () => {
    const jid = '5511@s.whatsapp.net';
    let result: string | null | undefined;
    service.loadContactPhoto(jid).subscribe(r => (result = r));
    const encoded = encodeURIComponent(jid);
    httpMock.expectOne(`${BASE}/contacts/${encoded}/photo`).flush({ jid, photoUrl: null });
    expect(result).toBeNull();
  });

  it('loadEvents – sends instanceName and limit=120', () => {
    let result: WhatsappEvent[] | undefined;
    service.loadEvents('inst').subscribe(r => (result = r));
    const req = httpMock.expectOne(r =>
      r.url === `${BASE}/events` &&
      r.params.get('instanceName') === 'inst' &&
      r.params.get('limit') === '120'
    );
    req.flush({ instanceName: 'inst', events: [mockEvent] });
    expect(result).toEqual([mockEvent]);
  });

  it('loadChatMessages – encodes JID and sends params', () => {
    const jid = '5511@s.whatsapp.net';
    let result: WhatsappEvent[] | undefined;
    service.loadChatMessages('inst', jid, 50).subscribe(r => (result = r));
    const encoded = encodeURIComponent(jid);
    const req = httpMock.expectOne(r =>
      r.url === `${BASE}/chats/${encoded}/messages` &&
      r.params.get('limit') === '50'
    );
    req.flush({ instanceName: 'inst', events: [mockEvent] });
    expect(result).toEqual([mockEvent]);
  });

  it('loadChatMessages deep=true – sends deep=1 param', () => {
    const jid = '5511@s.whatsapp.net';
    service.loadChatMessages('inst', jid, 50, true).subscribe();
    const encoded = encodeURIComponent(jid);
    const req = httpMock.expectOne(r =>
      r.url === `${BASE}/chats/${encoded}/messages` &&
      r.params.get('deep') === '1'
    );
    req.flush({ instanceName: 'inst', events: [] });
  });

  it('sendMessage – POSTs correct body', () => {
    let result: unknown;
    service.sendMessage('inst', '5511', 'Olá').subscribe(r => (result = r));
    const req = httpMock.expectOne(`${BASE}/messages`);
    expect(req.request.body).toEqual({ instanceName: 'inst', to: '5511', text: 'Olá' });
    req.flush({ instanceName: 'inst', result: 'sent' });
    expect(result).toBe('sent');
  });

  it('sendMedia – POSTs FormData to messages/media', () => {
    const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
    service.sendMedia('inst', '5511', file, 'caption').subscribe();
    const req = httpMock.expectOne(`${BASE}/messages/media`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body instanceof FormData).toBe(true);
    req.flush({ instanceName: 'inst', result: 'ok' });
  });
});
