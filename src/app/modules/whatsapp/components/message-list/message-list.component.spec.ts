import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { WhatsappMessage } from '../../../../models/whatsapp.model';
import { MessageListComponent } from './message-list.component';

const makeMsg = (overrides: Partial<WhatsappMessage> = {}): WhatsappMessage => ({
  id: 'msg-1',
  contactJid: 'a@c.us',
  text: 'Olá',
  sentAt: new Date().toISOString(),
  isFromMe: false,
  source: 'test',
  payload: {},
  ...overrides
});

describe('MessageListComponent', () => {
  let fixture: ComponentFixture<MessageListComponent>;
  let component: MessageListComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [MessageListComponent],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(MessageListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('trackById returns message id', () => {
    const msg = makeMsg({ id: 'xyz' });
    expect(component.trackById(0, msg)).toBe('xyz');
  });

  describe('media detection via viewMessages', () => {
    it('no media for plain text message', () => {
      component.messages = [makeMsg({ payload: { hasMedia: false } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media).toBeNull();
    });

    it('has media when hasMedia is true', () => {
      component.messages = [makeMsg({ payload: { hasMedia: true, mediaMimetype: 'image/jpeg' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media).not.toBeNull();
    });

    it('has media when mediaMimetype is non-empty', () => {
      component.messages = [makeMsg({ payload: { mediaMimetype: 'application/pdf' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media).not.toBeNull();
    });

    it('has media when mediaDataUrl is present', () => {
      component.messages = [makeMsg({ payload: { mediaDataUrl: 'data:image/jpeg;base64,abc' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media).not.toBeNull();
    });
  });

  describe('image detection via viewMessages', () => {
    it('kind is document for PDF', () => {
      component.messages = [makeMsg({ payload: { hasMedia: true, mediaMimetype: 'application/pdf' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media?.kind).toBe('document');
    });

    it('kind is image for image with dataUrl', () => {
      component.messages = [makeMsg({ payload: { hasMedia: true, mediaMimetype: 'image/jpeg', mediaDataUrl: 'data:image/jpeg;base64,abc' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media?.kind).toBe('image');
    });
  });

  describe('media label via viewMessages', () => {
    it('returns null media for non-media', () => {
      component.messages = [makeMsg()];
      component.ngOnChanges();
      expect(component.viewMessages[0].media).toBeNull();
    });

    it('label is Imagem for image', () => {
      component.messages = [makeMsg({ payload: { hasMedia: true, mediaMimetype: 'image/jpeg', mediaDataUrl: 'data:image/jpeg;base64,x' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media?.label).toBe('Imagem');
    });

    it('label is Audio for audio', () => {
      component.messages = [makeMsg({ payload: { hasMedia: true, mediaMimetype: 'audio/ogg', type: 'audio' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media?.label).toBe('Audio');
    });

    it('label is Documento for unknown media', () => {
      component.messages = [makeMsg({ payload: { hasMedia: true, mediaMimetype: 'application/pdf' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media?.label).toBe('Documento');
    });
  });

  describe('media filename via viewMessages', () => {
    it('returns default label when no filename', () => {
      component.messages = [makeMsg({ payload: { hasMedia: true, mediaMimetype: 'application/pdf' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media?.filename).toBe('Arquivo anexado');
    });

    it('returns actual filename when set', () => {
      component.messages = [makeMsg({ payload: { hasMedia: true, mediaMimetype: 'application/pdf', mediaFilename: 'doc.pdf' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].media?.filename).toBe('doc.pdf');
    });
  });

  describe('message text via viewMessages', () => {
    it('returns empty text for media messages whose text is a data URL', () => {
      component.messages = [makeMsg({
        text: 'data:image/jpeg;base64,abc',
        payload: { hasMedia: true, mediaMimetype: 'image/jpeg', mediaDataUrl: 'data:image/jpeg;base64,abc' }
      })];
      component.ngOnChanges();
      expect(component.viewMessages[0].text).toBe('');
    });

    it('returns empty for raw JPEG base64 text', () => {
      component.messages = [makeMsg({
        text: '/9j/' + 'A'.repeat(320),
        payload: { hasMedia: true, mediaMimetype: 'image/jpeg' }
      })];
      component.ngOnChanges();
      expect(component.viewMessages[0].text).toBe('');
    });

    it('returns original text for regular text messages', () => {
      component.messages = [makeMsg({ text: 'Olá com legenda', payload: { hasMedia: true, mediaMimetype: 'image/jpeg' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].text).toBe('Olá com legenda');
    });

    it('returns a placeholder for location messages without text', () => {
      component.messages = [makeMsg({ text: '', payload: { type: 'location' } })];
      component.ngOnChanges();
      expect(component.viewMessages[0].text).toBe('Localização');
    });
  });

  it('converts raw mediaDataUrl base64 into image preview URL', () => {
    const rawJpegBase64 = '/9j/' + 'A'.repeat(320);
    component.messages = [makeMsg({
      payload: {
        hasMedia: true,
        mediaMimetype: 'image/jpeg',
        mediaDataUrl: rawJpegBase64
      }
    })];
    component.ngOnChanges();
    const media = component.viewMessages[0].media;
    expect(media?.kind).toBe('image');
    expect(media?.previewUrl).toContain('data:image/jpeg;base64,/9j/');
  });

  it('precomputes the rendered messages list when the input changes', () => {
    component.messages = [makeMsg({ id: 'msg-1' }), makeMsg({ id: 'msg-2', isFromMe: true })];
    component.ngOnChanges();
    expect(component.viewMessages.length).toBe(2);
    expect(component.viewMessages[1].ackIcon).toBe('done');
  });

  it('does not force scroll to bottom when a message is deleted from the same conversation', () => {
    const scrollElement = { scrollTop: 0, scrollHeight: 500 };
    component.scrollContainer = {
      nativeElement: scrollElement
    } as any;

    component.messages = [
      makeMsg({ id: 'msg-1', contactJid: 'a@c.us' }),
      makeMsg({ id: 'msg-2', contactJid: 'a@c.us' })
    ];
    component.ngOnChanges();
    component.ngAfterViewChecked();

    scrollElement.scrollTop = 123;
    scrollElement.scrollHeight = 420;
    component.messages = [makeMsg({ id: 'msg-2', contactJid: 'a@c.us' })];

    component.ngOnChanges();
    component.ngAfterViewChecked();

    expect(scrollElement.scrollTop).toBe(123);
  });

  it('scrolls to bottom when switching to another conversation', () => {
    const scrollElement = { scrollTop: 0, scrollHeight: 500 };
    component.scrollContainer = {
      nativeElement: scrollElement
    } as any;

    component.messages = [
      makeMsg({ id: 'msg-1', contactJid: 'a@c.us' }),
      makeMsg({ id: 'msg-2', contactJid: 'a@c.us' })
    ];
    component.ngOnChanges();
    component.ngAfterViewChecked();

    scrollElement.scrollTop = 25;
    scrollElement.scrollHeight = 760;
    component.messages = [makeMsg({ id: 'msg-3', contactJid: 'b@c.us' })];

    component.ngOnChanges();
    component.ngAfterViewChecked();

    expect(scrollElement.scrollTop).toBe(760);
  });

  it('keeps the list pinned to the footer when media finishes loading', () => {
    const scrollElement = { scrollTop: 0, scrollHeight: 500, clientHeight: 100 };
    component.scrollContainer = {
      nativeElement: scrollElement
    } as any;

    component.messages = [makeMsg({ id: 'msg-1', contactJid: 'a@c.us' })];
    component.ngOnChanges();
    component.ngAfterViewChecked();

    scrollElement.scrollHeight = 640;
    component.onMediaLoad();

    expect(scrollElement.scrollTop).toBe(640);
  });

  it('does not jump back to the footer on media load after the user scrolls up', () => {
    const scrollElement = { scrollTop: 0, scrollHeight: 500, clientHeight: 100 };
    component.scrollContainer = {
      nativeElement: scrollElement
    } as any;

    component.messages = [makeMsg({ id: 'msg-1', contactJid: 'a@c.us' })];
    component.ngOnChanges();
    component.ngAfterViewChecked();

    scrollElement.scrollTop = 120;
    component.onScroll();

    scrollElement.scrollHeight = 640;
    component.onMediaLoad();

    expect(scrollElement.scrollTop).toBe(120);
  });
});
