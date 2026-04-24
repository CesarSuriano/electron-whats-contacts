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

  describe('isMediaMessage', () => {
    it('returns false for plain text message', () => {
      expect(component.isMediaMessage(makeMsg({ payload: { hasMedia: false } }))).toBeFalse();
    });

    it('returns true when hasMedia is true', () => {
      expect(component.isMediaMessage(makeMsg({ payload: { hasMedia: true, mediaMimetype: 'image/jpeg' } }))).toBeTrue();
    });

    it('returns true when mediaMimetype is non-empty', () => {
      expect(component.isMediaMessage(makeMsg({ payload: { mediaMimetype: 'application/pdf' } }))).toBeTrue();
    });

    it('returns true when mediaDataUrl is present', () => {
      expect(component.isMediaMessage(makeMsg({ payload: { mediaDataUrl: 'data:image/jpeg;base64,abc' } }))).toBeTrue();
    });
  });

  describe('isImageMessage', () => {
    it('returns false for non-image media', () => {
      const msg = makeMsg({ payload: { hasMedia: true, mediaMimetype: 'application/pdf' } });
      expect(component.isImageMessage(msg)).toBeFalse();
    });

    it('returns true for image with dataUrl', () => {
      const msg = makeMsg({ payload: { hasMedia: true, mediaMimetype: 'image/jpeg', mediaDataUrl: 'data:image/jpeg;base64,abc' } });
      expect(component.isImageMessage(msg)).toBeTrue();
    });
  });

  describe('mediaLabel', () => {
    it('returns empty for non-media', () => {
      expect(component.mediaLabel(makeMsg())).toBe('');
    });

    it('returns Imagem for image', () => {
      const msg = makeMsg({ payload: { hasMedia: true, mediaMimetype: 'image/jpeg', mediaDataUrl: 'data:image/jpeg;base64,x' } });
      expect(component.mediaLabel(msg)).toBe('Imagem');
    });

    it('returns Audio for audio', () => {
      const msg = makeMsg({ payload: { hasMedia: true, mediaMimetype: 'audio/ogg', type: 'audio' } });
      expect(component.mediaLabel(msg)).toBe('Audio');
    });

    it('returns Documento for unknown media', () => {
      const msg = makeMsg({ payload: { hasMedia: true, mediaMimetype: 'application/pdf' } });
      expect(component.mediaLabel(msg)).toBe('Documento');
    });
  });

  describe('mediaFilename', () => {
    it('returns default label when no filename', () => {
      const msg = makeMsg({ payload: { hasMedia: true, mediaMimetype: 'application/pdf' } });
      expect(component.mediaFilename(msg)).toBe('Arquivo anexado');
    });

    it('returns actual filename when set', () => {
      const msg = makeMsg({ payload: { hasMedia: true, mediaMimetype: 'application/pdf', mediaFilename: 'doc.pdf' } });
      expect(component.mediaFilename(msg)).toBe('doc.pdf');
    });
  });

  describe('messageText', () => {
    it('returns empty for media messages whose text is a data URL', () => {
      const msg = makeMsg({
        text: 'data:image/jpeg;base64,abc',
        payload: { hasMedia: true, mediaMimetype: 'image/jpeg', mediaDataUrl: 'data:image/jpeg;base64,abc' }
      });

      expect(component.messageText(msg)).toBe('');
    });

    it('returns empty for raw JPEG base64 text', () => {
      const msg = makeMsg({
        text: '/9j/' + 'A'.repeat(320),
        payload: { hasMedia: true, mediaMimetype: 'image/jpeg' }
      });

      expect(component.messageText(msg)).toBe('');
    });

    it('returns original text for regular text messages', () => {
      const msg = makeMsg({ text: 'Olá com legenda', payload: { hasMedia: true, mediaMimetype: 'image/jpeg' } });

      expect(component.messageText(msg)).toBe('Olá com legenda');
    });

    it('returns a placeholder for location messages without text', () => {
      const msg = makeMsg({
        text: '',
        payload: { type: 'location' }
      });

      expect(component.messageText(msg)).toBe('Localização');
    });
  });

  it('converts raw mediaDataUrl base64 into image preview URL', () => {
    const rawJpegBase64 = '/9j/' + 'A'.repeat(320);
    const msg = makeMsg({
      payload: {
        hasMedia: true,
        mediaMimetype: 'image/jpeg',
        mediaDataUrl: rawJpegBase64
      }
    });

    expect(component.isImageMessage(msg)).toBeTrue();
    expect(component.imagePreviewUrl(msg)).toContain('data:image/jpeg;base64,/9j/');
  });
});
