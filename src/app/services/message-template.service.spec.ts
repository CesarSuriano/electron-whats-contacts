import { TestBed } from '@angular/core/testing';
import { MessageTemplateService } from './message-template.service';
import { Cliente } from '../models/cliente.model';

function makeCliente(nome = 'Carlos'): Cliente {
  return { id: 1, nome, cpf: '', telefone: '', dataCadastro: '', dataNascimento: '', birthdayStatus: 'none' };
}

describe('MessageTemplateService', () => {
  let service: MessageTemplateService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(MessageTemplateService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('getTemplates returns defaults when nothing saved', () => {
    const t = service.getTemplates();
    expect(t.birthday).toBeTruthy();
    expect(t.review).toBeTruthy();
  });

  it('saveTemplate persists the template text', () => {
    service.saveTemplate('birthday', 'Parabéns {nome}!');
    const t = service.getTemplates();
    expect(t.birthday).toBe('Parabéns {nome}!');
  });

  it('renderTemplate replaces {nome} with client name', () => {
    service.saveTemplate('birthday', 'Feliz aniversário {nome}!');
    const result = service.renderTemplate('birthday', makeCliente('Maria'));
    expect(result).toContain('Maria');
    expect(result).not.toContain('{nome}');
  });

  it('saveTemplateImage stores and retrieves image data URL', () => {
    const dataUrl = 'data:image/png;base64,abc123';
    service.saveTemplateImage('birthday', dataUrl);
    expect(service.getTemplateImage('birthday')).toBe(dataUrl);
  });

  it('saveTemplateImage with undefined removes the image', () => {
    service.saveTemplateImage('birthday', 'data:image/png;base64,abc');
    service.saveTemplateImage('birthday', undefined);
    expect(service.getTemplateImage('birthday')).toBeUndefined();
  });

  it('getTemplateImage returns undefined when no image saved', () => {
    expect(service.getTemplateImage('review')).toBeUndefined();
  });

  it('registerEmojiUsage affects getQuickAccessEmojis order', () => {
    const defaults = ['😊', '👍', '🎉'];
    const all = ['😊', '👍', '🎉', '❤️'];
    service.registerEmojiUsage('❤️');
    service.registerEmojiUsage('❤️');
    const quick = service.getQuickAccessEmojis(defaults, all, 4);
    expect(quick[0]).toBe('❤️');
  });

  it('getAllEmojis includes custom emojis', () => {
    service.saveCustomEmoji('🦊');
    const all = service.getAllEmojis(['😊']);
    expect(all).toContain('🦊');
  });

  it('saveCustomEmoji trims whitespace', () => {
    service.saveCustomEmoji('  🐶  ');
    expect(service.getAllEmojis([])).toContain('🐶');
  });

  it('saveCustomEmoji ignores empty strings', () => {
    const before = service.getAllEmojis([]).length;
    service.saveCustomEmoji('   ');
    expect(service.getAllEmojis([]).length).toBe(before);
  });
});
