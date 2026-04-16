import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { WhatsappGatewayService } from './whatsapp-gateway.service';
import { WhatsappContact, WhatsappEvent, WhatsappInstance, WhatsappLabel } from '../models/whatsapp.model';

const BASE = 'http://localhost:3333/api/whatsapp';

const mockInstance: WhatsappInstance = { name: 'inst1', token: 'tok', connected: true, jid: 'jid1', webhook: '' };
const mockContact: WhatsappContact = { jid: '5511@s.whatsapp.net', phone: '5511', name: 'Test', found: true };
const mockEvent: WhatsappEvent = { id: 'e1', source: 'src', receivedAt: '2024-01-01', isFromMe: false, chatJid: 'jid', phone: '11', text: 'hi', payload: {} };
const mockLabel: WhatsappLabel = { id: 'l1', name: 'VIP' };

describe('WhatsappGatewayService', () => {
  let service: WhatsappGatewayService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    service = TestBed.inject(WhatsappGatewayService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('loadInstances – extracts instances array', () => {
    let result: WhatsappInstance[] | undefined;
    service.loadInstances().subscribe(r => (result = r));
    httpMock.expectOne(`${BASE}/instances`).flush({ instances: [mockInstance] });
    expect(result).toEqual([mockInstance]);
  });

  it('loadContacts – sends instanceName param and extracts contacts', () => {
    let result: WhatsappContact[] | undefined;
    service.loadContacts('inst1').subscribe(r => (result = r));
    const req = httpMock.expectOne(r => r.url === `${BASE}/contacts` && r.params.get('instanceName') === 'inst1');
    req.flush({ instanceName: 'inst1', contacts: [mockContact] });
    expect(result).toEqual([mockContact]);
  });

  it('loadEvents – sends instanceName and limit=120', () => {
    let result: WhatsappEvent[] | undefined;
    service.loadEvents('inst1').subscribe(r => (result = r));
    const req = httpMock.expectOne(r =>
      r.url === `${BASE}/events` &&
      r.params.get('instanceName') === 'inst1' &&
      r.params.get('limit') === '120'
    );
    req.flush({ instanceName: 'inst1', events: [mockEvent] });
    expect(result).toEqual([mockEvent]);
  });

  it('sendMessage – posts body and returns result', () => {
    let result: unknown;
    service.sendMessage('inst1', '5511', 'Olá').subscribe(r => (result = r));
    const req = httpMock.expectOne(`${BASE}/messages`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ instanceName: 'inst1', to: '5511', text: 'Olá' });
    req.flush({ instanceName: 'inst1', result: { ok: true } });
    expect((result as any)['ok']).toBe(true);
  });

  it('loadLabels – sends instanceName and extracts labels', () => {
    let result: WhatsappLabel[] | undefined;
    service.loadLabels('inst1').subscribe(r => (result = r));
    const req = httpMock.expectOne(r => r.url === `${BASE}/labels` && r.params.get('instanceName') === 'inst1');
    req.flush({ instanceName: 'inst1', labels: [mockLabel] });
    expect(result).toEqual([mockLabel]);
  });

  it('createLabel – posts and extracts labels', () => {
    let result: WhatsappLabel[] | undefined;
    service.createLabel('inst1', 'Novo').subscribe(r => (result = r));
    const req = httpMock.expectOne(`${BASE}/labels`);
    expect(req.request.method).toBe('POST');
    req.flush({ instanceName: 'inst1', labels: [mockLabel] });
    expect(result).toEqual([mockLabel]);
  });

  it('applyLabel – posts to labels/apply and maps to void', () => {
    let called = false;
    service.applyLabel('inst1', 'jid1', 'l1').subscribe(() => (called = true));
    const req = httpMock.expectOne(`${BASE}/labels/apply`);
    expect(req.request.body).toEqual({ instanceName: 'inst1', jid: 'jid1', labelId: 'l1' });
    req.flush({});
    expect(called).toBe(true);
  });

  it('removeLabel – posts to labels/remove and maps to void', () => {
    let called = false;
    service.removeLabel('inst1', 'jid1', 'l1').subscribe(() => (called = true));
    const req = httpMock.expectOne(`${BASE}/labels/remove`);
    expect(req.request.body).toEqual({ instanceName: 'inst1', jid: 'jid1', labelId: 'l1' });
    req.flush({});
    expect(called).toBe(true);
  });
});
