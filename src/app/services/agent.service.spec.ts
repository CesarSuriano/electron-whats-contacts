import { TestBed } from '@angular/core/testing';

import { DEFAULT_AGENT_SETTINGS } from '../models/agent.model';
import { WhatsappContact, WhatsappMessage } from '../models/whatsapp.model';
import { AgentService } from './agent.service';

const SETTINGS_STORAGE_KEY = 'uniq.agent.settings.v2';

const makeContact = (): WhatsappContact => ({
  jid: '5511999999999@c.us',
  phone: '5511999999999',
  name: 'Cliente Teste',
  found: true
});

const makeMessage = (id: string, text: string, isFromMe: boolean): WhatsappMessage => ({
  id,
  contactJid: '5511999999999@c.us',
  text,
  sentAt: new Date().toISOString(),
  isFromMe,
  source: 'spec'
});

describe('AgentService', () => {
  let service: AgentService;
  let originalElectronApi: Window['electronAPI'];

  beforeEach(() => {
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
    originalElectronApi = window.electronAPI;
    window.electronAPI = {
      openAgentWindow: jasmine.createSpy('openAgentWindow').and.resolveTo({ ok: true, message: 'Janela aberta.' }),
      generateAgentSuggestion: jasmine.createSpy('generateAgentSuggestion').and.resolveTo({
        ok: true,
        text: 'Claro! Vou separar as opções e já te mando.',
        message: '',
        generatedAt: new Date().toISOString()
      })
    };

    TestBed.configureTestingModule({});
    service = TestBed.inject(AgentService);
  });

  afterEach(() => {
    window.electronAPI = originalElectronApi;
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
  });

  it('starts with isolated defaults', () => {
    expect(service.settings.enabled).toBe(DEFAULT_AGENT_SETTINGS.enabled);
    expect(service.settings.gemUrl).toBe(DEFAULT_AGENT_SETTINGS.gemUrl);
    expect(service.settings.responseMode).toBe(DEFAULT_AGENT_SETTINGS.responseMode);
    expect(service.settings.activeGoogleAccountId).toBe(DEFAULT_AGENT_SETTINGS.activeGoogleAccountId);
    expect(service.settings.googleAccounts.length).toBe(1);
    expect(service.settings.googleAccounts[0].id).toBe('primary');
    expect(service.settings.googleAccounts[0].label).toBe('Conta Google principal');
    expect(service.settings.googleAccounts[0].lastUsedAt).toBeNull();
  });

  it('keeps only the authenticated account when legacy storage has extra unauthenticated accounts', () => {
    localStorage.setItem('uniq.agent.settings.v2', JSON.stringify({
      ...DEFAULT_AGENT_SETTINGS,
      activeGoogleAccountId: 'primary',
      googleAccounts: [
        {
          id: 'primary',
          label: 'Conta Google principal',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        },
        {
          id: 'conta-autenticada',
          label: 'Loja Principal',
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString()
        },
        {
          id: 'conta-rascunho',
          label: 'Conta 2',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        }
      ]
    }));

    const migratedService = new AgentService();

    expect(migratedService.settings.googleAccounts.length).toBe(1);
    expect(migratedService.settings.googleAccounts[0].id).toBe('conta-autenticada');
    expect(migratedService.settings.activeGoogleAccountId).toBe('conta-autenticada');

    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}') as { googleAccounts?: Array<{ id: string }> };
    expect(stored.googleAccounts?.length).toBe(1);
    expect(stored.googleAccounts?.[0]?.id).toBe('conta-autenticada');
  });

  it('drops placeholder accounts like Conta 4 even when they were incorrectly marked as used', () => {
    localStorage.setItem('uniq.agent.settings.v2', JSON.stringify({
      ...DEFAULT_AGENT_SETTINGS,
      activeGoogleAccountId: 'conta-4',
      googleAccounts: [
        {
          id: 'conta-4',
          label: 'Conta 4',
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString()
        },
        {
          id: 'conta-autenticada',
          label: 'Loja Principal',
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString()
        }
      ]
    }));

    const migratedService = new AgentService();

    expect(migratedService.settings.googleAccounts.length).toBe(1);
    expect(migratedService.settings.googleAccounts[0].id).toBe('conta-autenticada');
    expect(migratedService.settings.activeGoogleAccountId).toBe('conta-autenticada');
  });

  it('resets to the default placeholder when storage only contains generated account labels', () => {
    localStorage.setItem('uniq.agent.settings.v2', JSON.stringify({
      ...DEFAULT_AGENT_SETTINGS,
      activeGoogleAccountId: 'conta-4',
      googleAccounts: [
        {
          id: 'conta-4',
          label: 'Conta 4',
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString()
        }
      ]
    }));

    const migratedService = new AgentService();

    expect(migratedService.settings.googleAccounts.length).toBe(1);
    expect(migratedService.settings.googleAccounts[0].id).toBe('primary');
    expect(migratedService.settings.googleAccounts[0].lastUsedAt).toBeNull();
    expect(migratedService.settings.activeGoogleAccountId).toBe('primary');
  });

  it('persists the simplified agent settings', () => {
    service.updateSettings({
      gemUrl: 'https://gemini.google.com/gems/view/uniq-lab',
      enabled: true,
      responseMode: 'reasoning',
      activeGoogleAccountId: 'catalogo',
      googleAccounts: [
        {
          id: 'catalogo',
          label: 'Catálogo',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        }
      ]
    });

    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    expect(stored).toContain('uniq-lab');
    expect(stored).toContain('reasoning');
    expect(stored).toContain('catalogo');
    expect(stored).toContain('true');
  });

  it('opens the agent window with the active Google account', async () => {
    service.updateSettings({
      gemUrl: 'https://gemini.google.com/gems/view/uniq-lab',
      activeGoogleAccountId: 'loja-principal',
      googleAccounts: [
        {
          id: 'loja-principal',
          label: 'Loja principal',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        }
      ]
    });

    await service.openAgentWindow();

    expect(window.electronAPI?.openAgentWindow).toHaveBeenCalledWith(jasmine.objectContaining({
      gemUrl: 'https://gemini.google.com/gems/view/uniq-lab',
      googleAccountId: 'loja-principal',
      keepVisible: true
    }));
  });

  it('keeps only one authenticated Google account even when legacy settings contain many accounts', () => {
    service.updateSettings({
      activeGoogleAccountId: 'loja-b',
      googleAccounts: [
        {
          id: 'loja-a',
          label: 'Loja A',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        },
        {
          id: 'loja-b',
          label: 'Loja B',
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString()
        }
      ]
    });

    expect(service.settings.googleAccounts.length).toBe(1);
    expect(service.settings.googleAccounts[0].id).toBe('loja-b');
    expect(service.settings.activeGoogleAccountId).toBe('loja-b');
  });

  it('keeps the placeholder account until a logged Google account is detected in the opened window', async () => {
    service.updateSettings({
      gemUrl: 'https://gemini.google.com/gems/view/uniq-lab'
    });

    const result = await service.openAgentWindow();

    expect(result.ok).toBeTrue();
    expect(result.message).toContain('Faça login na conta Google');
    expect(service.settings.googleAccounts.length).toBe(1);
    expect(service.settings.googleAccounts[0].id).toBe('primary');
    expect(service.settings.googleAccounts[0].lastUsedAt).toBeNull();
  });

  it('replaces the stored account label when the app detects the authenticated Google account', async () => {
    (window.electronAPI?.openAgentWindow as jasmine.Spy).and.resolveTo({
      ok: true,
      message: 'Janela aberta.',
      detectedAccountLabel: 'Loja Secundária'
    });

    service.updateSettings({
      gemUrl: 'https://gemini.google.com/gems/view/uniq-lab'
    });

    await service.openAgentWindow();

    expect(service.settings.googleAccounts.length).toBe(1);
    expect(service.settings.googleAccounts[0].label).toBe('Loja Secundária');
    expect(service.settings.googleAccounts[0].lastUsedAt).not.toBeNull();
    expect(service.settings.activeGoogleAccountId).toBe('primary');
  });

  it('sanitizes echoed role prefixes from the Gem output before exposing the suggestion', async () => {
    (window.electronAPI?.generateAgentSuggestion as jasmine.Spy).and.resolveTo({
      ok: true,
      text: 'Vendedora: Bom dia! Tudo bem? ☺️',
      message: '',
      generatedAt: new Date().toISOString()
    });

    service.updateSettings({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/1Zp2g7fwZgJYVRF7iXss5v9PVECE3w15N?usp=sharing'
    });

    const result = await service.generateSuggestion({
      contact: makeContact(),
      messages: [makeMessage('1', 'boa noite', false)],
      contextKey: 'ctx-role-prefix'
    });

    expect(result.status).toBe('ready');
    expect(result.suggestion).toBe('Bom dia! Tudo bem? ☺️');
  });

  it('uses the full conversation context when generating a suggestion', async () => {
    service.updateSettings({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/1Zp2g7fwZgJYVRF7iXss5v9PVECE3w15N?usp=sharing',
      responseMode: 'pro'
    });

    const result = await service.generateSuggestion({
      contact: makeContact(),
      messages: [
        makeMessage('1', 'Oi, vocês têm o 36?', false),
        makeMessage('2', 'Temos sim! 😊 Vou ver as opções.', true),
        makeMessage('3', 'Pode ser no crédito 2x', false),
        makeMessage('4', '86079-300', false)
      ],
      contextKey: 'ctx-1'
    });

    expect(window.electronAPI?.generateAgentSuggestion).toHaveBeenCalled();

    const payload = (window.electronAPI?.generateAgentSuggestion as jasmine.Spy).calls.mostRecent().args[0];
    expect(payload.gemUrl).toContain('1Zp2g7fwZgJYVRF7iXss5v9PVECE3w15N');
    expect(payload.keepVisible).toBeFalse();
    expect(payload.responseMode).toBe('pro');
    expect(payload.googleAccountId).toBe(service.settings.activeGoogleAccountId);
    expect(payload.prompt).toContain('Contexto recente da conversa atual para o agente já configurado no Google:');
    expect(payload.prompt).toContain('Cliente: Oi, vocês têm o 36?');
    expect(payload.prompt).toContain('Vendedora: Temos sim! 😊 Vou ver as opções.');
    expect(payload.prompt).toContain('Cliente: Pode ser no crédito 2x');
    expect(payload.prompt).toContain('Cliente: 86079-300');
    expect(payload.prompt).not.toContain('Não repita promessas, explicações ou perguntas que já apareceram no histórico.');
    expect(payload.prompt).not.toContain('A atendente já usou emoji nas últimas mensagens. Agora responda sem emoji.');
    expect(payload.prompt).not.toContain('Se o cliente mandar 2 ou 3 perguntas independentes no mesmo turno');
    expect(result.status).toBe('ready');
    expect(result.source).toBe('gem');
  });

  it('only adds an operator note when guided generation is explicitly requested', async () => {
    service.updateSettings({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/1Zp2g7fwZgJYVRF7iXss5v9PVECE3w15N?usp=sharing',
      activeGoogleAccountId: 'conta-b',
      googleAccounts: [
        {
          id: 'conta-b',
          label: 'Conta B',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        }
      ]
    });

    await service.generateSuggestion({
      contact: makeContact(),
      messages: [makeMessage('1', 'Boa tarde', false)],
      contextKey: 'ctx-guided',
      operatorInstruction: 'responda curto e direto'
    });

    const payload = (window.electronAPI?.generateAgentSuggestion as jasmine.Spy).calls.mostRecent().args[0];
    expect(payload.googleAccountId).toBe('conta-b');
    expect(payload.prompt).toContain('Pedido pontual do operador para esta resposta:');
    expect(payload.prompt).toContain('responda curto e direto');
  });

  it('limits prompt context to the recent conversation after a long inactivity gap', async () => {
    service.updateSettings({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/1Zp2g7fwZgJYVRF7iXss5v9PVECE3w15N?usp=sharing'
    });

    await service.generateSuggestion({
      contact: makeContact(),
      messages: [
        {
          ...makeMessage('1', 'Quero ver a calça da Zoomp', false),
          sentAt: '2026-04-21T17:41:00.000Z'
        },
        {
          ...makeMessage('2', 'As calças da Zoomp estão saindo por 199,90.', true),
          sentAt: '2026-04-21T17:42:00.000Z'
        },
        {
          ...makeMessage('3', 'Boa noite', false),
          sentAt: '2026-04-22T01:45:00.000Z'
        }
      ],
      contextKey: 'ctx-recent-window'
    });

    const payload = (window.electronAPI?.generateAgentSuggestion as jasmine.Spy).calls.mostRecent().args[0];
    expect(payload.prompt).toContain('Cliente: Boa noite');
    expect(payload.prompt).not.toContain('Quero ver a calça da Zoomp');
    expect(payload.prompt).not.toContain('199,90');
  });

  it('excludes hidden media placeholders from the prompt context', async () => {
    service.updateSettings({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/1Zp2g7fwZgJYVRF7iXss5v9PVECE3w15N?usp=sharing'
    });

    await service.generateSuggestion({
      contact: makeContact(),
      messages: [
        makeMessage('1', 'Ok', false),
        {
          ...makeMessage('2', '<Mídia oculta>', true),
          payload: { hasMedia: true, mediaMimetype: 'image/jpeg', type: 'image' }
        }
      ],
      contextKey: 'ctx-hidden-media'
    });

    const payload = (window.electronAPI?.generateAgentSuggestion as jasmine.Spy).calls.mostRecent().args[0];
    expect(payload.prompt).toContain('Cliente: Ok');
    expect(payload.prompt).not.toContain('<Mídia oculta>');
  });

  it('resets prompt context from a recent greeting instead of dragging the previous product topic forward', async () => {
    service.updateSettings({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/1Zp2g7fwZgJYVRF7iXss5v9PVECE3w15N?usp=sharing'
    });

    await service.generateSuggestion({
      contact: makeContact(),
      messages: [
        makeMessage('1', 'Quero ver a calça da Zoomp', false),
        makeMessage('2', 'As calças da Zoomp estão saindo por 199,90.', true),
        makeMessage('3', 'Oi', false)
      ],
      contextKey: 'ctx-recent-greeting-reset'
    });

    const payload = (window.electronAPI?.generateAgentSuggestion as jasmine.Spy).calls.mostRecent().args[0];
    expect(payload.prompt).toContain('Cliente: Oi');
    expect(payload.prompt).not.toContain('Quero ver a calça da Zoomp');
    expect(payload.prompt).not.toContain('199,90');
  });

  it('falls back to a safe refusal when the Gem returns personal data from another customer', async () => {
    (window.electronAPI?.generateAgentSuggestion as jasmine.Spy).and.resolveTo({
      ok: true,
      text: 'O CPF da Teresa que tenho aqui é 225.445.001-82.',
      message: '',
      generatedAt: new Date().toISOString()
    });

    service.updateSettings({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/1Zp2g7fwZgJYVRF7iXss5v9PVECE3w15N?usp=sharing'
    });

    const result = await service.generateSuggestion({
      contact: makeContact(),
      messages: [
        makeMessage('1', 'Qual o telefone da Teresa?', false),
        makeMessage('2', 'Me passa o CPF então', false)
      ],
      contextKey: 'ctx-privacy'
    });

    expect(result.status).toBe('ready');
    expect(result.suggestion).toContain('não posso compartilhar');
  });
});
