import { ElementRef, NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';

import { ComposerComponent } from './composer.component';

describe('ComposerComponent', () => {
  let fixture: ComponentFixture<ComposerComponent>;
  let component: ComposerComponent;

  afterEach(() => {
    document.documentElement.style.removeProperty('--uniq-whatsapp-composer-clearance');
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ComposerComponent],
      imports: [FormsModule],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(ComposerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  describe('onTextChange', () => {
    it('updates draftText and emits draftTextChange', () => {
      const emitted: string[] = [];
      component.draftTextChange.subscribe(v => emitted.push(v));
      component.onTextChange('hello');
      expect(component.draftText).toBe('hello');
      expect(emitted).toEqual(['hello']);
    });
  });

  describe('onPaste', () => {
    it('does nothing when disabled', () => {
      component.disabled = true;
      const event = { clipboardData: { items: [] } } as unknown as ClipboardEvent;
      expect(() => component.onPaste(event)).not.toThrow();
    });

    it('does nothing when isSending', () => {
      component.isSending = true;
      const event = { clipboardData: { items: [] } } as unknown as ClipboardEvent;
      expect(() => component.onPaste(event)).not.toThrow();
    });
  });

  describe('setAttachmentFromDataUrl', () => {
    it('creates a File from valid data URL', () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      component.setAttachmentFromDataUrl(dataUrl, 'test.png');
      expect(component.selectedFile).toBeTruthy();
      expect(component.selectedFile!.name).toBe('test.png');
      expect(component.filePreviewUrl).toBe(dataUrl);
    });

    it('focuses the textarea after applying a data URL attachment', () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      spyOn(component, 'focus');

      component.setAttachmentFromDataUrl(dataUrl, 'test.png');

      expect(component.focus).toHaveBeenCalled();
    });

    it('does not throw on malformed data URL (no comma)', () => {
      expect(() => component.setAttachmentFromDataUrl('invalidstring', 'x.jpg')).not.toThrow();
      expect(component.selectedFile).toBeNull();
    });
  });

  describe('onFileSelected', () => {
    it('focuses the textarea after selecting an image file', () => {
      const file = new File(['data'], 'img.jpg', { type: 'image/jpeg' });
      spyOn(component, 'focus');

      component.onFileSelected({ target: { files: [file] } } as unknown as Event);

      expect(component.selectedFile).toBe(file);
      expect(component.focus).toHaveBeenCalled();
    });
  });

  describe('applyAiSuggestion', () => {
    it('fills the draft and emits acceptance when a suggestion is available', () => {
      const accepted: string[] = [];
      const drafts: string[] = [];
      component.aiEnabled = true;
      component.aiSuggestion = 'Mensagem sugerida';
      component.acceptAiSuggestion.subscribe(value => accepted.push(value));
      component.draftTextChange.subscribe(value => drafts.push(value));

      component.applyAiSuggestion();

      expect(component.draftText).toBe('Mensagem sugerida');
      expect(accepted).toEqual(['Mensagem sugerida']);
      expect(drafts).toContain('Mensagem sugerida');
    });
  });

  describe('guided AI', () => {
    it('closes the guided instruction panel with Escape and restores focus to the composer', fakeAsync(() => {
      const textarea = document.createElement('textarea');
      component.aiEnabled = true;
      component.isGuidedAiOpen = true;
      component.guidedAiInstruction = 'responda curto';
      component.textarea = { nativeElement: textarea } as ElementRef<HTMLTextAreaElement>;
      spyOn(textarea, 'focus');

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      spyOn(event, 'preventDefault');
      spyOn(event, 'stopPropagation');

      component.onGuidedAiKeydown(event);
      tick();

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
      expect(component.isGuidedAiOpen).toBeFalse();
      expect(component.guidedAiInstruction).toBe('');
      expect(textarea.focus).toHaveBeenCalled();
    }));

    it('submits the guided instruction with Ctrl+Enter', () => {
      component.aiEnabled = true;
      component.guidedAiInstruction = 'responda curto';
      spyOn(component, 'submitGuidedAi');

      const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true });
      spyOn(event, 'preventDefault');

      component.onGuidedAiKeydown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(component.submitGuidedAi).toHaveBeenCalled();
    });

    it('returns focus to the main composer after submitting the guided instruction', fakeAsync(() => {
      const requested: string[] = [];
      const textarea = document.createElement('textarea');
      component.aiEnabled = true;
      component.isGuidedAiOpen = true;
      component.guidedAiInstruction = 'responda curto';
      component.textarea = { nativeElement: textarea } as ElementRef<HTMLTextAreaElement>;
      spyOn(textarea, 'focus');
      component.requestGuidedAiSuggestion.subscribe(value => requested.push(value));

      component.submitGuidedAi();
      tick();

      expect(requested).toEqual(['responda curto']);
      expect(component.isGuidedAiOpen).toBeFalse();
      expect(textarea.focus).toHaveBeenCalled();
    }));

    it('shows the Ctrl+Enter shortcut on the guided generate button', () => {
      component.aiEnabled = true;
      component.isGuidedAiOpen = true;
      fixture.detectChanges();

      const button: HTMLButtonElement | null = fixture.nativeElement.querySelector('.composer__guide-button--primary');
      expect(button?.textContent).toContain('Ctrl+Enter');
    });

    it('shows the Escape shortcut on the guided cancel button', () => {
      component.aiEnabled = true;
      component.isGuidedAiOpen = true;
      fixture.detectChanges();

      const button: HTMLButtonElement | null = fixture.nativeElement.querySelector('.composer__guide-button--secondary');
      expect(button?.textContent).toContain('Esc');
    });
  });

  describe('submitAiFeedback', () => {
    it('emits the rating when a suggestion is available', () => {
      const ratings: Array<'up' | 'down'> = [];
      component.aiEnabled = true;
      component.aiSuggestion = 'Mensagem sugerida';
      component.rateAiSuggestion.subscribe(value => ratings.push(value));

      component.submitAiFeedback('up');

      expect(component.suggestionFeedback).toBe('up');
      expect(ratings).toEqual(['up']);
    });
  });

  describe('textareaPlaceholder', () => {
    it('hides the placeholder when an AI suggestion is ready', () => {
      component.aiEnabled = true;
      component.aiSuggestion = 'Mensagem sugerida';

      expect(component.textareaPlaceholder).toBe('');
    });

    it('keeps the default placeholder when there is no AI suggestion', () => {
      expect(component.textareaPlaceholder).toBe('Digite uma mensagem');
    });
  });

  describe('textareaSizerContent', () => {
    it('uses the AI suggestion to size the field when the ghost text is visible', () => {
      component.aiEnabled = true;
      component.aiSuggestion = 'Perfeito! Vou ver os modelos do 36 e já te mando. 😊';

      expect(component.textareaSizerContent).toContain('Perfeito! Vou ver os modelos do 36 e já te mando. 😊');
    });

    it('uses the draft text to size the field when the operator is typing', () => {
      component.draftText = 'Mensagem escrita manualmente';

      expect(component.textareaSizerContent).toContain('Mensagem escrita manualmente');
    });
  });

  describe('popover coordination', () => {
    it('closes the other popovers when opening quick replies', () => {
      component.isEmojiPickerOpen = true;
      component.isAttachMenuOpen = true;

      component.toggleQuickReplyMenu();

      expect(component.isQuickReplyMenuOpen).toBeTrue();
      expect(component.isEmojiPickerOpen).toBeFalse();
      expect(component.isAttachMenuOpen).toBeFalse();
    });

    it('closes the other popovers when opening the emoji picker', () => {
      component.isQuickReplyMenuOpen = true;
      component.isAttachMenuOpen = true;

      component.toggleEmojiPicker();

      expect(component.isEmojiPickerOpen).toBeTrue();
      expect(component.isQuickReplyMenuOpen).toBeFalse();
      expect(component.isAttachMenuOpen).toBeFalse();
    });

    it('closes the emoji and attach popovers on outside click', () => {
      component.isEmojiPickerOpen = true;
      component.isAttachMenuOpen = true;

      component.onDocumentClick({
        target: document.body,
        composedPath: () => [document.body]
      } as unknown as MouseEvent);

      expect(component.isEmojiPickerOpen).toBeFalse();
      expect(component.isAttachMenuOpen).toBeFalse();
    });

    it('keeps the popovers open when clicking inside a composer popover root', () => {
      const root = document.createElement('div');
      root.setAttribute('data-composer-popover-root', '');

      component.isEmojiPickerOpen = true;
      component.isAttachMenuOpen = true;

      component.onDocumentClick({
        target: root,
        composedPath: () => [root]
      } as unknown as MouseEvent);

      expect(component.isEmojiPickerOpen).toBeTrue();
      expect(component.isAttachMenuOpen).toBeTrue();
    });
  });

  describe('onDocumentKeydown', () => {
    it('accepts the suggestion when Tab is pressed with focus on the AI button', () => {
      const aiButton = document.createElement('button');
      component.aiEnabled = true;
      component.aiSuggestion = 'Mensagem sugerida';
      component.aiButton = { nativeElement: aiButton } as ElementRef<HTMLButtonElement>;
      spyOn(component, 'applyAiSuggestion');
      spyOnProperty(document, 'activeElement', 'get').and.returnValue(aiButton);

      const event = new KeyboardEvent('keydown', { key: 'Tab' });
      spyOn(event, 'preventDefault');

      component.onDocumentKeydown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(component.applyAiSuggestion).toHaveBeenCalled();
    });
  });

  describe('isAttachMenuOpen', () => {
    it('starts as false', () => {
      expect(component.isAttachMenuOpen).toBeFalse();
    });
  });

  it('renders the quick reply button in the full-width popover anchor group', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.composer__control-group--quick-reply')).toBeTruthy();
  });

  it('renders the attach button before the quick reply button', () => {
    fixture.detectChanges();

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.composer__row button[aria-label]')) as HTMLButtonElement[];
    const labels = buttons.slice(0, 3).map(button => button.getAttribute('aria-label'));

    expect(labels).toEqual(['Emojis', 'Anexar arquivo', 'Mensagens rápidas']);
  });

  it('grows the textarea up to eight lines and updates the bulk panel clearance', () => {
    const textarea = fixture.nativeElement.querySelector('.composer__textarea') as HTMLTextAreaElement;
    spyOn(window, 'requestAnimationFrame').and.callFake((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    spyOn(window, 'getComputedStyle').and.returnValue({
      lineHeight: '20px',
      paddingTop: '12px',
      paddingBottom: '12px',
      borderTopWidth: '0px',
      borderBottomWidth: '0px',
      minHeight: '46px'
    } as CSSStyleDeclaration);
    spyOnProperty(window, 'innerHeight', 'get').and.returnValue(1000);
    spyOn(fixture.nativeElement, 'getBoundingClientRect').and.returnValue({
      top: 700,
      height: 120
    } as DOMRect);
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => 260
    });

    component.onTextChange(Array.from({ length: 12 }, (_, index) => `Linha ${index + 1}`).join('\n'));

    expect(textarea.style.height).toBe('184px');
    expect(textarea.style.overflowY).toBe('auto');
    expect(document.documentElement.style.getPropertyValue('--uniq-whatsapp-composer-clearance')).toBe('320px');
  });
});
